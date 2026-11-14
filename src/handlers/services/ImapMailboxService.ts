import { Logging } from "@/logs";
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
import { mailboxStorageService } from "./MailboxStorageService";
import { messageSyncService } from "./MessageSyncService";

const QUOTA_DB_FRESH_MS = 5 * 60 * 1000;

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
			const accountId = userMid ? `acc-${userMid}` : "acc-1";
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
						total_count: result.total_count,
						unseen_count: result.unseen_count,
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
		for (const folder of folders) {
			if (!imapService.isSelectable(folder)) {
				messages[folder.name] = {
					info: folder,
					total_count: 0,
					uidNext: null,
					unseen_count: 0,
					emails: [],
					hasMore: false,
				};
				continue;
			}
			const page = await messageSyncService.getPage(
				imapService,
				connectionId,
				folder.path,
				0,
				50,
			);
			messages[folder.name] = {
				info: folder,
				total_count: page.totalCount,
				uidNext: page.uidNext,
				unseen_count: folder.unseen_count,
				emails: page.emails.reverse(),
				hasMore: page.hasMore,
			};
		}
		return { email: userEmail, mailboxList: folders, messages };
	}

	async syncCompleteMailbox(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const userMid = req.user?.uid || (req.user as any)?.mid;
			const imapService = await getAuthenticatedImapService(userEmail, userMid);

			// Synchronize all folders to database
			const rawBoxes = (await imapService.syncFolders()) || [];
			if (userMid) {
				await mailboxStorageService.saveMailboxes(Number(userMid), rawBoxes);
				try {
					const quotaData = await imapService.getQuota("INBOX");
					if (quotaData) {
						await mailboxStorageService.saveQuota(
							Number(userMid),
							"INBOX",
							quotaData,
						);
					}
				} catch (err: any) {
					Logging.dev(`Quota sync skipped: ${err?.message}`);
				}
			}

			const emails = userMid
				? await this.syncAllFolders(imapService, userEmail, Number(userMid), rawBoxes)
				: await imapService.globalSync(userEmail);

			await imapCache.invalidateMailboxes(userEmail);
			await imapCache.invalidateQuota(userEmail);

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

			// 1. Check in-memory/redis cache
			let quotaResult = !forceSync
				? await imapCache.getQuota(userEmail, mailbox)
				: null;

			// 2. Check PostgreSQL database (sub-millisecond instant response)
			if (!quotaResult && !forceSync) {
				const storedQuota = await mailboxStorageService.getQuota(
					Number(userMid),
					mailbox,
				);
				if (
				storedQuota &&
				Date.now() - storedQuota.updated_at.getTime() < QUOTA_DB_FRESH_MS
			) {
					quotaResult = mailboxStorageService.formatQuotaForClient(storedQuota);
					await imapCache.setQuota(userEmail, mailbox, quotaResult, 120);
				}
			}

			// 3. Fallback to live IMAP server when missing or force sync requested
			if (!quotaResult) {
				const imapService = await getAuthenticatedImapService(
					userEmail,
					userMid,
				);
				const liveQuota = await imapService.getQuota(mailbox);
				const savedQuota = await mailboxStorageService.saveQuota(
					Number(userMid),
					mailbox,
					liveQuota,
				);
				quotaResult = mailboxStorageService.formatQuotaForClient(savedQuota);
				await imapCache.setQuota(userEmail, mailbox, quotaResult, 120);
			}

			return sendSuccess(res, quotaResult);
		} catch (error) {
			return sendError(res, error);
		}
	}
}

export const imapMailboxService = new ImapMailboxService();
