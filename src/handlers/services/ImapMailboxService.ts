import { Logging } from "@/logs";
import type { Request, Response } from "express";
import { imapCache } from "../cache/ImapCacheService";
import { formatImapError } from "../helpers/error.helper";
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
import { mailboxStorageService } from "./MailboxStorageService";
import { imapEventHub } from "./ImapEventHub";
import { ImapStreamEvent } from "./ImapStreamService";
import { messageSyncService } from "./MessageSyncService";
import { quotaService } from "./QuotaService";


export class ImapMailboxService {
	/**
	 * Retrieves all mailboxes.
	 * Cache-first strategy: checks memory/redis cache, then PostgreSQL database.
	 * Only queries the live IMAP server on first load or when ?sync=true is explicitly passed.
	 */
	async loadMailboxes(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const userMid = req.user?.uid || (req.user as any)?.mid;
			if (!userMid) {
				throw new Error("Login required");
			}
			const accountId = `acc-${userMid}`;
			const forceSync =
				req.query?.sync === "true" || req.query?.force === "true";

			// 1. Check in-memory/redis cache (if not forcing sync)
			let enrichedMailboxes = !forceSync
				? await imapCache.getMailboxes(userEmail)
				: null;

			// 2. Check PostgreSQL database (instant sub-millisecond read)
			if (!enrichedMailboxes && userMid && !forceSync) {
				const stored = await mailboxStorageService.getMailboxes(
					Number(userMid),
				);
				if (stored.length > 0) {
					enrichedMailboxes = mailboxStorageService.formatMailboxesForClient(
						stored,
						accountId,
					);
					await imapCache.setMailboxes(userEmail, enrichedMailboxes, 60);
				}
			}

			// 3. Fallback to live IMAP server when DB is empty (first load) or when explicit sync is requested
			if (!enrichedMailboxes) {
				const imapService = await getAuthenticatedImapService(
					userEmail,
					userMid,
				);
				const rawMailboxes = (await imapService.syncFolders()) || [];

				if (userMid) {
					const saved = await mailboxStorageService.saveMailboxes(
						Number(userMid),
						rawMailboxes,
					);
					enrichedMailboxes = mailboxStorageService.formatMailboxesForClient(
						saved,
						accountId,
					);
				} else {
					enrichedMailboxes = enrichMailboxList(rawMailboxes, accountId);
				}

				await imapCache.setMailboxes(userEmail, enrichedMailboxes, 60);
			}

			return sendSuccess(res, enrichedMailboxes);
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
			const userMid = req.user?.uid || (req.user as any)?.mid;
			const imapService = await getAuthenticatedImapService(userEmail, userMid);
			const tree = await imapService.listMailboxTree();
			const cleanObject = cleanBigIntJson(tree);

			return sendSuccess(res, cleanObject);
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Syncs only a single folder metadata and message list.
	 * Updates the folder count in the database.
	 */
	async syncOnlySingleFolder(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const userMid = req.user?.uid || (req.user as any)?.mid;
			const imapService = await getAuthenticatedImapService(userEmail, userMid);
			const folder = (req.query?.folder as string) || "INBOX";
			const decodedFolder = decodeURIComponent(folder);

			const result = await imapService.synceSingleFolder(decodedFolder);

			if (userMid && result) {
				await mailboxStorageService.updateMailboxCounts(
					Number(userMid),
					decodedFolder,
					{
						total_count: result.totalCount,
						unseen_count: result.unreadCount,
						uid_next: result.uidNext,
						uid_validity: result.uidValidity,
						highest_modseq: result.highestModseq,
					},
				);
			}

			// Invalidate memory cache since folder state changed
			await imapCache.invalidateMailboxes(userEmail);

			return sendSuccess(res, result);
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Runs a global sync across all mailboxes for the current user.
	 * Updates both folders and storage quota in PostgreSQL.
	 */
	private async syncAllFolders(
		imapService: Awaited<ReturnType<typeof getAuthenticatedImapService>>,
		userEmail: string,
		connectionId: number,
		folders: any[],
	) {
		const messages: Record<string, unknown> = {};
		let added = 0;
		imapEventHub.publish(userEmail, ImapStreamEvent.SYNC_START, {
			folders: folders.length,
		});

		for (const [index, folder] of folders.entries()) {
			if (!imapService.isSelectable(folder)) {
				messages[folder.name] = {
					info: folder,
					totalCount: 0,
					uidNext: null,
					unreadCount: 0,
					emails: [],
					hasMore: false,
				};
				continue;
			}

			const delta = await messageSyncService.syncMailbox(
				imapService,
				connectionId,
				folder.path,
			);
			const emails = await messageSyncService.readStored(
				connectionId,
				folder.path,
				0,
				50,
			);
			added += delta.added.length;
			messages[folder.name] = {
				info: folder,
				totalCount: delta.totalCount,
				uidNext: delta.uidNext,
				unreadCount: delta.unseenCount,
				emails: emails.reverse(),
				hasMore: delta.totalCount > emails.length,
			};
			imapEventHub.publish(userEmail, ImapStreamEvent.SYNC_FOLDER, {
				path: folder.path,
				index: index + 1,
				total: folders.length,
				newCount: delta.added.length,
				storedCount: delta.stored,
				removedCount: delta.removed.length,
				totalCount: delta.totalCount,
				unreadCount: delta.unseenCount,
			});
		}

		return {
			payload: { email: userEmail, mailboxList: folders, messages },
			added,
		};
	}

	async syncCompleteMailbox(req: Request, res: Response) {
		const userEmail = req.user?.email as string;
		try {
			const userMid = req.user?.uid || (req.user as any)?.mid;
			if (!userMid) {
				throw new Error("Login required");
			}
			const connectionId = Number(userMid);
			const imapService = await getAuthenticatedImapService(userEmail, userMid);

			const folders = await imapService.listMailboxes();
			await mailboxStorageService.saveMailboxes(connectionId, folders);
			try {
				await quotaService.refresh(imapService, userEmail, connectionId, "INBOX");
			} catch (err: any) {
				Logging.dev(`Quota sync skipped: ${err?.message}`);
			}

			const { payload, added } = await this.syncAllFolders(
				imapService,
				userEmail,
				connectionId,
				folders,
			);

			await imapCache.invalidateMailboxes(userEmail);

			imapEventHub.publish(userEmail, ImapStreamEvent.SYNC_COMPLETE, {
				folders: folders.length,
				newMessages: added,
				mailboxes: mailboxStorageService.formatMailboxesForClient(
					await mailboxStorageService.getMailboxes(connectionId),
					`acc-${connectionId}`,
				),
				quota: await quotaService
					.overview(() => Promise.resolve(imapService), userEmail, connectionId)
					.catch(() => null),
			});

			return sendSuccess(res, payload);
		} catch (error) {
			imapEventHub.publish(userEmail, ImapStreamEvent.WARNING, {
				message: formatImapError(error),
			});
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
					await imapCache.invalidateMailboxes(userEmail);
					break;
				case "rename":
					if (!body.targetMailbox) {
						throw new Error("Folder is required");
					}
					result = await imapService.renameMailbox(
						body.mailbox,
						body.targetMailbox,
					);
					await imapCache.invalidateMailboxes(userEmail);
					break;
				case "delete":
					result = await imapService.deleteMailbox(body.mailbox);
					await imapCache.invalidateMailboxes(userEmail);
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
			await imapCache.invalidateMailboxes(userEmail);
			await imapCache.invalidateEmailBody(userEmail, targetMailbox);

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
	 * Returns mailbox storage quota breakdown.
	 * Cache-first strategy: checks memory/redis cache, then PostgreSQL database.
	 * Only queries IMAP when ?sync=true is provided or on first query.
	 */
	async getQuota(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const userMid = req.user?.uid || (req.user as any)?.mid;
			const forceSync =
				req.query?.sync === "true" || req.query?.force === "true";

			const mailbox = resolveMailboxFolder(
				(req.query?.mailbox || req.query?.folder || "INBOX") as string,
			);

			if (!userMid) {
				throw new Error("Login required");
			}

			const quota = await quotaService.getMailboxQuota(
				() => getAuthenticatedImapService(userEmail, userMid),
				userEmail,
				Number(userMid),
				mailbox,
				forceSync,
			);

			return sendSuccess(res, quota);
		} catch (error) {
			return sendError(res, error);
		}
	}
}

export const imapMailboxService = new ImapMailboxService();
