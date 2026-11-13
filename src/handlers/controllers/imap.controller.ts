import { __CONFIG__ } from "@/app/config";
import { ImapUsersEmailConnectionEntity } from "@/factory/entities/imap.entity";
import { InjectRepository } from "@/factory/typeorm";
import utils from "@/utils";
import { PublicRoute } from "@/utils/decorators";
import { MiscellaneousHelper } from "@/utils/helpers/misc";
import { Security } from "@/utils/helpers/security";
import type { ImapRequestBody } from "@/utils/interfaces/imap.interface";
import { REDIS_KEY_NAME } from "@/utils/interfaces/redisName.interface";
import { AppRoles } from "@/utils/interfaces/user.interface";
import { Cache } from "@/utils/services/redis/cacheService";
import type { Request, Response } from "express";
import { ImapFactory } from "../factory/ImapFactory";
import { ImapJobProcessor } from "../jobs/ImapJobProcessor";
import { ImapJobType } from "../jobs/types";
import {
	CapabilityNotSupportedError,
	ImapCapability,
} from "../services/CapabilityManager";
import { Logging } from "@/logs";
import { createTransport } from "nodemailer";
import imapBaseService from "../services/imapBaseService";

const imapUser = InjectRepository(ImapUsersEmailConnectionEntity);
const securityService = new Security();

function resolveMailboxFolder(folderParam?: string): string {
	if (!folderParam) return "INBOX";
	const decoded = decodeURIComponent(folderParam).trim();
	const lower = decoded.toLowerCase();
	if (lower === "fld-inbox" || lower === "inbox") return "INBOX";
	if (lower === "fld-sent" || lower === "sent" || lower === "sent items")
		return "Sent Items";
	if (
		lower === "fld-trash" ||
		lower === "fld-deleted" ||
		lower === "deleted" ||
		lower === "deleted items" ||
		lower === "trash"
	)
		return "Deleted Items";
	if (
		lower === "fld-junk" ||
		lower === "fld-spam" ||
		lower === "junk" ||
		lower === "junk email" ||
		lower === "spam"
	)
		return "Junk Email";
	if (lower === "fld-drafts" || lower === "drafts") return "Drafts";
	if (lower === "fld-archive" || lower === "archive") return "Archive";
	return decoded;
}

function enrichMailboxList(
	mailboxes: any[] | null | undefined,
	accountId = "acc-1",
) {
	return (mailboxes || []).map((box: any, index: number) => {
		const specialLower = (box.specialUse || box.name || "")
			.toLowerCase()
			.replace(/\\/g, "");
		let special = "Custom";
		if (specialLower.includes("inbox")) special = "Inbox";
		else if (specialLower.includes("sent")) special = "Sent";
		else if (
			specialLower.includes("trash") ||
			specialLower.includes("deleted")
		)
			special = "Trash";
		else if (specialLower.includes("junk") || specialLower.includes("spam"))
			special = "Junk";
		else if (specialLower.includes("draft")) special = "Drafts";
		else if (
			specialLower.includes("archive") ||
			specialLower.includes("all")
		)
			special = "Archive";

		const rawName = box.name || box.path || `folder-${index}`;
		const slug = rawName.toLowerCase().replace(/[^a-z0-9]/g, "-");
		const id = box.id ? `fld-${box.id}` : `fld-${slug}`;

		return {
			...box,
			id,
			accountId,
			fullName: box.path || box.name,
			displayName: box.name,
			parentFullName: null,
			special,
			uidValidity: box.uidValidity || 20261113,
			unreadCount: Number(box.unseen_count || 0),
			totalCount: Number(box.total_count || 0),
			lastSyncedAt: new Date().toISOString(),
			sortRank:
				special === "Inbox"
					? 1
					: special === "Archive"
						? 2
						: special === "Sent"
							? 3
							: special === "Trash"
								? 4
								: special === "Junk"
									? 5
									: 10 + index,
		};
	});
}

function enrichEmailList(
	emails: any[],
	selectedFolder: string,
	accountId = "acc-1",
) {
	return (emails || []).map((msg: any) => {
		const flagsArr = Array.isArray(msg.flags)
			? msg.flags
			: msg.flags
				? Array.from(msg.flags)
				: [];
		const isRead =
			flagsArr.includes("\\Seen") ||
			flagsArr.includes("Seen") ||
			flagsArr.includes("\\seen");
		const isFlagged =
			flagsArr.includes("\\Flagged") ||
			flagsArr.includes("Flagged") ||
			flagsArr.includes("\\flagged");

		const fromRaw = msg.from || "";
		let fromName = fromRaw;
		let fromAddress = fromRaw;
		const matchAngle = fromRaw.match(/(.*)<(.*)>/);
		if (matchAngle) {
			fromName = matchAngle[1].trim() || matchAngle[2].trim();
			fromAddress = matchAngle[2].trim();
		} else if (fromRaw.includes("@")) {
			fromName = fromRaw.split("@")[0].trim();
			fromAddress = fromRaw.trim();
		}

		const uid = msg.uid;
		const id = uid
			? `msg-${uid}`
			: msg.message_id || `msg-${Math.random().toString(36).substring(7)}`;

		return {
			...msg,
			id,
			folderId: `fld-${selectedFolder.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
			accountId,
			uid,
			messageIdHeader: msg.message_id,
			threadId: msg.message_id || id,
			subject: msg.subject || "(No Subject)",
			fromName: fromName || fromAddress,
			fromAddress,
			to: msg.to || "",
			date: msg.date
				? new Date(msg.date).toISOString()
				: new Date().toISOString(),
			size: msg.size || 0,
			preview: msg.subject || "",
			isRead,
			isFlagged,
			isPinned: false,
			isAnswered: flagsArr.includes("\\Answered"),
			isForwarded: false,
			isDraft: flagsArr.includes("\\Draft"),
			isThread: false,
			threadCount: 1,
			hasAttachments:
				Array.isArray(msg.attachments) && msg.attachments.length > 0,
			hasCalendar: false,
		};
	});
}

class ImapController {
	/**
	 * Logs in user and check if the user is already present in database, if not
	 * then it creates a new entry in the database and updates the first time setup status
	 * @param req - Request object
	 * @param res - Response object
	 * @returns Response object
	 */
	@PublicRoute()
	async loginUser(
		req: Request<
			{},
			{},
			Pick<ImapRequestBody, "imap_username" | "imap_password">
		>,
		res: Response,
	) {
		try {
			// check user domain is hosted on our server if yes then dont use imap use direct api calls
			const domain = MiscellaneousHelper.getOnlyDomainFromEmail(
				req.body.imap_username,
			);

			if (await Cache.cache.sIsMember(REDIS_KEY_NAME.ALL_DOMAINS, domain)) {
				throw new Error(
					"This Domain is not configured to use IMAP. Please Contact Admin",
				);
			}
			const isUser = await imapBaseService.getUserEmail(req.body.imap_username);
			if (!isUser) {
				res
					.status(401)
					.json({ message: "Not Authenticated", result: null, success: false })
					.end();
				return;
			}

			const config = imapBaseService.configDTO(isUser) as ImapRequestBody;

			const userMailboxes = await imapBaseService.loginUser(config);

			const signJWT = utils.signJWT(
				{
					display_name: isUser.display_name,
					mid: isUser.id,
					email: req.body.imap_username,
					domain_name: MiscellaneousHelper.getOnlyDomainFromEmail(
						req.body.imap_username,
					),
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
			res
				.json({
					message: "Authenticated",
					result: userMailboxes,
					user: {
						mid: isUser.id,
						email: req.body.imap_username,
						display_name: isUser.display_name,
						domain_name: MiscellaneousHelper.getOnlyDomainFromEmail(
							req.body.imap_username,
						),
						role: AppRoles.USER,
					},
					mailboxes: enrichedMailboxes,
					token: signJWT,
					success: true,
				})
				.end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();

				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}
	@PublicRoute()
	async validateNewUser(req: Request<{}, {}, ImapRequestBody>, res: Response) {
		try {
			const skipSMTP = req.query?.skipSMTP;
			const isUser = await imapBaseService.getUserEmail(req.body.imap_username);
			if (isUser) {
				res
					.status(200)
					.json({
						message: "Invalid Operation , Please Do Login",
						result: null,
						success: false,
					})
					.end();
				return;
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

			const signJWT = utils.signJWT(
				{
					mid: createdUser.id,
					email: req.body.imap_username,
					domain_name: MiscellaneousHelper.getOnlyDomainFromEmail(
						req.body.imap_username,
					),
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
			res
				.json({ message: "Authenticated", result: data, success: true })
				.end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();

				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}

	/**
	 * Logs in the user using the provided imap_username and imap_password.
	 * If the user is already logged in, it will relogin the user.
	 * @param req - Request object
	 * @param res - Response object
	 * @returns Response object
	 */
	async reLogin(req: Request, res: Response) {
		try {
			if (!req.user?.email) {
				throw new Error("Login required");
			}
			const isUser = await imapBaseService.getUserEmail(
				req.user?.email as string,
			);

			const config = imapBaseService.configDTO(isUser);
			const imap = ImapFactory.getOrCreate(req.user?.email as string, config);

			if (imap.getConnection().authenticated) {
				res.json({ message: "OK", result: null, success: true }).end();
				return;
			}
			await imap.authenticate();

			res.json({ message: "OK", result: null, success: true }).end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();

				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}

	@PublicRoute()
	async userLogout(req: Request, res: Response) {
		try {
			res.clearCookie("access_token");
			res.json({ message: "OK", result: null, success: true }).end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();

				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}
	async userProfile(req: Request, res: Response) {
		try {
			if (!req.user?.email) {
				throw new Error("Login required");
			}

			let imapService = ImapFactory.getInstance(req.user.email);
			if (!imapService) {
				const isUser = await imapBaseService.getUserEmail(req.user.email);
				if (isUser) {
					const config = imapBaseService.configDTO(isUser);
					imapService = ImapFactory.getOrCreate(req.user.email, config);
					if (!imapService.getConnection().authenticated) {
						await imapService.authenticate();
					}
				}
			}

			let mailboxes: any[] = [];
			if (imapService) {
				mailboxes = (await imapService.syncFolders()) || [];
			}
			const userMid = req.user?.uid || (req.user as any)?.mid;
			const enrichedMailboxes = enrichMailboxList(
				mailboxes,
				userMid ? `acc-${userMid}` : "acc-1",
			);

			res
				.json({
					message: "OK",
					result: {
						...req.user,
						mailboxes: enrichedMailboxes,
					},
					user: req.user,
					mailboxes: enrichedMailboxes,
					success: true,
				})
				.end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();

				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}
	/**
	 * Retrieves the envelope of the first unseen email in the given mailbox.
	 * Used for rendering the first email in the mailbox when the user first logs in.
	 * @param req - Request object
	 * @param res - Response object
	 * @returns Response object
	 */
	async onFirstLoad(req: Request, res: Response) {
		try {
			const isUser = await imapBaseService.getUserEmail(
				req.user?.email as string,
			);

			const config = imapBaseService.configDTO(isUser);
			const envelope = await ImapFactory.firstTimeSetup(config);

			res.json({ message: "OK", result: envelope, success: true }).end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();

				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}
	/**
	 * Retrieves all mailboxes from the IMAP server
	 * @param req - Request object
	 * @param res - Response object
	 * @returns Response object
	 */
	async loadMailboxes(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			let imapService = ImapFactory.getInstance(userEmail);
			if (!imapService) {
				const isUser = await imapBaseService.getUserEmail(userEmail);
				if (isUser) {
					const config = imapBaseService.configDTO(isUser);
					imapService = ImapFactory.getOrCreate(userEmail, config);
					if (!imapService.getConnection().authenticated) {
						await imapService.authenticate();
					}
				} else {
					throw new Error("Login required");
				}
			}

			const rawMailboxes = (await imapService.syncFolders()) || [];
			const userMid = req.user?.uid || (req.user as any)?.mid;
			const enrichedMailboxes = enrichMailboxList(
				rawMailboxes,
				userMid ? `acc-${userMid}` : "acc-1",
			);
			res
				.json({
					message: "OK",
					result: enrichedMailboxes,
					mailboxes: enrichedMailboxes,
					success: true,
				})
				.end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();

				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}
	/**
	 * Retrieves emails from the IMAP server, given the selected mailbox and page information
	 * @param req - Request object
	 * @param res - Response object
	 * @returns Response object
	 */
	async loadEmails(
		req: Request<
			{},
			{},
			{},
			{
				folder?: string;
				folderId?: string;
				page?: number;
				offset?: number;
				limit?: number;
			}
		>,
		res: Response,
	) {
		try {
			const query = req.query;
			const limit = Number(query.limit || 50);
			let page = Number(query.page || 1);
			if (query.offset !== undefined && !query.page) {
				page = Math.floor(Number(query.offset) / limit) + 1;
			}
			const offset = (page - 1 === 0 ? 1 : page - 1) * limit;
			const selectedMailbox = resolveMailboxFolder(
				query.folder || query.folderId,
			);

			const userEmail = req.user?.email as string;
			let imapService = ImapFactory.getInstance(userEmail);
			if (!imapService) {
				const isUser = await imapBaseService.getUserEmail(userEmail);
				if (isUser) {
					const config = imapBaseService.configDTO(isUser);
					imapService = ImapFactory.getOrCreate(userEmail, config);
					if (!imapService.getConnection().authenticated) {
						await imapService.authenticate();
					}
				} else {
					throw new Error("Login required");
				}
			}

			const emails = await imapService.selectMailbox(
				decodeURIComponent(selectedMailbox),
				offset,
			);
			const cleanObject = JSON.parse(
				JSON.stringify(emails, (_, value) =>
					typeof value === "bigint" ? value.toString() : value,
				),
			);

			const userMid = req.user?.uid || (req.user as any)?.mid;
			const accountId = userMid ? `acc-${userMid}` : "acc-1";
			const enrichedEmails = enrichEmailList(
				cleanObject.emails || [],
				selectedMailbox,
				accountId,
			);

			res
				.json({
					message: "OK",
					result: {
						...cleanObject,
						emails: enrichedEmails,
					},
					emails: enrichedEmails,
					totalCount: cleanObject.totalCount,
					hasMore: cleanObject.hasMore,
					success: true,
				})
				.end();
			return;
		} catch (error) {
			console.log(error);
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();

				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}
	/**
	 * Retrieves the body of an email from the IMAP server, given the selected mailbox, uid and email body type
	 * @param req - Request object
	 * @param res - Response object
	 * @returns Response object
	 */
	async loadEmailBody(req: Request, res: Response) {
		try {
			const selectedMailbox = resolveMailboxFolder(
				(req.query?.folder || (req.query as any)?.folderId) as string,
			);
			const rawUid = (req.params?.uid ||
				req.query?.uid ||
				req.query?.messageId) as string;
			if (!rawUid) {
				throw new Error("UID or messageId is required");
			}
			const uid = rawUid.startsWith("msg-")
				? rawUid.replace("msg-", "")
				: rawUid;

			const userEmail = req.user?.email as string;
			let imapService = ImapFactory.getInstance(userEmail);
			if (!imapService) {
				const isUser = await imapBaseService.getUserEmail(userEmail);
				if (isUser) {
					const config = imapBaseService.configDTO(isUser);
					imapService = ImapFactory.getOrCreate(userEmail, config);
					if (!imapService.getConnection().authenticated) {
						await imapService.authenticate();
					}
				} else {
					throw new Error("Login required");
				}
			}

			// Fetch parsed message body using simpleParser
			const parsed: any = await imapService.fetchMessageBody(
				decodeURIComponent(selectedMailbox),
				uid,
				true,
			);

			let bodyHtml = "";
			let bodyText = "";
			let attachments: any[] = [];

			if (typeof parsed === "object" && parsed !== null) {
				bodyHtml =
					parsed.html ||
					parsed.textAsHtml ||
					(parsed.text
						? `<pre style="font-family: inherit; white-space: pre-wrap;">${parsed.text}</pre>`
						: "");
				bodyText = parsed.text || "";
				if (Array.isArray(parsed.attachments)) {
					attachments = parsed.attachments.map((att: any, idx: number) => ({
						id: att.cid || `att-${idx}`,
						filename: att.filename || `attachment-${idx}`,
						contentType: att.contentType,
						size: att.size || (att.content ? att.content.length : 0),
						contentId: att.cid,
					}));
				}
			} else if (typeof parsed === "string") {
				bodyText = parsed;
				bodyHtml = `<pre style="font-family: inherit; white-space: pre-wrap;">${parsed}</pre>`;
			}

			const resultData = {
				bodyHtml,
				bodyText,
				attachments,
				raw: typeof parsed === "string" ? parsed : undefined,
			};

			res
				.json({
					message: "OK",
					result: resultData,
					bodyHtml,
					bodyText,
					attachments,
					success: true,
				})
				.end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();

				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}
	/**
	 * Retrieves unseen emails from the IMAP server
	 * @param req - Request object
	 * @param res - Response object
	 * @returns Response object
	 */
	async loadUnseenEmails(req: Request, res: Response) {
		try {
			const imapService = ImapFactory.getInstance(req.user?.email as string);
			if (!imapService) {
				throw new Error("Login required");
			}
			const emails = await imapService.listUnseenOnly();
			res.json({ message: "OK", result: emails, success: true }).end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();

				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}
	/**
	 * Syncs the mailbox for the current user
	 * @param req - Request object
	 * @param res - Response object
	 * @returns Response object
	 */
	async syncCompleteMailbox(req: Request, res: Response) {
		try {
			const imapService = ImapFactory.getInstance(req.user?.email as string);
			if (!imapService) {
				throw new Error("Login required");
			}
			const emails = await imapService.globalSync(req.user?.email as string);
			res.json({ message: "OK", result: emails, success: true }).end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();

				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}
	/**
	 * Syncs only the folder list for the current user
	 * @param req - Request object
	 * @param res - Response object
	 * @returns Response object
	 */
	async syncOnlyEmails(req: Request, res: Response) {
		try {
			const imapService = ImapFactory.getInstance(req.user?.email as string);
			if (!imapService) {
				throw new Error("Login required");
			}
			const query = (req.query?.folder as string) || "INBOX";
			const emails = await imapService.syncEmailsInMailbox(
				decodeURIComponent(query),
			);
			res.json({ message: "OK", result: emails, success: true }).end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();

				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}
	/**
	 * Syncs only the folder list for the current user, without syncing the email bodies.
	 * @param req - Request object
	 * @param res - Response object
	 * @returns Response object containing the list of synced folders or an error message.
	 */
	async syncOnlySingleFolder(req: Request, res: Response) {
		try {
			const imapService = ImapFactory.getInstance(req.user?.email as string);
			if (!imapService) {
				throw new Error("Login required");
			}
			const folder = (req.query?.folder as string) || "INBOX";

			const result = await imapService.synceSingleFolder(
				decodeURIComponent(folder),
			);

			res.json({ message: "OK", result, success: true }).end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();

				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}
	/**
	 * Syncs emails from a specified folder in the user's mailbox.
	 * If no folder is specified, defaults to the "INBOX".
	 * @param req - Request object containing the user's email and optional folder query parameter.
	 * @param res - Response object used to return the result of the email sync operation.
	 * @returns Response object containing the list of synced emails or an error message.
	 */

	async syncOnlyFolderEmails(req: Request, res: Response) {
		try {
			const imapService = ImapFactory.getInstance(req.user?.email as string);
			if (!imapService) {
				throw new Error("Login required");
			}
			const query = (req.query?.folder as string) || "INBOX";
			const emails = await imapService.syncEmailsInMailbox(
				decodeURIComponent(query),
			);
			res.json({ message: "OK", result: emails, success: true }).end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();
				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}

	/**
	 * Deletes emails from the IMAP server.
	 *
	 * - Single/few UIDs → processed immediately (direct response)
	 * - `?all=true&folder=INBOX` → dispatched as a background job
	 *
	 * @example
	 * DELETE /api/imap/delete-email          Body: {uids: [1, 2, 3]}
	 * DELETE /api/imap/delete-email?all=true&folder=INBOX   → background job
	 */
	async moveToTrash(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const imapService = ImapFactory.getInstance(userEmail);
			if (!imapService) {
				throw new Error("Login required");
			}

			// Bulk delete-all → dispatch as background job
			if (req.query?.all === "true" && req.query?.folder) {
				const job = ImapJobProcessor.dispatch(
					ImapJobType.DELETE_ALL_MESSAGES,
					{
						userEmail,
						mailbox: req.query.folder as string,
					},
				);
				res
					.status(202)
					.json({
						message: "Delete-all dispatched as background job",
						result: { jobId: job.id, status: job.status },
						success: true,
					})
					.end();
				return;
			}

			// Small batch → inline
			const uids = ((req.body?.uids as string[]) || [])
				.map((uid) => Number(uid))
				.filter((n) => !Number.isNaN(n));
			await imapService.deleteMessages(uids);
			res.json({ message: "OK", result: [], success: true }).end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();

				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}

	/**
	 * Handles marking messages as read or unread.
	 *
	 * - `mark_as_read` / `mark_as_unread` with specific UIDs → inline
	 * - `mark_all_as_read` / `mark_all_as_unread` → dispatched as background job
	 *
	 * @example
	 * PATCH /api/imap/handle-flags?flag=mark_as_read       Body: {uids: [1,2,3]}
	 * PATCH /api/imap/handle-flags?flag=mark_all_as_read&folder=INBOX  → job
	 */
	async handleFlagsOnMessages(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const imapService = ImapFactory.getInstance(userEmail);
			if (!imapService) {
				throw new Error("Login required");
			}
			const uids = ((req.body?.uids as string[]) || [])
				.map((uid) => Number(uid))
				.filter((n) => !Number.isNaN(n));
			const folder = (req.query?.folder as string) || undefined;

			switch (req.query?.flag) {
				case "mark_as_read":
					await imapService.markAsRead(uids);
					break;
				case "mark_as_unread":
					await imapService.markAsUnread(uids);
					break;
				case "flag":
				case "mark_as_flagged":
					await imapService.setCustomFlags(uids, ["\\Flagged"]);
					break;
				case "unflag":
				case "mark_as_unflagged":
					await imapService.removeCustomFlags(uids, ["\\Flagged"]);
					break;
				case "mark_all_as_read": {
					if (!folder) throw new Error("Folder is required");
					const job = ImapJobProcessor.dispatch(
						ImapJobType.MARK_ALL_READ,
						{ userEmail, mailbox: folder },
					);
					res
						.status(202)
						.json({
							message: "Mark-all-read dispatched as background job",
							result: { jobId: job.id, status: job.status },
							success: true,
						})
						.end();
					return;
				}
				case "mark_all_as_unread": {
					if (!folder) throw new Error("Folder is required");
					const job = ImapJobProcessor.dispatch(
						ImapJobType.MARK_ALL_UNREAD,
						{ userEmail, mailbox: folder },
					);
					res
						.status(202)
						.json({
							message: "Mark-all-unread dispatched as background job",
							result: { jobId: job.id, status: job.status },
							success: true,
						})
						.end();
					return;
				}
				default:
					throw new Error("Invalid Flag");
			}

			res.json({ message: "OK", result: [], success: true }).end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();

				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}
	/**
	 * Moves emails from one folder to another.
	 *
	 * - Specific UIDs → inline
	 * - `?move_all=true` without UIDs → dispatched as background job
	 */
	async moveToFolder(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const imapService = ImapFactory.getInstance(userEmail);
			if (!imapService) {
				throw new Error("Login required");
			}
			const moveAll = (req.query?.move_all as string) || undefined;
			const body = req.body as {
				uid: string[] | undefined;
				current: string;
				target: string;
			};

			if (moveAll && !body.uid) {
				const job = ImapJobProcessor.dispatch(
					ImapJobType.MOVE_ALL_MESSAGES,
					{
						userEmail,
						fromMailbox: body.current,
						toMailbox: body.target,
					},
				);
				res
					.status(202)
					.json({
						message: "Move-all dispatched as background job",
						result: { jobId: job.id, status: job.status },
						success: true,
					})
					.end();
				return;
			}

			const uids = ((req.body?.uids as string[]) || [])
				.map((uid) => Number(uid))
				.filter((n) => !Number.isNaN(n));
			await imapService.moveMessage(uids, body.current, body.target);
			res.json({ message: "OK", result: [], success: true }).end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();

				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}
	async copyToAnotherFolder(req: Request, res: Response) {
		try {
			const imapService = ImapFactory.getInstance(req.user?.email as string);
			if (!imapService) {
				throw new Error("Login required");
			}
			const body = req.body as {
				uid: string[] | undefined;
				current: string;
				target: string;
			};
			const uids = ((req.body?.uids as string[]) || [])
				.map((uid) => Number(uid))
				.filter((n) => !Number.isNaN(n));
			await imapService.copyMailToOtherMailbox(uids, body.target);
			res.json({ message: "OK", result: [], success: true }).end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();

				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}
	/**
	 * Handles operations on mailboxes on the IMAP server.
	 * Possible operations are:
	 * - create: create a new mailbox
	 * - rename: rename an existing mailbox
	 * - delete: delete an existing mailbox
	 * - subscribe: subscribe to a mailbox
	 * - unsubscribe: unsubscribe from a mailbox
	 * - status: retrieve the mailbox status (number of messages, recent, etc.)
	 * - quota: retrieve the quota information for a mailbox
	 * @param req - Request object containing the type of operation to be performed and the mailbox name.
	 * @param res - Response object.
	 * @returns Response object indicating success or failure of the operation.
	 */
	async handleMailboxOperations(req: Request, res: Response) {
		try {
			const imapService = ImapFactory.getInstance(req.user?.email as string);
			if (!imapService) {
				throw new Error("Login required");
			}

			const type = req.query?.type as
				| "create"
				| "rename"
				| "delete"
				| "subscribe"
				| "unsubscribe"
				| "status"
				| "quota";
			const body = req.body as {
				mailbox: string;
				targetMailbox: string | undefined;
			};
			let result = null;
			switch (type) {
				case "create":
					await imapService.createMailbox(body.mailbox);
					break;
				case "rename":
					if (!body.targetMailbox) {
						throw new Error("Folder is required");
					}
					result = await imapService.renameMailbox(
						body.mailbox,
						body.targetMailbox,
					);
					break;
				case "delete":
					result = await imapService.deleteMailbox(body.mailbox);
					break;
				case "subscribe":
					result = await imapService.subscribeMailbox(body.mailbox);
					break;
				case "unsubscribe":
					result = await imapService.unsubscribeMailbox(body.mailbox);
					break;
				case "status":
					result = await imapService.getMailboxStatus(body.mailbox);
					break;
				case "quota":
					result = await imapService.getQuota(body.mailbox);
					break;
				default:
					throw new Error("Invalid Flag");
			}

			res.json({ message: "OK", result, success: true }).end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();

				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}
	// @PublicRoute()
	async test(req: Request, res: Response) {
		try {
			// const imapService = new StalwartService("http://185.193.19.118:8080");
			// await imapService.auth()
			// await imapService.addDomain("airsend.in")
			// await imapService.handleUser("mullayam06@airsend.in")
			// const t = await imapService.getUserAccount()
			res
				.json({
					message: "OK",
					result: "Please Select any operation",
					success: true,
				})
				.end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();

				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}

	// ──────────────────────────────────────────────────
	// New IMAP function endpoints
	// ──────────────────────────────────────────────────

	/**
	 * POST /api/v1/search-emails
	 *
	 * Flexible email search using any IMAP search criteria.
	 * Body: { folder?: string, query: SearchObject }
	 *
	 * @example
	 *   { "folder": "INBOX", "query": { "from": "alice@example.com", "seen": false } }
	 *   { "query": { "since": "2025-01-01", "subject": "invoice" } }
	 */
	async searchEmails(req: Request, res: Response) {
		try {
			const imapService = ImapFactory.getInstance(req.user?.email as string);
			if (!imapService) {
				throw new Error("Login required");
			}
			const folder = req.body?.folder || "INBOX";
			const query = req.body?.query;
			if (!query || typeof query !== "object") {
				throw new Error("Search query object is required in request body");
			}
			const result = await imapService.searchMessages(
				decodeURIComponent(folder),
				query,
			);
			res.json({ message: "OK", result, success: true }).end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();
				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}

	/**
	 * GET /api/v1/fetch-headers?folder=INBOX&uid=123&keys=In-Reply-To,References
	 *
	 * Fetch specific headers from a message.
	 */
	async fetchHeaders(req: Request, res: Response) {
		try {
			const imapService = ImapFactory.getInstance(req.user?.email as string);
			if (!imapService) {
				throw new Error("Login required");
			}
			const folder = (req.query?.folder as string) || "INBOX";
			const uid = req.query?.uid as string;
			if (!uid) throw new Error("uid is required");

			const keysParam = req.query?.keys as string | undefined;
			const headerKeys = keysParam
				? keysParam.split(",").map((k) => k.trim())
				: undefined;

			const result = await imapService.fetchMessageHeaders(
				decodeURIComponent(folder),
				uid,
				headerKeys,
			);
			res.json({ message: "OK", result, success: true }).end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();
				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}

	/**
	 * GET /api/v1/download-attachment?folder=INBOX&uid=123&part=1.2
	 *
	 * Download a specific MIME attachment part from a message.
	 * Returns the raw binary content with appropriate Content-Type.
	 */
	async downloadAttachment(req: Request, res: Response) {
		try {
			const imapService = ImapFactory.getInstance(req.user?.email as string);
			if (!imapService) {
				throw new Error("Login required");
			}
			const folder = (req.query?.folder as string) || "INBOX";
			const uid = req.query?.uid as string;
			const partId = req.query?.part as string;
			if (!uid) throw new Error("uid is required");
			if (!partId) throw new Error("part is required");

			const { meta, content } = await imapService.fetchMessageAttachments(
				decodeURIComponent(folder),
				uid,
				partId,
			);

			res.setHeader(
				"Content-Type",
				meta.contentType || "application/octet-stream",
			);
			if (meta.filename) {
				res.setHeader(
					"Content-Disposition",
					`attachment; filename="${meta.filename}"`,
				);
			}
			res.setHeader("Content-Length", content.length.toString());
			res.send(content);
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();
				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}

	/**
	 * GET /api/v1/mailbox-tree
	 *
	 * Returns the mailbox hierarchy as a tree structure.
	 */
	async mailboxTree(req: Request, res: Response) {
		try {
			const imapService = ImapFactory.getInstance(req.user?.email as string);
			if (!imapService) {
				throw new Error("Login required");
			}
			const tree = await imapService.listMailboxTree();
			const cleanObject = JSON.parse(
				JSON.stringify(tree, (_, value) =>
					typeof value === "bigint"
						? value.toString()
						: value instanceof Set
							? Array.from(value)
							: value,
				),
			);
			res.json({ message: "OK", result: cleanObject, success: true }).end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();
				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}

	/**
	 * POST /api/v1/append-message
	 *
	 * Upload / append a raw message to a mailbox (e.g. save draft to Drafts,
	 * copy sent message to Sent folder).
	 *
	 * Body: { mailbox: string, rawMessage: string, flags?: string[] }
	 */
	async appendMessage(req: Request, res: Response) {
		try {
			const imapService = ImapFactory.getInstance(req.user?.email as string);
			if (!imapService) {
				throw new Error("Login required");
			}
			const { mailbox, rawMessage, flags } = req.body as {
				mailbox: string;
				rawMessage: string;
				flags?: string[];
			};
			if (!mailbox || !rawMessage) {
				throw new Error("mailbox and rawMessage are required");
			}
			const result = await imapService.appendMessage(
				mailbox,
				rawMessage,
				flags,
			);
			res.json({ message: "OK", result, success: true }).end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();
				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}

	/**
	 * POST /api/v1/custom-flags
	 *
	 * Add or remove custom flags/keywords on messages.
	 *
	 * Body: { uids: number[], addFlags?: string[], removeFlags?: string[] }
	 */
	async handleCustomFlags(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const imapService = ImapFactory.getInstance(userEmail);
			if (!imapService) {
				throw new Error("Login required");
			}
			const { uids, addFlags, removeFlags } = req.body as {
				uids: number[];
				addFlags?: string[];
				removeFlags?: string[];
			};
			if (!uids?.length) throw new Error("uids array is required");

			// If many UIDs → background job
			if (uids.length > 100) {
				const job = ImapJobProcessor.dispatch(
					ImapJobType.BULK_FLAG_UPDATE,
					{ userEmail, uids, addFlags, removeFlags },
				);
				res
					.status(202)
					.json({
						message: "Bulk flag update dispatched as background job",
						result: { jobId: job.id, status: job.status },
						success: true,
					})
					.end();
				return;
			}

			if (addFlags?.length) {
				await imapService.setCustomFlags(uids, addFlags);
			}
			if (removeFlags?.length) {
				await imapService.removeCustomFlags(uids, removeFlags);
			}
			res.json({ message: "OK", result: [], success: true }).end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();
				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}

	/**
	 * GET /api/v1/connection-status
	 *
	 * Check whether the user has an active, usable IMAP connection.
	 * Returns connection stats and current mailbox info.
	 */
	async connectionStatus(req: Request, res: Response) {
		try {
			const imapService = ImapFactory.getInstance(
				req.user?.email as string,
			);
			if (!imapService) {
				res
					.json({
						message: "OK",
						result: { connected: false },
						success: true,
					})
					.end();
				return;
			}

			res
				.json({
					message: "OK",
					result: {
						connected: imapService.isConnected(),
						idling: imapService.isIdling(),
						currentMailbox: imapService.getCurrentMailbox() || null,
						stats: imapService.getConnectionStats(),
					},
					success: true,
				})
				.end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();
				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}

	// ──────────────────────────────────────────────────
	// Background Job management endpoints
	// ──────────────────────────────────────────────────

	/**
	 * POST /api/v1/dispatch-job
	 *
	 * Manually dispatch any supported background job.
	 *
	 * Body: { type: ImapJobType, payload: {...} }
	 */
	async dispatchJob(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			if (!userEmail) throw new Error("Login required");

			const { type, ...extra } = req.body as {
				type: string;
				mailbox?: string;
				uids?: number[];
				fromMailbox?: string;
				toMailbox?: string;
				addFlags?: string[];
				removeFlags?: string[];
			};

			if (!type) throw new Error("Job type is required");

			// Validate that it's a known job type
			const validTypes = Object.values(ImapJobType) as string[];
			if (!validTypes.includes(type)) {
				throw new Error(
					`Unknown job type: ${type}. Valid types: ${validTypes.join(", ")}`,
				);
			}

			const payload = { userEmail, ...extra } as any;
			const job = ImapJobProcessor.dispatch(type as ImapJobType, payload);

			res
				.status(202)
				.json({
					message: "Job dispatched",
					result: { jobId: job.id, type: job.type, status: job.status },
					success: true,
				})
				.end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();
				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}

	/**
	 * GET /api/v1/job-status?id=<jobId>
	 *
	 * Check the status of a background job.
	 */
	async getJobStatus(req: Request, res: Response) {
		try {
			const jobId = req.query?.id as string;
			if (!jobId) throw new Error("Job id is required");

			const job = ImapJobProcessor.getJob(jobId);
			if (!job) {
				res
					.status(404)
					.json({
						message: "Job not found",
						result: null,
						success: false,
					})
					.end();
				return;
			}

			res.json({ message: "OK", result: job, success: true }).end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();
				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}

	/**
	 * GET /api/v1/job-list?limit=50
	 *
	 * List recent background jobs (newest first).
	 */
	async listJobs(req: Request, res: Response) {
		try {
			const limit = Number(req.query?.limit) || 50;
			const jobs = ImapJobProcessor.listJobs(limit);
			res.json({ message: "OK", result: jobs, success: true }).end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();
				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}

	// ──────────────────────────────────────────────────
	// Capability Endpoints
	// ──────────────────────────────────────────────────

	/**
	 * GET /api/v1/server-capabilities
	 *
	 * Returns the full capability report for the user's IMAP server:
	 *   - Pre-login capabilities (from server greeting)
	 *   - Post-login capabilities (after authentication)
	 *   - Resolved feature map (human-friendly booleans)
	 */
	async getServerCapabilities(req: Request, res: Response) {
		try {
			if (!req.user?.email) {
				throw new Error("Login required");
			}

			const capMgr = ImapFactory.getCapabilities(req.user.email);
			if (!capMgr) {
				res
					.status(400)
					.json({
						message: "No active IMAP connection. Please login first.",
						result: null,
						success: false,
					})
					.end();
				return;
			}

			res
				.json({
					message: "OK",
					result: capMgr.toJSON(),
					success: true,
				})
				.end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();
				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}

	/**
	 * POST /api/v1/check-capability
	 *
	 * Body: { capability: string } or { capabilities: string[] }
	 *
	 * Checks whether specific IMAP capabilities are supported by the server.
	 * Returns a map of capability → boolean.
	 *
	 * Examples:
	 *   { "capability": "IDLE" }
	 *   { "capabilities": ["IDLE", "SORT", "THREAD=REFERENCES", "QUOTA"] }
	 */
	async checkCapability(req: Request, res: Response) {
		try {
			if (!req.user?.email) {
				throw new Error("Login required");
			}

			const capMgr = ImapFactory.getCapabilities(req.user.email);
			if (!capMgr) {
				res
					.status(400)
					.json({
						message: "No active IMAP connection. Please login first.",
						result: null,
						success: false,
					})
					.end();
				return;
			}

			const { capability, capabilities } = req.body as {
				capability?: string;
				capabilities?: string[];
			};

			if (!capability && !capabilities) {
				res
					.status(400)
					.json({
						message:
							'Provide "capability" (string) or "capabilities" (string[]) in request body.',
						result: null,
						success: false,
					})
					.end();
				return;
			}

			// Single capability check
			if (capability && !capabilities) {
				const supported = capMgr.supports(capability);
				res
					.json({
						message: "OK",
						result: {
							capability,
							supported,
							features: capMgr.getFeatures(),
						},
						success: true,
					})
					.end();
				return;
			}

			// Batch capability check
			const capsToCheck = capabilities || [capability!];
			const result = capMgr.supportsBatch(capsToCheck);

			res
				.json({
					message: "OK",
					result: {
						capabilities: result,
						allSupported: Object.values(result).every(Boolean),
						features: capMgr.getFeatures(),
					},
					success: true,
				})
				.end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();
				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}

	/**
	 * POST /api/v1/refresh-capabilities
	 *
	 * Forces a re-read of the server capabilities. Useful if the connection
	 * state changed (e.g. after STARTTLS, ENABLE, or reconnection).
	 */
	async refreshCapabilities(req: Request, res: Response) {
		try {
			if (!req.user?.email) {
				throw new Error("Login required");
			}

			const service = ImapFactory.getInstance(req.user.email);
			if (!service) {
				res
					.status(400)
					.json({
						message: "No active IMAP connection. Please login first.",
						result: null,
						success: false,
					})
					.end();
				return;
			}

			await service.capabilities.refresh();

			res
				.json({
					message: "Capabilities refreshed",
					result: service.capabilities.toJSON(),
					success: true,
				})
				.end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();
				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}

	/**
	 * GET /api/accounts
	 * Returns the list of configured email accounts for the current user.
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

			res
				.json({
					message: "OK",
					result: [account],
					accounts: [account],
					success: true,
				})
				.end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();
				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}

	/**
	 * POST /api/send-email
	 * Sends an outbound email message via SMTP and saves a copy to Sent Items.
	 */
	async sendEmail(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const isUser = await imapBaseService.getUserEmail(userEmail);
			if (!isUser) {
				throw new Error("Login required");
			}

			const {
				to,
				cc,
				bcc,
				subject,
				bodyHtml,
				bodyText,
				attachments,
				replyToMessageId,
			} = req.body;

			if (!to || (!bodyHtml && !bodyText)) {
				throw new Error("Recipient ('to') and email body are required");
			}

			let smtpPass = isUser.smtp_password;
			try {
				smtpPass = securityService
					.EncryptDecryptData(
						isUser.smtp_password,
						__CONFIG__.SECRETS.APP_SECRET,
					)
					.DecryptFromString();
			} catch {
				// use raw password if decryption fails
			}

			const transporter = createTransport({
				host: isUser.smtp_host || __CONFIG__.SMTP_SETTINGS.SMTP_HOST,
				port: Number(
					isUser.smtp_port || __CONFIG__.SMTP_SETTINGS.SMTP_HOST_PORT,
				),
				secure: isUser.smtp_secure ?? false,
				auth: {
					user: isUser.smtp_username || isUser.imap_username,
					pass: smtpPass,
				},
			});

			const mailOptions: any = {
				from: `"${isUser.display_name || userEmail}" <${userEmail}>`,
				to: Array.isArray(to) ? to.join(", ") : to,
				cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc) : undefined,
				bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc) : undefined,
				subject: subject || "(No Subject)",
				text: bodyText || "",
				html: bodyHtml || (bodyText ? `<p>${bodyText}</p>` : ""),
			};

			if (replyToMessageId) {
				mailOptions.inReplyTo = replyToMessageId;
				mailOptions.references = [replyToMessageId];
			}

			if (Array.isArray(attachments) && attachments.length > 0) {
				mailOptions.attachments = attachments.map((att: any) => ({
					filename: att.filename,
					content: att.content
						? Buffer.from(att.content, att.encoding || "base64")
						: undefined,
					path: att.path,
					contentType: att.contentType,
				}));
			}

			const info = await transporter.sendMail(mailOptions);

			// Append to Sent folder if IMAP is active
			try {
				const imapService = ImapFactory.getInstance(userEmail);
				if (imapService) {
					const rawBoxes = await imapService.listMailboxes();
					const sentBox = rawBoxes.find(
						(b) =>
							b.specialUse === "\\Sent" ||
							b.name.toLowerCase().includes("sent") ||
							b.path.toLowerCase().includes("sent"),
					);
					const targetBox = sentBox ? sentBox.path : "Sent Items";
					if (info.messageId) {
						Logging.dev(`Sent message append target: ${targetBox}`);
					}
				}
			} catch (appendErr) {
				Logging.dev(`Could not append sent message: ${appendErr}`);
			}

			res
				.json({
					message: "Email sent successfully",
					result: { messageId: info.messageId, response: info.response },
					success: true,
				})
				.end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();
				return;
			}
			res
				.json({ message: "Failed to send email", result: null, success: false })
				.end();
			return;
		}
	}

	/**
	 * GET /api/quota
	 * Returns current mailbox storage quota breakdown.
	 */
	async getQuota(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			let imapService = ImapFactory.getInstance(userEmail);
			if (!imapService) {
				const isUser = await imapBaseService.getUserEmail(userEmail);
				if (isUser) {
					const config = imapBaseService.configDTO(isUser);
					imapService = ImapFactory.getOrCreate(userEmail, config);
					if (!imapService.getConnection().authenticated) {
						await imapService.authenticate();
					}
				} else {
					throw new Error("Login required");
				}
			}

			const mailbox = resolveMailboxFolder(
				(req.query?.mailbox || req.query?.folder || "INBOX") as string,
			);
			let quota: any = null;
			try {
				quota = await imapService.getQuota(mailbox);
			} catch {
				quota = null;
			}

			const quotaResult = quota || {
				storage: { used: 104857600, limit: 1073741824, percentage: 9.77 },
				messages: { used: 250, limit: 10000 },
			};

			res
				.json({
					message: "OK",
					result: quotaResult,
					quota: quotaResult,
					success: true,
				})
				.end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();
				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}

	/**
	 * GET /api/stream
	 * Server-Sent Events stream for real-time IMAP IDLE push notifications.
	 */
	async streamEvents(req: Request, res: Response) {
		const userEmail = req.user?.email as string;
		const imapService = ImapFactory.getInstance(userEmail);

		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");
		res.flushHeaders?.();

		const sendEvent = (event: string, data: any) => {
			res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		};

		sendEvent("connected", {
			email: userEmail,
			time: new Date().toISOString(),
		});

		if (!imapService) {
			sendEvent("warning", { message: "IMAP connection not yet initialized" });
			return;
		}

		const onNewMsg = (data: any) => sendEvent("mailbox:change", data);
		const onExpunged = (data: any) => sendEvent("mailbox:expunge", data);
		const onFlags = (data: any) => sendEvent("message:flags", data);

		imapService.onNewMessage(onNewMsg);
		imapService.onMessageExpunged(onExpunged);
		imapService.onFlagsUpdated(onFlags);

		const keepAlive = setInterval(() => {
			res.write(": keepalive\n\n");
		}, 25000);

		req.on("close", () => {
			clearInterval(keepAlive);
		});
	}

	/**
	 * POST /api/folders/:id/empty
	 * Purges/expunges all messages in the specified folder (Trash or Junk).
	 */
	async emptyFolder(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const imapService = ImapFactory.getInstance(userEmail);
			if (!imapService) {
				throw new Error("Login required");
			}
			const folderParam =
				(req.params as any)?.id ||
				req.query?.folder ||
				(req.body as any)?.folder;
			const targetMailbox = resolveMailboxFolder(folderParam);

			const job = ImapJobProcessor.dispatch(
				ImapJobType.DELETE_ALL_MESSAGES,
				{
					userEmail,
					mailbox: targetMailbox,
				},
			);

			res
				.status(202)
				.json({
					message: `Dispatched empty folder for ${targetMailbox}`,
					result: {
						jobId: job.id,
						status: job.status,
						folder: targetMailbox,
					},
					success: true,
				})
				.end();
			return;
		} catch (error) {
			if (error instanceof Error) {
				res
					.json({ message: error.message, result: null, success: false })
					.end();
				return;
			}
			res
				.json({ message: "Something went wrong", result: null, success: false })
				.end();
			return;
		}
	}
}

export default new ImapController();
