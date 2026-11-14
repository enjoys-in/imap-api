import { ImapStreamEvent } from "./ImapStreamEvent";
import type { SyncDelta } from "./MessageSyncService";

const NEW_MESSAGE_PREVIEW_LIMIT = 5;
const EXPUNGE_EVENT_LIMIT = 50;

export type Publish = (event: string, data: unknown) => void;

export function announceDelta(
	publish: Publish,
	delta: SyncDelta,
	quota: unknown | null,
	flagHints?: Map<number, string[]>,
): boolean {
	const { path } = delta;
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
