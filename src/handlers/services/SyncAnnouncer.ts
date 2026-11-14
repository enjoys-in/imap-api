import { imapCache } from "../cache/ImapCacheService";
import type { ImapService } from "./ImapService";
import { ImapStreamEvent } from "./ImapStreamEvent";
import type { SyncDelta } from "./MessageSyncService";
import { quotaService } from "./QuotaService";

const NEW_MESSAGE_PREVIEW_LIMIT = 5;
const EXPUNGE_EVENT_LIMIT = 50;

export type Publish = (event: string, data: unknown) => void;

export interface SyncAnnounceContext {
	imap: ImapService;
	email: string;
	connectionId: number;
	publish: Publish;
	isClosed: () => boolean;
}

export function announceDelta(
	publish: Publish,
	delta: SyncDelta,
	quota: unknown | null,
	flagHints?: Map<number, string[]>,
	quotaDeferred = false,
): boolean {
	const { path } = delta;
	const deferred = quotaDeferred ? { quotaDeferred: true } : {};
	let announced = false;

	if (delta.added.length > 0) {
		announced = true;
		publish(ImapStreamEvent.MAILBOX_CHANGE, {
			path,
			count: delta.totalCount,
			prevCount: delta.previousTotal,
			newCount: delta.added.length,
			totalCount: delta.totalCount,
			unreadCount: delta.unseenCount,
			messages: delta.added.slice(-NEW_MESSAGE_PREVIEW_LIMIT).map((message) => ({
				uid: message.uid,
				from: message.from,
				subject: message.subject,
				date: message.date,
			})),
			quota,
			...deferred,
		});
	}

	if (delta.removed.length > 0) {
		announced = true;
		const totals = {
			path,
			vanished: false,
			totalCount: delta.totalCount,
			unreadCount: delta.unseenCount,
			quota,
			...deferred,
		};
		if (delta.removed.length <= EXPUNGE_EVENT_LIMIT) {
			for (const uid of delta.removed) {
				publish(ImapStreamEvent.MAILBOX_EXPUNGE, {
					...totals,
					uid,
					removed: delta.removed,
				});
			}
		} else {
			publish(ImapStreamEvent.MAILBOX_EXPUNGE, {
				...totals,
				removed: [],
				removedCount: delta.removed.length,
			});
		}
	}

	const flagChanges = new Map(
		delta.updated.map((change) => [change.uid, change.flags]),
	);
	for (const [uid, flags] of flagHints ?? []) {
		if (!flagChanges.has(uid)) {
			flagChanges.set(uid, flags);
		}
	}
	for (const [uid, flags] of flagChanges) {
		announced = true;
		publish(ImapStreamEvent.MESSAGE_FLAGS, {
			path,
			uid,
			flags,
			unreadCount: delta.unseenCount,
			totalCount: delta.totalCount,
		});
	}

	return announced;
}

const quotaRefreshes = new Map<number, Promise<unknown>>();

function sharedQuotaRefresh(context: SyncAnnounceContext): Promise<unknown> {
	const running = quotaRefreshes.get(context.connectionId);
	if (running) {
		return running;
	}
	const next = quotaService
		.refresh(context.imap, context.email, context.connectionId, "INBOX")
		.finally(() => quotaRefreshes.delete(context.connectionId));
	quotaRefreshes.set(context.connectionId, next);
	return next;
}

async function followWithQuota(context: SyncAnnounceContext): Promise<void> {
	try {
		const quota = await sharedQuotaRefresh(context);
		if (quota && !context.isClosed()) {
			context.publish(ImapStreamEvent.QUOTA_UPDATE, { quota });
		}
	} catch {
		return;
	}
}

export async function announceSync(
	context: SyncAnnounceContext,
	delta: SyncDelta,
	flagHints?: Map<number, string[]>,
): Promise<boolean> {
	await imapCache.invalidateMailboxes(context.email);
	for (const uid of delta.removed) {
		await imapCache.invalidateEmailBody(context.email, delta.path, uid);
	}
	if (context.isClosed()) {
		return false;
	}

	const sizeChanged = delta.added.length > 0 || delta.removed.length > 0;
	const announced = announceDelta(
		context.publish,
		delta,
		null,
		flagHints,
		sizeChanged,
	);
	if (sizeChanged) {
		void followWithQuota(context);
	}
	return announced;
}
