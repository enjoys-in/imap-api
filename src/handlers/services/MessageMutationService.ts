import { Logging } from "@/logs";
import { imapCache } from "../cache/ImapCacheService";
import { imapEventHub } from "./ImapEventHub";
import type { ImapService } from "./ImapService";
import { mailboxStorageService } from "./MailboxStorageService";
import { messageStorageService } from "./MessageStorageService";
import { type SyncDelta, messageSyncService } from "./MessageSyncService";
import { quotaService } from "./QuotaService";

const PER_MESSAGE_EVENT_LIMIT = 50;
const FLAG_REFRESH_LIMIT = 500;

export type MutationReason =
	| "delete"
	| "move"
	| "copy"
	| "flags"
	| "empty"
	| "append";

export interface MutationContext {
	imap: ImapService;
	userEmail: string;
	connectionId: number;
}

export interface MutationChange {
	reason: MutationReason;
	source?: { path: string; removed?: number[]; flagged?: number[] };
	target?: { path: string; count: number };
	refreshQuota?: boolean;
}

export interface FolderCounts {
	path: string;
	totalCount: number;
	unreadCount: number;
	uidNext: number;
	added: number;
	removed: number;
}

export interface MutationResult {
	folders: FolderCounts[];
	quota: unknown | null;
}

const unique = <T>(items: T[]) => Array.from(new Set(items));

export class MessageMutationService {
	async settle(
		ctx: MutationContext,
		change: MutationChange,
	): Promise<MutationResult> {
		const { imap, userEmail, connectionId } = ctx;
		const { source, target } = change;

		if (source?.removed?.length) {
			const row = await mailboxStorageService.getMailboxByPath(
				connectionId,
				source.path,
			);
			if (row) {
				await messageStorageService.deleteUids(row.id, source.removed);
			}
		}

		const flagged: { uid: number; flags: string[] }[] = [];
		if (source?.flagged?.length && source.flagged.length <= FLAG_REFRESH_LIMIT) {
			const row = await mailboxStorageService.getMailboxByPath(
				connectionId,
				source.path,
			);
			if (row) {
				const current = await imap.withMailbox(source.path, (box) =>
					box.flags(source.flagged ?? []),
				);
				for (const [uid, flags] of current) {
					flagged.push({ uid, flags });
				}
				await messageStorageService.updateFlags(row.id, flagged);
			}
		}

		const deltas = new Map<string, SyncDelta>();
		const paths = unique(
			[source?.path, target?.path].filter((path): path is string => !!path),
		);
		for (const path of paths) {
			try {
				deltas.set(
					path,
					await messageSyncService.syncMailbox(imap, connectionId, path, true),
				);
			} catch (error: any) {
				Logging.error(`Sync after ${change.reason} failed for ${path}: ${error?.message}`);
			}
		}

		const quota = change.refreshQuota
			? await quotaService
					.refresh(imap, userEmail, connectionId, "INBOX")
					.catch(() => null)
			: null;

		await imapCache.invalidateMailboxes(userEmail);
		if (source) {
			if (change.reason === "empty") {
				await imapCache.invalidateEmailBody(userEmail, source.path);
			}
			for (const uid of source.removed ?? []) {
				await imapCache.invalidateEmailBody(userEmail, source.path, uid);
			}
		}

		this.publish(userEmail, change, deltas, flagged, quota);

		return {
			folders: Array.from(deltas.values()).map((delta) => ({
				path: delta.path,
				totalCount: delta.totalCount,
				unreadCount: delta.unseenCount,
				uidNext: delta.uidNext,
				added: delta.added.length,
				removed: delta.removed.length,
			})),
			quota,
		};
	}

	private publish(
		userEmail: string,
		change: MutationChange,
		deltas: Map<string, SyncDelta>,
		flagged: { uid: number; flags: string[] }[],
		quota: unknown | null,
	) {
		const { source, target, reason } = change;

		const sourceDelta = source ? deltas.get(source.path) : undefined;
		if (source && sourceDelta) {
			const removed = unique([
				...(source.removed ?? []),
				...sourceDelta.removed,
			]);
			const totals = {
				path: source.path,
				totalCount: sourceDelta.totalCount,
				unreadCount: sourceDelta.unseenCount,
				quota,
				reason,
			};
			if (removed.length > 0 && removed.length <= PER_MESSAGE_EVENT_LIMIT) {
				for (const uid of removed) {
					imapEventHub.publish(userEmail, "mailbox:expunge", {
						...totals,
						uid,
						vanished: false,
						removed,
					});
				}
			} else if (removed.length > PER_MESSAGE_EVENT_LIMIT || reason === "empty") {
				imapEventHub.publish(userEmail, "mailbox:expunge", {
					...totals,
					vanished: false,
					removed: [],
					removedCount: removed.length,
				});
			}

			if (flagged.length > 0 && flagged.length <= PER_MESSAGE_EVENT_LIMIT) {
				for (const { uid, flags } of flagged) {
					imapEventHub.publish(userEmail, "message:flags", {
						path: source.path,
						uid,
						flags,
						unreadCount: sourceDelta.unseenCount,
						totalCount: sourceDelta.totalCount,
						reason,
					});
				}
			} else if (flagged.length > PER_MESSAGE_EVENT_LIMIT) {
				imapEventHub.publish(userEmail, "mailbox:change", {
					path: source.path,
					count: sourceDelta.totalCount,
					prevCount: sourceDelta.totalCount,
					newCount: 0,
					totalCount: sourceDelta.totalCount,
					unreadCount: sourceDelta.unseenCount,
					messages: [],
					quota,
					reason,
				});
			}
		}

		const targetDelta = target ? deltas.get(target.path) : undefined;
		if (target && targetDelta) {
			imapEventHub.publish(userEmail, "mailbox:change", {
				path: target.path,
				count: targetDelta.totalCount,
				prevCount: Math.max(0, targetDelta.totalCount - target.count),
				newCount: target.count,
				totalCount: targetDelta.totalCount,
				unreadCount: targetDelta.unseenCount,
				messages: targetDelta.added.slice(-5).map((message) => ({
					uid: message.uid,
					from: message.from,
					subject: message.subject,
					date: message.date,
				})),
				quota,
				reason,
			});
		}
	}
}

export const messageMutationService = new MessageMutationService();
