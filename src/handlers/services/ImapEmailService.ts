import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import { imapCache } from "../cache/ImapCacheService";
import {
	PART_ID_PATTERN,
	contentDispositionAttachment,
	toClientAttachment,
} from "../helpers/attachment.helper";
import { cleanBigIntJson, enrichEmailList } from "../helpers/email.helper";
import {
	requireFolderParam,
	requireIdentity,
	resolveMailbox,
	resolveMessageScope,
	resolveTarget,
	settleMutation,
} from "../helpers/mailbox.helper";
import { readText } from "../helpers/mailbox.resolver";
import { normalizeEmailBody } from "../helpers/mime.helper";
import {
	sendAccepted,
	sendError,
	sendSuccess,
} from "../helpers/response.helper";
import { parseSearchQueryString } from "../helpers/search.helper";
import { getAuthenticatedImapService } from "../helpers/session.helper";
import { ImapJobProcessor } from "../jobs/ImapJobProcessor";
import { ImapJobType } from "../jobs/types";
import type { ImapService } from "./ImapService";
import { messageSyncService } from "./MessageSyncService";

interface LoadEmailsQuery {
	folder?: string;
	folderId?: string;
	page?: string;
	offset?: string;
	limit?: string;
}

interface TransferRequestBody {
	target?: unknown;
}

interface AppendRequestBody {
	mailbox?: unknown;
	rawMessage?: string;
	flags?: string[];
}

interface CustomFlagsRequestBody {
	addFlags?: string[];
	removeFlags?: string[];
}

type FlagAction = (
	imap: ImapService,
	uids: number[],
	mailbox: string,
) => Promise<unknown>;

const BULK_FLAG_THRESHOLD = 100;

const FLAGGED = ["\\Flagged"];

const BULK_FLAG_JOBS: Record<string, ImapJobType | undefined> = {
	mark_all_as_read: ImapJobType.MARK_ALL_READ,
	mark_all_as_unread: ImapJobType.MARK_ALL_UNREAD,
};

const flagAdded: FlagAction = (imap, uids, mailbox) =>
	imap.setCustomFlags(uids, FLAGGED, mailbox);

const flagRemoved: FlagAction = (imap, uids, mailbox) =>
	imap.removeCustomFlags(uids, FLAGGED, mailbox);

const FLAG_ACTIONS: Record<string, FlagAction | undefined> = {
	mark_as_read: (imap, uids, mailbox) => imap.markAsRead(uids, mailbox),
	mark_as_unread: (imap, uids, mailbox) => imap.markAsUnread(uids, mailbox),
	flag: flagAdded,
	mark_as_flagged: flagAdded,
	unflag: flagRemoved,
	mark_as_unflagged: flagRemoved,
};

export class ImapEmailService {
	async loadEmails(req: Request, res: Response) {
		try {
			const query = req.query as LoadEmailsQuery;
			const limit = Math.max(1, Number(query.limit) || 50);
			const page = Math.max(1, Number(query.page) || 1);
			const offset =
				query.offset !== undefined && !query.page
					? Math.max(0, Number(query.offset) || 0)
					: (page - 1) * limit;

			const { email, connectionId } = requireIdentity(req);
			const [imapService, mailbox] = await Promise.all([
				getAuthenticatedImapService(email, connectionId),
				resolveMailbox(connectionId, query.folder ?? query.folderId),
			]);
			const emails = await messageSyncService.getPage(
				imapService,
				connectionId,
				mailbox.path,
				offset,
				limit,
			);
			const cleanObject = cleanBigIntJson(emails);
			const enrichedEmails = enrichEmailList(
				cleanObject.emails || [],
				mailbox.path,
				`acc-${connectionId}`,
				mailbox.id ?? undefined,
			);

			return sendSuccess(res, {
				...cleanObject,
				emails: enrichedEmails,
			});
		} catch (error) {
			return sendError(res, error);
		}
	}

	async loadEmailBody(req: Request, res: Response) {
		try {
			const { email, connectionId } = requireIdentity(req);
			const mailbox = await resolveMailbox(
				connectionId,
				req.query?.folder ?? req.query?.folderId,
			);
			const rawUid = String(
				req.params?.uid || req.query?.uid || req.query?.messageId || "",
			);
			if (!rawUid) {
				throw new Error("UID or messageId is required");
			}
			const uid = rawUid.replace(/^msg-/, "");
			if (!/^\d+$/.test(uid)) {
				throw new Error("A numeric uid is required");
			}

			const cached = await imapCache.getEmailBody(email, mailbox.path, uid);
			if (cached) {
				return sendSuccess(res, cached);
			}

			const imapService = await getAuthenticatedImapService(
				email,
				connectionId,
			);
			const { summary, parsed } = await imapService.fetchMessage(
				mailbox.path,
				Number(uid),
			);
			const resultData = normalizeEmailBody(
				parsed,
				summary.attachments.map((attachment) =>
					toClientAttachment(attachment, mailbox.path, uid),
				),
			);
			await imapCache.setEmailBody(email, mailbox.path, uid, resultData, 600);

			return sendSuccess(res, resultData);
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

	async moveToTrash(req: Request, res: Response) {
		try {
			const deleteAll = req.query?.all === "true";
			const scope = await resolveMessageScope(req, {
				requireUids: !deleteAll,
			});
			const source = { path: scope.mailbox.path, removed: scope.uids };

			if (deleteAll) {
				const job = ImapJobProcessor.dispatch(ImapJobType.DELETE_ALL_MESSAGES, {
					userEmail: scope.email,
					connectionId: scope.connectionId,
					mailbox: source.path,
				});
				return sendAccepted(res, "Delete-all dispatched as background job", {
					jobId: job.id,
					status: job.status,
				});
			}

			await scope.imap.deleteMessages(scope.uids, source.path);
			const result = await settleMutation(scope, {
				reason: "delete",
				source,
				refreshQuota: true,
			});
			return sendSuccess(res, result);
		} catch (error) {
			return sendError(res, error);
		}
	}

	async handleFlagsOnMessages(req: Request, res: Response) {
		try {
			const action = String(req.query?.flag ?? "");
			const bulkJob = BULK_FLAG_JOBS[action];
			if (bulkJob) {
				requireFolderParam(req);
			}
			const scope = await resolveMessageScope(req, {
				requireUids: !bulkJob,
			});
			const { path } = scope.mailbox;

			if (bulkJob) {
				const job = ImapJobProcessor.dispatch(bulkJob, {
					userEmail: scope.email,
					connectionId: scope.connectionId,
					mailbox: path,
				});
				return sendAccepted(res, `${action} dispatched as background job`, {
					jobId: job.id,
					status: job.status,
				});
			}

			const apply = FLAG_ACTIONS[action];
			if (!apply) {
				throw new Error("Invalid Flag");
			}
			await apply(scope.imap, scope.uids, path);
			const result = await settleMutation(scope, {
				reason: "flags",
				source: { path, flagged: scope.uids },
			});
			return sendSuccess(res, result);
		} catch (error) {
			return sendError(res, error);
		}
	}

	async moveToFolder(req: Request, res: Response) {
		try {
			const moveAll = Boolean(req.query?.move_all);
			const scope = await resolveMessageScope(req, { requireUids: !moveAll });
			const target = await resolveTarget(
				scope.connectionId,
				(req.body as TransferRequestBody | undefined)?.target,
			);
			const source = scope.mailbox.path;
			if (target.path === source) {
				throw new Error("Source and target mailbox are the same");
			}

			if (moveAll && scope.uids.length === 0) {
				const job = ImapJobProcessor.dispatch(ImapJobType.MOVE_ALL_MESSAGES, {
					userEmail: scope.email,
					connectionId: scope.connectionId,
					fromMailbox: source,
					toMailbox: target.path,
				});
				return sendAccepted(res, "Move-all dispatched as background job", {
					jobId: job.id,
					status: job.status,
				});
			}

			await scope.imap.moveMessage(scope.uids, source, target.path);
			const result = await settleMutation(scope, {
				reason: "move",
				source: { path: source, removed: scope.uids },
				target: { path: target.path, count: scope.uids.length },
			});
			return sendSuccess(res, result);
		} catch (error) {
			return sendError(res, error);
		}
	}

	async copyToAnotherFolder(req: Request, res: Response) {
		try {
			const scope = await resolveMessageScope(req);
			const target = await resolveTarget(
				scope.connectionId,
				(req.body as TransferRequestBody | undefined)?.target,
			);
			if (target.path === scope.mailbox.path) {
				throw new Error("Source and target mailbox are the same");
			}

			await scope.imap.copyMailToOtherMailbox(
				scope.uids,
				target.path,
				scope.mailbox.path,
			);
			const result = await settleMutation(scope, {
				reason: "copy",
				target: { path: target.path, count: scope.uids.length },
				refreshQuota: true,
			});
			return sendSuccess(res, result);
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Searches emails using flexible IMAP search criteria, supporting query operators
	 * (from:, to:, subject:, body:, has:attachment, file:, is:unread, is:flagged, since:, before:)
	 * as well as direct fuzzy search across subject, user, preview, and attachments.
	 * Returns fully enriched email metadata objects matching the frontend schema.
	 */
	async searchEmails(req: Request, res: Response) {
		try {
			const { email, connectionId } = requireIdentity(req);
			const imapService = await getAuthenticatedImapService(
				email,
				connectionId,
			);
			const mailbox = await resolveMailbox(
				connectionId,
				req.body?.folder ??
					req.query?.folder ??
					req.body?.folderId ??
					req.query?.folderId,
			);

			const rawQuery =
				req.body?.query !== undefined
					? req.body.query
					: req.body?.q !== undefined
						? req.body.q
						: req.query?.q !== undefined
							? req.query.q
							: (req.query as any)?.query;

			if (!rawQuery) {
				return sendSuccess(res, { emails: [], totalCount: 0, uids: [] });
			}

			let imapSearchQuery: any;
			let filterAttachment = false;
			let filterFileName: string | undefined = undefined;

			if (typeof rawQuery === "string") {
				const parsed = parseSearchQueryString(rawQuery);
				imapSearchQuery = parsed.imapQuery;
				filterAttachment = !!parsed.hasAttachment;
				filterFileName = parsed.fileName;
			} else if (typeof rawQuery === "object") {
				imapSearchQuery = rawQuery;
				if (rawQuery.hasAttachment) filterAttachment = true;
				if (rawQuery.fileName)
					filterFileName = String(rawQuery.fileName).toLowerCase();
			} else {
				imapSearchQuery = { text: String(rawQuery) };
			}

			const limit = Number(req.query?.limit || req.body?.limit || 50);
			const foundUids = await imapService.searchMessages(
				mailbox.path,
				imapSearchQuery,
				true,
			);

			if (!foundUids || !Array.isArray(foundUids) || foundUids.length === 0) {
				return sendSuccess(res, { emails: [], totalCount: 0, uids: [] });
			}

			// Sort newest first
			const sortedUids = [...foundUids].sort((a, b) => b - a);
			const targetUids = sortedUids.slice(0, limit);

			// Fetch detailed message headers & attachment metadata for matching UIDs
			const rawMessages = await imapService.fetchDetailedMessagesByUids(
				mailbox.path,
				targetUids,
			);

			let enrichedEmails = enrichEmailList(
				cleanBigIntJson(rawMessages),
				mailbox.path,
				`acc-${connectionId}`,
				mailbox.id ?? undefined,
			);

			if (filterAttachment) {
				enrichedEmails = enrichedEmails.filter(
					(e: any) =>
						e.hasAttachments || (e.attachments && e.attachments.length > 0),
				);
			}

			if (filterFileName) {
				enrichedEmails = enrichedEmails.filter((e: any) =>
					e.attachments?.some((att: any) =>
						(att.filename || "").toLowerCase().includes(filterFileName!),
					),
				);
			}

			return sendSuccess(res, {
				emails: enrichedEmails,
				totalCount: foundUids.length,
				uids: foundUids,
			});
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Fetches specific message headers.
	 */
	async fetchHeaders(req: Request, res: Response) {
		try {
			const { email, connectionId } = requireIdentity(req);
			const imapService = await getAuthenticatedImapService(
				email,
				connectionId,
			);
			const mailbox = await resolveMailbox(connectionId, req.query?.folder);
			const uid = req.query?.uid as string;
			if (!uid) throw new Error("uid is required");

			const keysParam = req.query?.keys as string | undefined;
			const headerKeys = keysParam
				? keysParam.split(",").map((k) => k.trim())
				: undefined;

			const result = await imapService.fetchMessageHeaders(
				mailbox.path,
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
			const { email, connectionId } = requireIdentity(req);
			const mailbox = await resolveMailbox(
				connectionId,
				req.query?.folder ?? req.query?.folderId,
			);
			const uid = String(req.params?.uid ?? req.query?.uid ?? "").replace(
				/^msg-/,
				"",
			);
			const part = String(req.params?.part ?? req.query?.part ?? "");
			if (!/^\d+$/.test(uid)) {
				throw new Error("A numeric uid is required");
			}
			if (!PART_ID_PATTERN.test(part)) {
				throw new Error("A valid attachment part is required");
			}

			const imapService = await getAuthenticatedImapService(
				email,
				connectionId,
			);
			await imapService.downloadPart(
				mailbox.path,
				uid,
				part,
				async (meta, content) => {
					res.setHeader(
						"Content-Type",
						meta.contentType || "application/octet-stream",
					);
					res.setHeader(
						"Content-Disposition",
						contentDispositionAttachment(meta.filename || `attachment-${part}`),
					);
					res.setHeader("X-Content-Type-Options", "nosniff");
					res.setHeader(
						"Content-Security-Policy",
						"sandbox; default-src 'none'",
					);
					res.setHeader("Cache-Control", "private, no-store");
					await pipeline(content, res);
				},
			);
		} catch (error) {
			if (res.headersSent) {
				res.destroy();
				return;
			}
			return sendError(res, error);
		}
	}

	async appendMessage(req: Request, res: Response) {
		try {
			const scope = await resolveMessageScope(req, { requireUids: false });
			const { mailbox, rawMessage, flags } = (req.body ??
				{}) as AppendRequestBody;
			if (!readText(mailbox) || !rawMessage) {
				throw new Error("mailbox and rawMessage are required");
			}
			const target = await resolveTarget(scope.connectionId, mailbox);

			const appended = await scope.imap.appendMessage(
				target.path,
				rawMessage,
				flags,
			);
			const mutation = await settleMutation(scope, {
				reason: "append",
				target: { path: target.path, count: 1 },
				refreshQuota: true,
			});
			return sendSuccess(res, cleanBigIntJson({ ...appended, ...mutation }));
		} catch (error) {
			return sendError(res, error);
		}
	}

	async handleCustomFlags(req: Request, res: Response) {
		try {
			const scope = await resolveMessageScope(req);
			const { addFlags, removeFlags } = (req.body ??
				{}) as CustomFlagsRequestBody;
			const { path } = scope.mailbox;

			if (scope.uids.length > BULK_FLAG_THRESHOLD) {
				const job = ImapJobProcessor.dispatch(ImapJobType.BULK_FLAG_UPDATE, {
					userEmail: scope.email,
					connectionId: scope.connectionId,
					mailbox: path,
					uids: scope.uids,
					addFlags,
					removeFlags,
				});
				return sendAccepted(
					res,
					"Bulk flag update dispatched as background job",
					{ jobId: job.id, status: job.status },
				);
			}

			if (addFlags?.length) {
				await scope.imap.setCustomFlags(scope.uids, addFlags, path);
			}
			if (removeFlags?.length) {
				await scope.imap.removeCustomFlags(scope.uids, removeFlags, path);
			}
			const result = await settleMutation(scope, {
				reason: "flags",
				source: { path, flagged: scope.uids },
			});
			return sendSuccess(res, result);
		} catch (error) {
			return sendError(res, error);
		}
	}
}

export const imapEmailService = new ImapEmailService();
