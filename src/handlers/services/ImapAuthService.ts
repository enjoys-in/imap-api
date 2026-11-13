import { __CONFIG__ } from "@/app/config";
import utils from "@/utils";
import { MiscellaneousHelper } from "@/utils/helpers/misc";
import { Security } from "@/utils/helpers/security";
import type { ImapRequestBody } from "@/utils/interfaces/imap.interface";
import { REDIS_KEY_NAME } from "@/utils/interfaces/redisName.interface";
import { AppRoles } from "@/utils/interfaces/user.interface";
import { Cache } from "@/utils/services/redis/cacheService";
import type { Request, Response } from "express";
import { imapCache } from "../cache/ImapCacheService";
import { ImapFactory } from "../factory/ImapFactory";
import { enrichMailboxList } from "../helpers/email.helper";
import { sendError, sendSuccess } from "../helpers/response.helper";
import { getAuthenticatedImapService } from "../helpers/session.helper";
import imapBaseService from "./imapBaseService";

const securityService = new Security();

export class ImapAuthService {
	/**
	 * Logs in an existing user using IMAP credentials.
	 */
	async loginUser(
		req: Request<
			{},
			{},
			Pick<ImapRequestBody, "imap_username" | "imap_password">
		>,
		res: Response,
	) {
		try {
			const username = req.body.imap_username;
			const domain = MiscellaneousHelper.getOnlyDomainFromEmail(username);

			// Check domain restriction if Redis is enabled
			try {
				if (await Cache.cache.sIsMember(REDIS_KEY_NAME.ALL_DOMAINS, domain)) {
					throw new Error(
						"This Domain is not configured to use IMAP. Please Contact Admin",
					);
				}
			} catch (cacheErr) {
				// Continue if Redis is unavailable
				if (
					cacheErr instanceof Error &&
					cacheErr.message.includes("configured")
				) {
					throw cacheErr;
				}
			}

			const isUser = await imapBaseService.getUserEmail(username);
			if (!isUser) {
				return sendError(res, "Not Authenticated", "Not Authenticated", 401);
			}

			const config = imapBaseService.configDTO(isUser) as ImapRequestBody;
			const userMailboxes = await imapBaseService.loginUser(config);

			const signJWT = utils.signJWT(
				{
					display_name: isUser.display_name,
					mid: isUser.id,
					email: username,
					domain_name: domain,
					role: AppRoles.USER,
				},
				`${isUser.id}`,
				"60d",
			);

			res.cookie("access_token", signJWT, {
				httpOnly: true,
				secure: __CONFIG__.APP.APP_ENV === "PROD",
				sameSite: __CONFIG__.APP.APP_ENV === "PROD" ? "none" : "strict",
				maxAge: 60 * 24 * 60 * 60 * 1000,
				expires: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
			});

			const enrichedMailboxes = enrichMailboxList(
				userMailboxes,
				`acc-${isUser.id}`,
			);

			// Cache folder list with 30s TTL
			imapCache.setMailboxes(username, enrichedMailboxes, 30);

			return sendSuccess(res, userMailboxes, "Authenticated", {
				user: {
					mid: isUser.id,
					email: username,
					display_name: isUser.display_name,
					domain_name: domain,
					role: AppRoles.USER,
				},
				mailboxes: enrichedMailboxes,
				token: signJWT,
			});
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Validates and provisions a new user connection.
	 */
	async validateNewUser(req: Request<{}, {}, ImapRequestBody>, res: Response) {
		try {
			const skipSMTP = req.query?.skipSMTP;
			const isUser = await imapBaseService.getUserEmail(req.body.imap_username);
			if (isUser) {
				return sendSuccess(
					res,
					null,
					"Invalid Operation , Please Do Login",
					{},
					200,
				);
			}

			const user = req.body.uses_same_credentials
				? req.body.imap_username
				: req.body.smtp_username;
			const pass = req.body.uses_same_credentials
				? req.body.imap_password
				: req.body.smtp_password;

			const config: ImapRequestBody = {
				...req.body,
				smtp_password: pass,
				smtp_username: user,
			};

			config.imap_password = securityService
				.EncryptDecryptData(config.imap_password, __CONFIG__.SECRETS.APP_SECRET)
				.DecryptFromString();
			config.smtp_password = securityService
				.EncryptDecryptData(config.smtp_password, __CONFIG__.SECRETS.APP_SECRET)
				.DecryptFromString();

			const { imap_configured, smtp_configured, data } =
				await imapBaseService.setupUser(config, skipSMTP as string | undefined);

			const createdUser = await imapBaseService.insertIntoDb({
				...config,
				imap_configured,
				smtp_configured,
			});

			const domain = MiscellaneousHelper.getOnlyDomainFromEmail(
				req.body.imap_username,
			);
			const signJWT = utils.signJWT(
				{
					mid: createdUser.id,
					email: req.body.imap_username,
					domain_name: domain,
					role: AppRoles.USER,
				},
				`${createdUser.id}`,
				"60d",
			);

			res.cookie("access_token", signJWT, {
				httpOnly: true,
				secure: __CONFIG__.APP.APP_ENV === "PROD",
				sameSite: __CONFIG__.APP.APP_ENV === "PROD" ? "none" : "strict",
				maxAge: 60 * 24 * 60 * 60 * 1000,
				expires: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
			});

			return sendSuccess(res, data, "Authenticated");
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Re-validates existing user connection.
	 */
	async reLogin(req: Request, res: Response) {
		try {
			const isUser = await imapBaseService.getUserEmail(
				req.user?.email as string,
			);
			if (!isUser) {
				return sendError(res, "Not Authenticated", "Not Authenticated", 401);
			}

			const config = imapBaseService.configDTO(isUser) as ImapRequestBody;
			const data = await imapBaseService.loginUser(config);

			return sendSuccess(res, data, "Authenticated");
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Logs out user, clears token cookie, and cleans up active connections.
	 */
	async userLogout(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			if (userEmail) {
				ImapFactory.removeInstance(userEmail);
				imapCache.invalidateUser(userEmail);
			}

			res.clearCookie("access_token");
			return sendSuccess(res, null, "OK");
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Returns user profile along with synchronized mailbox list.
	 * Utilizes memory-safe TTL cache to minimize expensive IMAP LIST/STATUS roundtrips.
	 */
	async userProfile(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			if (!userEmail) {
				throw new Error("Login required");
			}

			const userMid = req.user?.uid || (req.user as any)?.mid;
			const accountId = userMid ? `acc-${userMid}` : "acc-1";

			// Check TTL cache first (30s TTL)
			let enrichedMailboxes = imapCache.getMailboxes(userEmail);

			if (!enrichedMailboxes) {
				const imapService = await getAuthenticatedImapService(userEmail);
				const rawMailboxes = (await imapService.syncFolders()) || [];
				enrichedMailboxes = enrichMailboxList(rawMailboxes, accountId);
				imapCache.setMailboxes(userEmail, enrichedMailboxes, 30);
			}

			return sendSuccess(
				res,
				{
					...req.user,
					mailboxes: enrichedMailboxes,
				},
				"OK",
				{
					user: req.user,
					mailboxes: enrichedMailboxes,
				},
			);
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Returns list of configured accounts.
	 */
	async listAccounts(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const user = await imapBaseService.getUserEmail(userEmail);
			if (!user) {
				throw new Error("User not found");
			}

			const account = {
				id: `acc-${user.id}`,
				displayName: user.display_name || user.imap_username,
				email: user.imap_username,
				userName: user.imap_username,
				accountType:
					user.imap_host?.includes("outlook") ||
					user.imap_host?.includes("office365")
						? "Microsoft 365"
						: user.imap_host?.includes("gmail")
							? "Google"
							: "IMAP",
				imapHost: user.imap_host,
				imapPort: user.imap_port,
				imapSecurity: user.imap_secure ? "SslOnConnect" : "None",
				smtpHost: user.smtp_host,
				smtpPort: user.smtp_port,
				smtpSecurity: user.smtp_secure ? "SslOnConnect" : "StartTls",
				isDefault: true,
				requiresSignIn: false,
			};

			return sendSuccess(res, [account], "OK", { accounts: [account] });
		} catch (error) {
			return sendError(res, error);
		}
	}
}

export const imapAuthService = new ImapAuthService();
