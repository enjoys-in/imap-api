import type { MailboxEntity } from "@/factory/entities";
import { Logging } from "@/logs";
import { imapCache } from "../cache/ImapCacheService";
import { formatImapError } from "../helpers/error.helper";
import { getFolderSpecial } from "../helpers/folder.helper";
import { getAuthenticatedImapService } from "../helpers/session.helper";
import { type CountedFolder, folderDiffers } from "./folderDiff";
import { imapEventHub } from "./ImapEventHub";
import type { FolderStatus, ImapService } from "./ImapService";
import { ImapStreamEvent } from "./ImapStreamEvent";
import { mailboxStorageService } from "./MailboxStorageService";
import { messageMutationService } from "./MessageMutationService";
import { messageSyncService } from "./MessageSyncService";
import {
	type PresenceLevel,
	type PresenceSnapshot,
	presenceRank,
	streamPresence,
} from "./StreamPresence";
import { announceSync } from "./SyncAnnouncer";
import { watchConfig } from "./watchConfig";

const MAX_BACKOFF_STEPS = 6;
const SWEEP_SLACK = 0.9;
const MIN_GRACE_MS = 1_000;
const HOT_SPECIALS = new Set(["Inbox", "Drafts", "Sent"]);
const INBOX = "INBOX";

export function folderWatchInterval(): number {
	return watchConfig().sweepMs;
}

interface Watch {
	email: string;
	connectionId: number;
	subscribers: number;
	timer: NodeJS.Timeout | null;
	running: boolean;
	stopped: boolean;
	failures: number;
	lastSweep: number;
	level: PresenceLevel;
	wake: boolean;
	paths: Set<string>;
	unsubscribe: () => void;
}

interface Plan {
	level: PresenceLevel;
	sweepEvery: number;
	hotEvery: number;
	goneInMs: number;
}

interface PathStatus {
	path: string;
	status: FolderStatus["status"];
}

export class FolderWatcher {
	private readonly watches = new Map<number, Watch>();

	acquire(email: string, connectionId: number): () => void {
		if (watchConfig().sweepMs === 0) {
			return () => undefined;
		}

		let watch = this.watches.get(connectionId);
		if (!watch) {
			const created: Watch = {
				email,
				connectionId,
				subscribers: 0,
				timer: null,
				running: false,
				stopped: false,
				failures: 0,
				lastSweep: 0,
				level: "active",
				wake: false,
				paths: new Set(),
				unsubscribe: () => undefined,
			};
			created.unsubscribe = streamPresence.subscribe(connectionId, (snapshot) =>
				this.nudge(created, snapshot),
			);
			this.watches.set(connectionId, created);
			this.schedule(created);
			watch = created;
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
		watch.unsubscribe();
		if (watch.timer) {
			clearTimeout(watch.timer);
			watch.timer = null;
		}
		if (this.watches.get(watch.connectionId) === watch) {
			this.watches.delete(watch.connectionId);
		}
	}

	private plan(watch: Watch): Plan {
		const config = watchConfig();
		const snapshot = streamPresence.snapshot(watch.connectionId);
		if (config.sweepMs === 0 || snapshot.level === "gone") {
			return {
				level: "gone",
				sweepEvery: 0,
				hotEvery: 0,
				goneInMs: 0,
			};
		}
		const goneAt =
			(snapshot.lastSeen ?? 0) + config.pingWindowMs * config.maxMissedWindows;
		const goneInMs = Math.max(0, goneAt - Date.now());
		if (snapshot.level === "active") {
			return {
				level: "active",
				sweepEvery: config.sweepMs,
				hotEvery: config.hotMs,
				goneInMs,
			};
		}
		return {
			level: snapshot.level,
			sweepEvery: config.backgroundMs,
			hotEvery: 0,
			goneInMs,
		};
	}

	private nudge(watch: Watch, snapshot: PresenceSnapshot) {
		if (watch.stopped) {
			return;
		}
		const previous = watch.level;
		const raised = presenceRank(snapshot.level) > presenceRank(previous);
		watch.level = snapshot.level;
		if (snapshot.level === "gone") {
			return;
		}
		if (raised) {
			watch.lastSweep = 0;
		}
		if (presenceRank(snapshot.level) < presenceRank(previous)) {
			return;
		}
		watch.wake = true;
		if (!watch.running) {
			this.schedule(watch);
		}
	}

	private schedule(watch: Watch) {
		if (watch.stopped) {
			return;
		}
		const plan = this.plan(watch);
		watch.level = plan.level;
		if (watch.timer) {
			clearTimeout(watch.timer);
			watch.timer = null;
		}
		if (plan.level === "gone") {
			watch.wake = false;
			return;
		}
		const base = plan.hotEvery || plan.sweepEvery;
		const paced = base * Math.min(1 + watch.failures, MAX_BACKOFF_STEPS);
		const delay = watch.wake ? 0 : Math.min(paced, plan.goneInMs + 5);
		watch.wake = false;
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
		const plan = this.plan(watch);
		watch.level = plan.level;
		if (plan.level === "gone") {
			return;
		}

		watch.running = true;
		try {
			const now = Date.now();
			const sweep = now - watch.lastSweep >= plan.sweepEvery * SWEEP_SLACK;
			await this.check(watch, plan, sweep);
			if (sweep) {
				watch.lastSweep = now;
			}
			await this.restoreFocus(watch);
			watch.failures = 0;
		} catch (error) {
			if (watch.failures === 0) {
				Logging.dev(`[FolderWatcher] ${watch.email}: ${formatImapError(error)}`);
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

	private hotPaths(rows: MailboxEntity[]) {
		return rows
			.filter(
				(row) =>
					row.path === "INBOX" ||
					HOT_SPECIALS.has(
						getFolderSpecial(row.name, row.special_use ?? undefined),
					),
			)
			.map((row) => row.path);
	}

	private async check(watch: Watch, plan: Plan, sweep: boolean) {
		const { email, connectionId } = watch;
		const imap = await getAuthenticatedImapService(email, connectionId);
		const grace = Math.max(MIN_GRACE_MS, plan.hotEvery || plan.sweepEvery);

		if (!sweep) {
			const rows = await mailboxStorageService.getMailboxes(connectionId);
			watch.paths = new Set(rows.map((row) => row.path));
			const wanted = this.hotPaths(rows);
			if (wanted.length === 0) {
				return;
			}
			const statuses = await imap.pathStatuses(wanted);
			if (watch.stopped) {
				return;
			}
			await this.syncDiffering(watch, imap, rows, statuses, new Set(), grace);
			return;
		}

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

		watch.paths = new Set(rows.map((row) => row.path));
		await this.syncDiffering(
			watch,
			imap,
			rows,
			listed.map(({ box, status }) => ({ path: box.path, status })),
			new Set(created.map(({ box }) => box.path)),
			grace,
		);
	}

	private async syncDiffering(
		watch: Watch,
		imap: ImapService,
		rows: MailboxEntity[],
		statuses: PathStatus[],
		createdPaths: Set<string>,
		grace: number,
	) {
		const byPath = new Map(rows.map((row) => [row.path, row]));
		for (const { path, status } of statuses) {
			if (!status || watch.stopped) {
				continue;
			}
			const row = byPath.get(path);
			if (row && !folderDiffers(row, status)) {
				continue;
			}
			if (messageMutationService.isBusy(watch.connectionId, path, grace)) {
				continue;
			}
			await this.syncFolder(watch, imap, path, row, createdPaths.has(path));
		}
	}

	private async restoreFocus(watch: Watch) {
		if (!watch.paths.has(INBOX) || watch.stopped) {
			return;
		}
		try {
			const imap = await getAuthenticatedImapService(
				watch.email,
				watch.connectionId,
			);
			await imap.focus(INBOX);
		} catch {
			return;
		}
	}

	private async syncFolder(
		watch: Watch,
		imap: ImapService,
		path: string,
		before: CountedFolder | undefined,
		isNew: boolean,
	) {
		const { email, connectionId } = watch;
		const delta = await messageSyncService.syncMailbox(imap, connectionId, path);

		const publish = this.publish(watch);
		const announced = await announceSync(
			{
				imap,
				email,
				connectionId,
				publish,
				isClosed: () => watch.stopped,
			},
			delta,
		);
		if (watch.stopped) {
			return;
		}

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
				quota: null,
			});
		}
	}
}

export const folderWatcher = new FolderWatcher();
