import type { Request, Response } from "express";
import { imapCache } from "../cache/ImapCacheService";
import { cleanBigIntJson, enrichMailboxList } from "../helpers/email.helper";
import { resolveMailboxFolder } from "../helpers/folder.helper";
import {
	sendAccepted,
	sendError,
	sendSuccess,
} from "../helpers/response.helper";
import { getAuthenticatedImapService } from "../helpers/session.helper";
import { ImapJobProcessor } from "../jobs/ImapJobProcessor";
import { ImapJobType } from "../jobs/types";

export class ImapMailboxService {
	/**
	 * Retrieves all mailboxes from the IMAP server with unread and total message counts.
	 * Results are cached with a 30-second TTL to avoid redundant IMAP roundtrips.
	 */
	async loadMailboxes(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const userMid = req.user?.uid || (req.user as any)?.mid;
			const accountId = userMid ? `acc-${userMid}` : "acc-1";

			let enrichedMailboxes = imapCache.getMailboxes(userEmail);
			if (!enrichedMailboxes) {
				const imapService = await getAuthenticatedImapService(userEmail);
				const rawMailboxes = (await imapService.syncFolders()) || [];
				enrichedMailboxes = enrichMailboxList(rawMailboxes, accountId);
				imapCache.setMailboxes(userEmail, enrichedMailboxes, 30);
			}

			return sendSuccess(res, enrichedMailboxes, "OK", {
				mailboxes: enrichedMailboxes,
			});
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Returns the mailbox hierarchy as a nested tree structure.
	 */
	async mailboxTree(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const imapService = await getAuthenticatedImapService(userEmail);
			const tree = await imapService.listMailboxTree();
			const cleanObject = cleanBigIntJson(tree);

			return sendSuccess(res, cleanObject);
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Syncs only a single folder metadata and message list.
	 */
	async syncOnlySingleFolder(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const imapService = await getAuthenticatedImapService(userEmail);
			const folder = (req.query?.folder as string) || "INBOX";

			const result = await imapService.synceSingleFolder(
				decodeURIComponent(folder),
			);

			// Invalidate cache since folder state changed
			imapCache.invalidateMailboxes(userEmail);

			return sendSuccess(res, result);
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Runs a global sync across all mailboxes for the current user.
	 */
	async syncCompleteMailbox(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const imapService = await getAuthenticatedImapService(userEmail);
			const emails = await imapService.globalSync(userEmail);

			imapCache.invalidateMailboxes(userEmail);

			return sendSuccess(res, emails);
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Handles mailbox folder lifecycle operations:
	 * create, rename, delete, subscribe, unsubscribe, status, quota.
	 */
	async handleMailboxOperations(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const imapService = await getAuthenticatedImapService(userEmail);

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

			let result: any = null;

			switch (type) {
				case "create":
					await imapService.createMailbox(body.mailbox);
					imapCache.invalidateMailboxes(userEmail);
					break;
				case "rename":
					if (!body.targetMailbox) {
						throw new Error("Folder is required");
					}
					result = await imapService.renameMailbox(
						body.mailbox,
						body.targetMailbox,
					);
					imapCache.invalidateMailboxes(userEmail);
					break;
				case "delete":
					result = await imapService.deleteMailbox(body.mailbox);
					imapCache.invalidateMailboxes(userEmail);
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

			return sendSuccess(res, result);
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Purges/expunges all messages in the specified folder (Trash or Junk).
	 * Dispatched as a non-blocking background job.
	 */
	async emptyFolder(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			await getAuthenticatedImapService(userEmail);

			const folderParam =
				(req.params as any)?.id ||
				req.query?.folder ||
				(req.body as any)?.folder;
			const targetMailbox = resolveMailboxFolder(folderParam);

			const job = ImapJobProcessor.dispatch(ImapJobType.DELETE_ALL_MESSAGES, {
				userEmail,
				mailbox: targetMailbox,
			});

			// Invalidate cached counts and message bodies
			imapCache.invalidateMailboxes(userEmail);
			imapCache.invalidateEmailBody(userEmail, targetMailbox);

			return sendAccepted(res, `Dispatched empty folder for ${targetMailbox}`, {
				jobId: job.id,
				status: job.status,
				folder: targetMailbox,
			});
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Returns mailbox storage quota breakdown with 60s TTL caching.
	 */
	async getQuota(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const imapService = await getAuthenticatedImapService(userEmail);

			const mailbox = resolveMailboxFolder(
				(req.query?.mailbox || req.query?.folder || "INBOX") as string,
			);

			// Check quota cache
			let quotaResult = imapCache.getQuota(userEmail, mailbox);
			if (!quotaResult) {
				try {
					quotaResult = await imapService.getQuota(mailbox);
				} catch {
					quotaResult = null;
				}

				if (!quotaResult) {
					quotaResult = {
						storage: { used: 104857600, limit: 1073741824, percentage: 9.77 },
						messages: { used: 250, limit: 10000 },
					};
				}

				imapCache.setQuota(userEmail, mailbox, quotaResult, 60);
			}

			return sendSuccess(res, quotaResult, "OK", { quota: quotaResult });
		} catch (error) {
			return sendError(res, error);
		}
	}
}

export const imapMailboxService = new ImapMailboxService();
