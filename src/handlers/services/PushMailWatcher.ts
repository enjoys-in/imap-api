import type { PushSubscriptionEntity } from "@/factory/entities";
import { Logging } from "@/logs";
import { AppEvents } from "@/utils/services/Events";
import { formatImapError } from "../helpers/error.helper";
import { getAuthenticatedImapService } from "../helpers/session.helper";
import { mailboxStorageService } from "./MailboxStorageService";
import { type SyncDelta, messageSyncService } from "./MessageSyncService";
import { pushSubscriptionService } from "./PushSubscriptionService";
import { streamPresence } from "./StreamPresence";
import { announceSync } from "./SyncAnnouncer";
import { type PushPayload, webPushService } from "./WebPushService";
import { folderDiffers } from "./folderDiff";
import imapBaseService from "./imapBaseService";
import { pushWatchInterval } from "./pushConfig";

const INBOX = "INBOX";
const MAX_INDIVIDUAL = 3;
const MAX_TEXT = 140;
const MAX_BACKOFF_MS = 10 * 60 * 1000;
const BATCH = 4;

type Arrival = SyncDelta["added"][number];

interface Backoff {
	count: number;
	until: number;
}

export interface WatchRun {
	checked: number;
	skipped: number;
	notified: number;
}

const clip = (value: string): string => {
	const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
	return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT - 1)}…` : clean;
};

export const senderLabel = (from: string | undefined): string => {
	const first = (from ?? "").split(",")[0]?.trim();
	return first ? clip(first) : "Unknown sender";
};

const subjectLabel = (subject: string | undefined): string =>
	subject?.trim() ? clip(subject) : "(No subject)";

export const addressedTo = (message: Arrival, address: string): boolean =>
	(message.to ?? "")
		.toLowerCase()
		.split(",")
		.some((part) => part.trim() === address.toLowerCase());

export function buildPayloads(
	messages: Arrival[],
	includePreview: boolean,
	connectionId: number,
): PushPayload[] {
	if (messages.length === 0) {
		return [];
	}
	if (messages.length <= MAX_INDIVIDUAL) {
		return messages.map((message) => ({
			title: includePreview ? senderLabel(message.from) : "New message",
			body: includePreview ? subjectLabel(message.subject) : "You have new email",
			tag: `airsend-${connectionId}-${message.uid}`,
			data: { url: "/", folder: INBOX, uid: message.uid },
		}));
	}
	const latest = messages[messages.length - 1];
	return [
		{
			title: `${messages.length} new messages`,
			body: includePreview
				? clip(
						`Latest from ${senderLabel(latest.from)}: ${subjectLabel(latest.subject)}`,
					)
				: "You have new email",
			tag: `airsend-${connectionId}-summary`,
			data: { url: "/", folder: INBOX },
		},
	];
}

export class PushMailWatcher {
	private timer: NodeJS.Timeout | null = null;
	private running = false;
	private stopped = true;
	private readonly backoff = new Map<number, Backoff>();

	start(): boolean {
		if (!this.stopped) {
			return true;
		}
		if (pushWatchInterval() === 0 || !webPushService.isConfigured()) {
			return false;
		}
		this.stopped = false;
		this.schedule();
		return true;
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	isRunning(): boolean {
		return !this.stopped;
	}

	private schedule() {
		if (this.stopped) {
			return;
		}
		const interval = pushWatchInterval();
		if (interval === 0) {
			this.stop();
			return;
		}
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.runOnce().finally(() => this.schedule());
		}, interval);
		this.timer.unref?.();
	}

	async runOnce(): Promise<WatchRun> {
		const run: WatchRun = { checked: 0, skipped: 0, notified: 0 };
		if (this.running) {
			return run;
		}
		this.running = true;
		try {
			const ids = await pushSubscriptionService.connectionIds();
			for (let i = 0; i < ids.length; i += BATCH) {
				await Promise.all(
					ids.slice(i, i + BATCH).map(async (id) => {
						const outcome = await this.check(id);
						if (outcome === null) {
							run.skipped++;
							return;
						}
						run.checked++;
						run.notified += outcome;
					}),
				);
			}
		} catch (error) {
			Logging.dev(`[PushMailWatcher] ${formatImapError(error)}`);
		} finally {
			this.running = false;
		}
		return run;
	}

	private async check(connectionId: number): Promise<number | null> {
		if (streamPresence.snapshot(connectionId).level !== "gone") {
			return null;
		}
		const blocked = this.backoff.get(connectionId);
		if (blocked && Date.now() < blocked.until) {
			return null;
		}

		try {
			const sent = await this.checkInbox(connectionId);
			this.backoff.delete(connectionId);
			return sent;
		} catch (error) {
			const count = (blocked?.count ?? 0) + 1;
			const wait = Math.min(pushWatchInterval() * 2 ** count, MAX_BACKOFF_MS);
			this.backoff.set(connectionId, { count, until: Date.now() + wait });
			Logging.dev(
				`[PushMailWatcher] ${connectionId}: ${formatImapError(error)}`,
			);
			return 0;
		}
	}

	private async checkInbox(connectionId: number): Promise<number> {
		const user = await imapBaseService.getUserById(connectionId);
		if (!user) {
			return 0;
		}
		const email = user.imap_username;
		const imap = await getAuthenticatedImapService(email, connectionId);

		const rows = await mailboxStorageService.getMailboxes(connectionId);
		const row = rows.find((candidate) => candidate.path === INBOX);
		const [current] = await imap.pathStatuses([INBOX]);
		if (!current?.status) {
			return 0;
		}
		if (row && !folderDiffers(row, current.status)) {
			return 0;
		}

		const delta = await messageSyncService.syncMailbox(imap, connectionId, INBOX);
		await announceSync(
			{
				imap,
				email,
				connectionId,
				publish: () => undefined,
				isClosed: () => false,
			},
			delta,
		);
		if (delta.added.length === 0) {
			return 0;
		}
		return this.notify(connectionId, email, delta.added);
	}

	private async notify(
		connectionId: number,
		email: string,
		arrivals: Arrival[],
	): Promise<number> {
		const subscriptions = await pushSubscriptionService.forConnection(connectionId);
		const delivered: number[] = [];
		let sent = 0;

		for (const subscription of subscriptions) {
			const wanted = this.audienceFilter(subscription, arrivals, email);
			for (const payload of buildPayloads(
				wanted,
				subscription.include_preview,
				connectionId,
			)) {
				const outcome = await webPushService.send(subscription, payload);
				if (outcome === "gone") {
					break;
				}
				if (outcome === "sent") {
					sent++;
					delivered.push(subscription.id);
				}
			}
		}

		await pushSubscriptionService.markNotified([...new Set(delivered)]);
		return sent;
	}

	private audienceFilter(
		subscription: PushSubscriptionEntity,
		arrivals: Arrival[],
		email: string,
	): Arrival[] {
		if (subscription.audience === "direct") {
			return arrivals.filter((message) => addressedTo(message, email));
		}
		return arrivals;
	}
}

export const pushMailWatcher = new PushMailWatcher();

AppEvents.on("start", () => {
	pushMailWatcher.start();
});
AppEvents.on("shutdown", () => {
	pushMailWatcher.stop();
});
