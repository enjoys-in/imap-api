import { Logging } from "@/logs";
import type { MailboxEntity } from "@/factory/entities";
import { imapCache } from "../cache/ImapCacheService";
import { formatImapError } from "../helpers/error.helper";
import { getAuthenticatedImapService } from "../helpers/session.helper";
import { imapEventHub } from "./ImapEventHub";
import type { FolderStatus } from "./ImapService";
import { ImapStreamEvent } from "./ImapStreamEvent";
import { mailboxStorageService } from "./MailboxStorageService";
import { messageMutationService } from "./MessageMutationService";
import { messageSyncService } from "./MessageSyncService";
import { quotaService } from "./QuotaService";
import { announceDelta } from "./SyncAnnouncer";

const DEFAULT_INTERVAL_MS = 10_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_BACKOFF_STEPS = 6;

export function folderWatchInterval(): number {
	const raw = process.env.FOLDER_WATCH_INTERVAL_MS;
	if (raw === undefined || raw.trim() === "") {
		return DEFAULT_INTERVAL_MS;
	}
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		return 0;
	}
	return Math.max(MIN_INTERVAL_MS, value);
}

interface Watch {
	email: string;
	connectionId: number;
	interval: number;
	subscribers: number;
	timer: NodeJS.Timeout | null;
	running: boolean;
	stopped: boolean;
	failures: number;
}

type CountedFolder = Pick<
	MailboxEntity,
	"total_count" | "unseen_count" | "uid_next" | "uid_validity" | "highest_modseq"
>;

const differs = (row: CountedFolder, status: NonNullable<FolderStatus["status"]>) =>
	Number(row.total_count) !== status.messages ||
	Number(row.unseen_count) !== status.unseen ||
	row.uid_next === null ||
	row.uid_next === undefined ||
	Number(row.uid_next) !== status.uidNext ||
	row.uid_validity === null ||
	row.uid_validity === undefined ||
	Number(row.uid_validity) !== status.uidValidity ||
	(status.highestModseq !== null &&
		row.highest_modseq !== null &&
		row.highest_modseq !== undefined &&
		String(row.highest_modseq) !== status.highestModseq);

export class FolderWatcher {
	private readonly watches = new Map<number, Watch>();

	acquire(email: string, connectionId: number): () => void {
		const interval = folderWatchInterval();
		if (interval === 0) {
			return () => undefined;
		}

		let watch = this.watches.get(connectionId);
		if (!watch) {
			watch = {
				email,
				connectionId,
				interval,
				subscribers: 0,
				timer: null,
				running: false,
				stopped: false,
				failures: 0,
			};
			this.watches.set(connectionId, watch);
			this.schedule(watch);
		}
		watch.subscribers++;

		const owner = watch;
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			owner.subscribers--;
			if (owner.subscribers <= 0) {
				this.stop(owner);
			}
		};
	}

	activeWatchers(): number {
		return this.watches.size;
	}

	subscriberCount(connectionId: number): number {
		return this.watches.get(connectionId)?.subscribers ?? 0;
	}

	private stop(watch: Watch) {
		watch.stopped = true;
		if (watch.timer) {
			clearTimeout(watch.timer);
			watch.timer = null;
		}
		if (this.watches.get(watch.connectionId) === watch) {
			this.watches.delete(watch.connectionId);
		}
	}

	private schedule(watch: Watch) {
		if (watch.stopped) {
			return;
		}
		const delay =
			watch.interval * Math.min(1 + watch.failures, MAX_BACKOFF_STEPS);
		watch.timer = setTimeout(() => {
			watch.timer = null;
			void this.tick(watch);
		}, delay);
		watch.timer.unref?.();
	}

	private async tick(watch: Watch) {
		if (watch.running || watch.stopped) {
			return;
		}
		watch.running = true;
		try {
			await this.check(watch);
			watch.failures = 0;
		} catch (error) {
			if (watch.failures === 0) {
				Logging.dev(
					`[FolderWatcher] ${watch.email}: ${formatImapError(error)}`,
				);
			}
			watch.failures++;
		} finally {
			watch.running = false;
			this.schedule(watch);
		}
	}

	private publish(watch: Watch) {
		return (event: string, data: unknown) =>
			imapEventHub.publish(watch.email, event, data);
	}

	private async check(watch: Watch) {
		const { email, connectionId } = watch;
		const imap = await getAuthenticatedImapService(email, connectionId);
		const listed = await imap.folderStatuses();
		if (watch.stopped) {
			return;
		}

		let rows = await mailboxStorageService.getMailboxes(connectionId);
		const listedPaths = new Set(listed.map(({ box }) => box.path));
		const knownPaths = new Set(rows.map((row) => row.path));
		const created = listed.filter(({ box }) => !knownPaths.has(box.path));
		const removed = rows.filter((row) => !listedPaths.has(row.path));

		if (created.length > 0 || removed.length > 0) {
			await mailboxStorageService.saveMailboxes(
				connectionId,
				listed.map(({ box }) => box),
			);
			rows = await mailboxStorageService.getMailboxes(connectionId);
			await imapCache.invalidateMailboxes(email);

			const publish = this.publish(watch);
			for (const { box, status } of created) {
				publish(ImapStreamEvent.MAILBOX_CHANGE, {
					path: box.path,
					count: status?.messages ?? 0,
					prevCount: status?.messages ?? 0,
					newCount: 0,
					totalCount: status?.messages ?? 0,
					unreadCount: status?.unseen ?? 0,
					messages: [],
					quota: null,
				});
			}
			for (const row of removed) {
				publish(ImapStreamEvent.MAILBOX_CHANGE, {
					path: row.path,
					count: 0,
					prevCount: 0,
					newCount: 0,
					totalCount: 0,
					unreadCount: 0,
					messages: [],
					quota: null,
				});
			}
		}

		const byPath = new Map(rows.map((row) => [row.path, row]));
		const createdPaths = new Set(created.map(({ box }) => box.path));
		for (const { box, status } of listed) {
			if (!status || watch.stopped) {
				continue;
			}
			const row = byPath.get(box.path);
			if (row && !differs(row, status)) {
				continue;
			}
			if (messageMutationService.isBusy(connectionId, box.path, watch.interval)) {
				continue;
			}
			await this.syncFolder(watch, imap, box.path, row, createdPaths.has(box.path));
		}
	}

	private async syncFolder(
		watch: Watch,
		imap: Awaited<ReturnType<typeof getAuthenticatedImapService>>,
		path: string,
		before: CountedFolder | undefined,
		isNew: boolean,
	) {
		const { email, connectionId } = watch;
		const delta = await messageSyncService.syncMailbox(imap, connectionId, path);

		const changed = delta.added.length > 0 || delta.removed.length > 0;
		const quota = changed
			? await quotaService
					.refresh(imap, email, connectionId, "INBOX")
					.catch(() => null)
			: null;

		await imapCache.invalidateMailboxes(email);
		for (const uid of delta.removed) {
			await imapCache.invalidateEmailBody(email, path, uid);
		}

		if (watch.stopped) {
			return;
		}

		const publish = this.publish(watch);
		const announced = announceDelta(publish, delta, quota);
		const countsMoved =
			!before ||
			Number(before.total_count) !== delta.totalCount ||
			Number(before.unseen_count) !== delta.unseenCount;
		if (!announced && countsMoved && !isNew) {
			publish(ImapStreamEvent.MAILBOX_CHANGE, {
				path,
				count: delta.totalCount,
				prevCount: delta.totalCount,
				newCount: 0,
				totalCount: delta.totalCount,
				unreadCount: delta.unseenCount,
				messages: [],
				quota,
			});
		}
	}
}

export const folderWatcher = new FolderWatcher();
