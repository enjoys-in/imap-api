import { __CONFIG__ } from "@/app/config";
import utils from "@/utils";
import { MiscellaneousHelper } from "@/utils/helpers/misc";
import { Security } from "@/utils/helpers/security";
import type { ImapRequestBody } from "@/utils/interfaces/imap.interface";
import { REDIS_KEY_NAME } from "@/utils/interfaces/redisName.interface";
import { AppRoles } from "@/utils/interfaces/user.interface";
import { Cache } from "@/utils/services/redis/cacheService";
import type { Request, Response } from "express";
import { createTransport } from "nodemailer";
import { imapCache } from "../cache/ImapCacheService";
import { ImapFactory } from "../factory/ImapFactory";
import { autodiscoverConfig } from "../helpers/autodiscover.helper";
import { enrichEmailList, enrichMailboxList } from "../helpers/email.helper";
import { sendError, sendSuccess } from "../helpers/response.helper";
import { getAuthenticatedImapService } from "../helpers/session.helper";
import imapBaseService from "./imapBaseService";

const securityService = new Security();

function safeDecryptPassword(rawPassword?: string): string {
	if (!rawPassword) return "";
	try {
		const decrypted = securityService
			.EncryptDecryptData(rawPassword, __CONFIG__.SECRETS.APP_SECRET)
			.DecryptFromString();
		return decrypted || rawPassword;
	} catch {
		return rawPassword;
	}
}

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
			await imapCache.setMailboxes(username, enrichedMailboxes, 30);

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
	 * If ?stream=true query is provided, delegates to setupStream for real-time progress logging.
	 */
	async validateNewUser(req: Request<{}, {}, ImapRequestBody>, res: Response) {
		if (
			req.query?.stream === "true" ||
			req.headers.accept?.includes("text/event-stream")
		) {
			return this.setupStream(req, res);
		}

		try {
			const skipSMTP = req.query?.skipSMTP;
			let isUser = await imapBaseService.getUserEmail(req.body.imap_username);

			const user = req.body.uses_same_credentials
				? req.body.imap_username
				: req.body.smtp_username;
			const pass = req.body.uses_same_credentials
				? req.body.imap_password
				: req.body.smtp_password;

			const imapPass = safeDecryptPassword(req.body.imap_password);
			const smtpPass = safeDecryptPassword(pass);

			const config: ImapRequestBody = {
				...req.body,
				imap_password: imapPass,
				smtp_password: smtpPass,
				smtp_username: user || req.body.imap_username,
			};

			const { imap_configured, smtp_configured, data } =
				await imapBaseService.setupUser(config, skipSMTP as string | undefined);

			if (!isUser) {
				isUser = await imapBaseService.insertIntoDb({
					...config,
					imap_configured,
					smtp_configured,
				});
			}

			const domain = MiscellaneousHelper.getOnlyDomainFromEmail(
				req.body.imap_username,
			);
			const signJWT = utils.signJWT(
				{
					mid: isUser.id,
					email: req.body.imap_username,
					display_name:
						isUser.display_name || req.body.imap_username.split("@")[0],
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

			const enrichedMailboxes = enrichMailboxList(data, `acc-${isUser.id}`);
			await imapCache.setMailboxes(config.imap_username, enrichedMailboxes, 30);

			return sendSuccess(res, data, "Authenticated", {
				user: {
					mid: isUser.id,
					email: req.body.imap_username,
					display_name:
						isUser.display_name || req.body.imap_username.split("@")[0],
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
	 * Real-time Server-Sent Events stream for first-time account setup.
	 * Progressively executes and emits live logs:
	 *   - [init] Configuration validation
	 *   - [imap_connect] IMAP TLS handshake & authentication
	 *   - [smtp_verify] Outbound SMTP transport verification
	 *   - [mailbox_sync] Mailbox hierarchy discovery & folder synchronization
	 *   - [email_fetch] First-time email pre-fetch (warming INBOX cache)
	 *   - [provision_account] Provisioning account and generating session token
	 *   - [complete] Success payload with user, token, and mailboxes
	 */
	async setupStream(req: Request<{}, {}, ImapRequestBody>, res: Response) {
		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");
		res.flushHeaders?.();

		const sendLog = (
			step: string,
			status: "running" | "success" | "warning" | "error",
			message: string,
			progress: number,
			extra?: Record<string, any>,
		) => {
			if (!res.writableEnded) {
				const payload = {
					step,
					status,
					message,
					progress,
					timestamp: new Date().toISOString(),
					...extra,
				};
				res.write(`data: ${JSON.stringify(payload)}\n\n`);
			}
		};

		try {
			sendLog("init", "running", "Validating configuration parameters...", 5);

			const user = req.body.uses_same_credentials
				? req.body.imap_username
				: req.body.smtp_username;
			const pass = req.body.uses_same_credentials
				? req.body.imap_password
				: req.body.smtp_password;

			const imapPass = safeDecryptPassword(req.body.imap_password);
			const smtpPass = safeDecryptPassword(pass);

			const config: ImapRequestBody = {
				...req.body,
				imap_password: imapPass,
				smtp_username: user || req.body.imap_username,
				smtp_password: smtpPass,
			};

			if (!config.imap_host || !config.imap_username || !config.imap_password) {
				sendLog(
					"init",
					"error",
					"Missing required IMAP connection parameters.",
					5,
				);
				res.end();
				return;
			}

			// ── Stage 1: Authenticate IMAP Connection ──
			sendLog(
				"imap_connect",
				"running",
				`Connecting to IMAP server ${config.imap_host}:${config.imap_port} (SSL: ${Boolean(config.imap_secure)})...`,
				15,
			);

			const imap = ImapFactory.getOrCreate(config.imap_username, config);
			try {
				const isAuth = await imap.getConnection().authenticated;
				if (!isAuth) {
					await imap.authenticate();
				}
				sendLog(
					"imap_connect",
					"success",
					`IMAP connection authenticated successfully for ${config.imap_username}!`,
					30,
				);
			} catch (imapErr: any) {
				sendLog(
					"imap_connect",
					"error",
					`IMAP authentication failed: ${imapErr.message || imapErr}`,
					30,
				);
				res.end();
				return;
			}

			// ── Stage 2: Verifying Outbound SMTP Transport ──
			sendLog(
				"smtp_verify",
				"running",
				`Verifying SMTP outbound server ${config.smtp_host}:${config.smtp_port}...`,
				45,
			);

			let smtpConfigured = false;
			const skipSMTP = req.query?.skipSMTP === "1";
			if (!skipSMTP && config.smtp_host) {
				try {
					const transport = createTransport({
						host: config.smtp_host,
						port: Number(config.smtp_port) || 587,
						secure: Boolean(config.smtp_secure),
						auth: {
							user: config.smtp_username,
							pass: config.smtp_password,
						},
						connectionTimeout: 10000,
					});
					const verified = await transport.verify();
					if (verified) {
						smtpConfigured = true;
						sendLog(
							"smtp_verify",
							"success",
							`SMTP handshake verified successfully on ${config.smtp_host}:${config.smtp_port}!`,
							60,
						);
					} else {
						sendLog(
							"smtp_verify",
							"warning",
							"SMTP server responded without full handshake. Continuing with IMAP...",
							60,
						);
					}
				} catch (smtpErr: any) {
					if (skipSMTP) {
						sendLog(
							"smtp_verify",
							"warning",
							`SMTP check skipped with notice: ${smtpErr.message}`,
							60,
						);
					} else {
						sendLog(
							"smtp_verify",
							"error",
							`SMTP handshake failed: ${smtpErr.message}`,
							60,
						);
						res.end();
						return;
					}
				}
			} else {
				sendLog(
					"smtp_verify",
					"warning",
					"SMTP check skipped as requested.",
					60,
				);
			}

			// ── Stage 3: Discovering Mailbox Hierarchy & Folder Synchronization ──
			sendLog(
				"mailbox_sync",
				"running",
				"Discovering mailbox folders and synchronizing counts...",
				70,
			);

			const rawMailboxes = await imap.syncFolders();
			let isUser = await imapBaseService.getUserEmail(config.imap_username);
			const userMid = isUser?.id || 1;
			const enrichedMailboxes = enrichMailboxList(
				rawMailboxes,
				`acc-${userMid}`,
			);
			await imapCache.setMailboxes(config.imap_username, enrichedMailboxes, 30);

			sendLog(
				"mailbox_sync",
				"success",
				`Discovered ${enrichedMailboxes.length} mailbox folders (${enrichedMailboxes.map((f: any) => f.displayName).join(", ")})`,
				80,
				{ mailboxes: enrichedMailboxes },
			);

			// ── Stage 4: First-time Email Cache Pre-Fetch ──
			sendLog(
				"email_fetch",
				"running",
				"Pre-fetching initial messages for INBOX...",
				85,
			);

			let initialCount = 0;
			try {
				const inboxData = await imap.selectMailbox("INBOX", 1);
				const enrichedEmails = enrichEmailList(
					inboxData.emails || [],
					"INBOX",
					`acc-${userMid}`,
				);
				initialCount = enrichedEmails.length;
				sendLog(
					"email_fetch",
					"success",
					`Pre-fetched ${initialCount} initial messages for INBOX`,
					92,
					{ initialEmailCount: initialCount },
				);
			} catch (fetchErr: any) {
				sendLog(
					"email_fetch",
					"warning",
					`Initial email pre-fetch notice: ${fetchErr.message}. Messages will load on first view.`,
					92,
				);
			}

			// ── Stage 5: Provisioning Account & Session Token ──
			sendLog(
				"provision_account",
				"running",
				"Provisioning account in database and generating session token...",
				95,
			);

			if (!isUser) {
				isUser = await imapBaseService.insertIntoDb({
					...config,
					imap_configured: true,
					smtp_configured: smtpConfigured,
				});
			}

			const domain = MiscellaneousHelper.getOnlyDomainFromEmail(
				config.imap_username,
			);
			const signJWT = utils.signJWT(
				{
					mid: isUser.id,
					email: config.imap_username,
					display_name:
						config.display_name || config.imap_username.split("@")[0],
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

			sendLog(
				"complete",
				"success",
				"Account setup complete! Welcome to AirSend.",
				100,
				{
					user: {
						mid: isUser.id,
						email: config.imap_username,
						display_name:
							config.display_name || config.imap_username.split("@")[0],
						domain_name: domain,
					},
					token: signJWT,
					mailboxes: enrichedMailboxes,
				},
			);
			res.end();
		} catch (error: any) {
			sendLog("error", "error", `Setup error: ${error.message || error}`, 100);
			res.end();
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
				await imapCache.invalidateUser(userEmail);
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
			let enrichedMailboxes = await imapCache.getMailboxes(userEmail);

			if (!enrichedMailboxes) {
				const imapService = await getAuthenticatedImapService(userEmail);
				const rawMailboxes = (await imapService.syncFolders()) || [];
				enrichedMailboxes = enrichMailboxList(rawMailboxes, accountId);
				await imapCache.setMailboxes(userEmail, enrichedMailboxes, 30);
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

	/**
	 * Autodiscovers IMAP and SMTP configurations using Thunderbird XML Autoconfig,
	 * Outlook Autodiscover XML, and DNS MX records.
	 */
	async autodiscover(req: Request, res: Response): Promise<void> {
		try {
			let email = (req.query?.email ||
				req.query?.emailaddress ||
				req.body?.email ||
				req.body?.imap_username) as string;

			if (!email && typeof req.body === "string") {
				const match = req.body.match(/<EMailAddress>([^<]+)<\/EMailAddress>/i);
				if (match) email = match[1]?.trim();
			}

			if (!email) {
				return sendError(res, "Email address is required", undefined, 400);
			}

			const result = await autodiscoverConfig(email);

			const wantsXml =
				req.path.endsWith(".xml") ||
				req.query?.format === "xml" ||
				(Boolean(req.headers.accept?.includes("xml")) &&
					!req.headers.accept?.includes("json"));

			if (wantsXml) {
				const isOutlook =
					req.path.toLowerCase().includes("autodiscover") ||
					Boolean(
						req.body &&
							typeof req.body === "string" &&
							req.body.includes("schemas.microsoft.com"),
					);

				if (isOutlook) {
					res.setHeader("Content-Type", "application/xml; charset=utf-8");
					res.send(`<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
    <User>
      <DisplayName>${result.displayName || result.email}</DisplayName>
      <EMailAddress>${result.email}</EMailAddress>
    </User>
    <Account>
      <AccountType>email</AccountType>
      <Action>settings</Action>
      <Protocol>
        <Type>IMAP</Type>
        <Server>${result.imap.host}</Server>
        <Port>${result.imap.port}</Port>
        <DomainRequired>off</DomainRequired>
        <LoginName>${result.imap.username}</LoginName>
        <SPA>off</SPA>
        <SSL>${result.imap.secure ? "on" : "off"}</SSL>
        <AuthRequired>on</AuthRequired>
      </Protocol>
      <Protocol>
        <Type>SMTP</Type>
        <Server>${result.smtp.host}</Server>
        <Port>${result.smtp.port}</Port>
        <DomainRequired>off</DomainRequired>
        <LoginName>${result.smtp.username}</LoginName>
        <SPA>off</SPA>
        <SSL>${result.smtp.secure ? "on" : "off"}</SSL>
        <AuthRequired>on</AuthRequired>
      </Protocol>
    </Account>
  </Response>
</Autodiscover>`);
					return;
				}

				res.setHeader("Content-Type", "application/xml; charset=utf-8");
				res.send(`<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="${result.domain}">
    <domain>${result.domain}</domain>
    <displayName>${result.displayName || result.domain}</displayName>
    <displayShortName>${result.domain}</displayShortName>
    <incomingServer type="imap">
      <hostname>${result.imap.host}</hostname>
      <port>${result.imap.port}</port>
      <socketType>${result.imap.secure ? "SSL" : "STARTTLS"}</socketType>
      <authentication>password-cleartext</authentication>
      <username>${result.imap.username}</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>${result.smtp.host}</hostname>
      <port>${result.smtp.port}</port>
      <socketType>${result.smtp.secure ? "SSL" : "STARTTLS"}</socketType>
      <authentication>password-cleartext</authentication>
      <username>${result.smtp.username}</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>`);
				return;
			}

			return sendSuccess(res, result, "Autodiscovery successful", {
				data: result,
				...result,
			});
		} catch (error) {
			return sendError(res, error, "Autodiscovery failed");
		}
	}
}

export const imapAuthService = new ImapAuthService();
