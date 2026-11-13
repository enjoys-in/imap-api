import type { Request, Response } from "express";
import { imapCache } from "../cache/ImapCacheService";
import {
	cleanBigIntJson,
	enrichEmailList,
	parseUids,
} from "../helpers/email.helper";
import { resolveMailboxFolder } from "../helpers/folder.helper";
import { normalizeEmailBody } from "../helpers/mime.helper";
import {
	sendAccepted,
	sendError,
	sendSuccess,
} from "../helpers/response.helper";
import { getAuthenticatedImapService } from "../helpers/session.helper";
import { ImapJobProcessor } from "../jobs/ImapJobProcessor";
import { ImapJobType } from "../jobs/types";

export class ImapEmailService {
	/**
	 * Loads paginated emails for a specified mailbox or folderId.
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
			const imapService = await getAuthenticatedImapService(userEmail);

			const emails = await imapService.selectMailbox(
				decodeURIComponent(selectedMailbox),
				offset,
			);
			const cleanObject = cleanBigIntJson(emails);

			const userMid = req.user?.uid || (req.user as any)?.mid;
			const accountId = userMid ? `acc-${userMid}` : "acc-1";
			const enrichedEmails = enrichEmailList(
				cleanObject.emails || [],
				selectedMailbox,
				accountId,
			);

			return sendSuccess(
				res,
				{
					...cleanObject,
					emails: enrichedEmails,
				},
				"OK",
				{
					emails: enrichedEmails,
					totalCount: cleanObject.totalCount,
					hasMore: cleanObject.hasMore,
				},
			);
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Retrieves and parses full email MIME body with 10-minute TTL caching.
	 * Caching parsed email bodies prevents repetitive IMAP socket streaming
	 * and heavy CPU/memory parsing on every email view.
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

			// Check TTL cache first (10 min TTL)
			const cached = imapCache.getEmailBody(userEmail, selectedMailbox, uid);
			if (cached) {
				return sendSuccess(res, cached, "OK", {
					bodyHtml: cached.bodyHtml,
					bodyText: cached.bodyText,
					attachments: cached.attachments,
				});
			}

			const imapService = await getAuthenticatedImapService(userEmail);
			const parsed = await imapService.fetchMessageBody(
				decodeURIComponent(selectedMailbox),
				uid,
				true,
			);

			const resultData = normalizeEmailBody(parsed);

			// Cache normalized body
			imapCache.setEmailBody(userEmail, selectedMailbox, uid, resultData, 600);

			return sendSuccess(res, resultData, "OK", {
				bodyHtml: resultData.bodyHtml,
				bodyText: resultData.bodyText,
				attachments: resultData.attachments,
			});
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Retrieves unseen emails from the IMAP server.
	 */
	async loadUnseenEmails(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const imapService = await getAuthenticatedImapService(userEmail);
			const emails = await imapService.listUnseenOnly();

			return sendSuccess(res, emails);
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Syncs emails in a mailbox.
	 */
	async syncEmails(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const imapService = await getAuthenticatedImapService(userEmail);
			const query = (req.query?.folder as string) || "INBOX";

			const emails = await imapService.syncEmailsInMailbox(
				decodeURIComponent(query),
			);

			return sendSuccess(res, emails);
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Deletes emails from the IMAP server (inline for small batches, job for bulk).
	 */
	async moveToTrash(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const imapService = await getAuthenticatedImapService(userEmail);

			// Bulk delete-all → dispatch background job
			if (req.query?.all === "true" && req.query?.folder) {
				const folder = req.query.folder as string;
				const job = ImapJobProcessor.dispatch(ImapJobType.DELETE_ALL_MESSAGES, {
					userEmail,
					mailbox: folder,
				});

				imapCache.invalidateMailboxes(userEmail);
				imapCache.invalidateEmailBody(userEmail, folder);

				return sendAccepted(res, "Delete-all dispatched as background job", {
					jobId: job.id,
					status: job.status,
				});
			}

			const uids = parseUids(req.body?.uids);
			await imapService.deleteMessages(uids);

			imapCache.invalidateMailboxes(userEmail);
			imapCache.invalidateEmailBody(userEmail);

			return sendSuccess(res, []);
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Handles marking messages as read, unread, flagged, or unflagged.
	 */
	async handleFlagsOnMessages(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const imapService = await getAuthenticatedImapService(userEmail);
			const uids = parseUids(req.body?.uids);
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
					const job = ImapJobProcessor.dispatch(ImapJobType.MARK_ALL_READ, {
						userEmail,
						mailbox: folder,
					});
					imapCache.invalidateMailboxes(userEmail);
					return sendAccepted(
						res,
						"Mark-all-read dispatched as background job",
						{ jobId: job.id, status: job.status },
					);
				}
				case "mark_all_as_unread": {
					if (!folder) throw new Error("Folder is required");
					const job = ImapJobProcessor.dispatch(ImapJobType.MARK_ALL_UNREAD, {
						userEmail,
						mailbox: folder,
					});
					imapCache.invalidateMailboxes(userEmail);
					return sendAccepted(
						res,
						"Mark-all-unread dispatched as background job",
						{ jobId: job.id, status: job.status },
					);
				}
				default:
					throw new Error("Invalid Flag");
			}

			imapCache.invalidateMailboxes(userEmail);
			return sendSuccess(res, []);
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Moves emails from one folder to another.
	 */
	async moveToFolder(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const imapService = await getAuthenticatedImapService(userEmail);
			const moveAll = (req.query?.move_all as string) || undefined;
			const body = req.body as {
				uid?: string[];
				uids?: string[] | number[];
				current: string;
				target: string;
			};

			if (moveAll && !body.uid && !body.uids) {
				const job = ImapJobProcessor.dispatch(ImapJobType.MOVE_ALL_MESSAGES, {
					userEmail,
					fromMailbox: body.current,
					toMailbox: body.target,
				});
				imapCache.invalidateMailboxes(userEmail);
				imapCache.invalidateEmailBody(userEmail);

				return sendAccepted(res, "Move-all dispatched as background job", {
					jobId: job.id,
					status: job.status,
				});
			}

			const uids = parseUids(body.uids || body.uid);
			await imapService.moveMessage(uids, body.current, body.target);

			imapCache.invalidateMailboxes(userEmail);
			imapCache.invalidateEmailBody(userEmail);

			return sendSuccess(res, []);
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Copies emails from one folder to another.
	 */
	async copyToAnotherFolder(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const imapService = await getAuthenticatedImapService(userEmail);
			const body = req.body as {
				uid?: string[];
				uids?: string[] | number[];
				current?: string;
				target: string;
			};

			const uids = parseUids(body.uids || body.uid);
			await imapService.copyMailToOtherMailbox(uids, body.target);

			imapCache.invalidateMailboxes(userEmail);
			return sendSuccess(res, []);
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Searches emails using flexible IMAP search criteria.
	 */
	async searchEmails(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const imapService = await getAuthenticatedImapService(userEmail);
			const folder = req.body?.folder || "INBOX";
			const query = req.body?.query;

			if (!query || typeof query !== "object") {
				throw new Error("Search query object is required in request body");
			}

			const result = await imapService.searchMessages(
				decodeURIComponent(folder),
				query,
			);
			return sendSuccess(res, result);
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Fetches specific message headers.
	 */
	async fetchHeaders(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const imapService = await getAuthenticatedImapService(userEmail);
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
			return sendSuccess(res, result);
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Downloads a specific MIME attachment part as raw binary.
	 */
	async downloadAttachment(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const imapService = await getAuthenticatedImapService(userEmail);
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
			return sendError(res, error);
		}
	}

	/**
	 * Appends a raw message to a mailbox (e.g. Drafts or Sent).
	 */
	async appendMessage(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const imapService = await getAuthenticatedImapService(userEmail);
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

			imapCache.invalidateMailboxes(userEmail);
			return sendSuccess(res, result);
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Adds or removes custom flags/keywords on messages.
	 */
	async handleCustomFlags(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const imapService = await getAuthenticatedImapService(userEmail);
			const { uids, addFlags, removeFlags } = req.body as {
				uids: number[];
				addFlags?: string[];
				removeFlags?: string[];
			};

			if (!uids?.length) throw new Error("uids array is required");

			// If many UIDs → background job
			if (uids.length > 100) {
				const job = ImapJobProcessor.dispatch(ImapJobType.BULK_FLAG_UPDATE, {
					userEmail,
					uids,
					addFlags,
					removeFlags,
				});
				imapCache.invalidateMailboxes(userEmail);
				return sendAccepted(
					res,
					"Bulk flag update dispatched as background job",
					{ jobId: job.id, status: job.status },
				);
			}

			if (addFlags?.length) {
				await imapService.setCustomFlags(uids, addFlags);
			}
			if (removeFlags?.length) {
				await imapService.removeCustomFlags(uids, removeFlags);
			}

			imapCache.invalidateMailboxes(userEmail);
			return sendSuccess(res, []);
		} catch (error) {
			return sendError(res, error);
		}
	}
}

export const imapEmailService = new ImapEmailService();
