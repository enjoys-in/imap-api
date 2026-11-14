import { Logging } from "@/logs";
import type { Request, Response } from "express";
import { imapCache } from "../cache/ImapCacheService";
import { ImapFactory } from "../factory/ImapFactory";
import { formatImapError } from "../helpers/error.helper";
import { folderWatcher } from "./FolderWatcher";
import { imapEventHub } from "./ImapEventHub";
import { ImapStreamEvent } from "./ImapStreamEvent";
import { messageSyncService } from "./MessageSyncService";
import { quotaService } from "./QuotaService";
import { announceDelta } from "./SyncAnnouncer";
import { vacationSenderService } from "./VacationSenderService";

export { ImapStreamEvent };

const SYNC_DEBOUNCE_MS = 300;

export class ImapStreamService {
	/**
	 * GET /api/stream
	 * Server-Sent Events stream for real-time IMAP IDLE push notifications.
	 *
	 * Memory Leak Prevention:
	 * All event listeners attached to the underlying IMAP client are strictly
	 * unregistered when the HTTP request disconnects, and keep-alive timers are cleared.
	 */
	streamEvents(req: Request, res: Response): void {
		const userEmail = req.user?.email as string;
		const userMid = req.user?.uid || (req.user as any)?.mid;
		const imapService =
			(userMid ? ImapFactory.getInstance(userMid) : null) ||
			ImapFactory.getInstance(userEmail);

		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");
		res.flushHeaders?.();

		const sendEvent = (event: ImapStreamEvent | string, data: any) => {
			if (!res.writableEnded) {
				res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
			}
		};

		sendEvent(ImapStreamEvent.CONNECTED, {
			email: userEmail,
			time: new Date().toISOString(),
		});

		if (!imapService || !userMid) {
			sendEvent(ImapStreamEvent.WARNING, {
				message: !imapService
					? "IMAP connection not yet initialized"
					: "Login required",
			});
			return;
		}

		let closed = false;
		let queue: Promise<void> = Promise.resolve();
		const timers = new Map<string, NodeJS.Timeout>();
		const flagHints = new Map<string, Map<number, string[]>>();

		const syncFolder = async (path: string) => {
			const hints = flagHints.get(path);
			flagHints.delete(path);

			try {
				const delta = await messageSyncService.syncMailbox(
					imapService,
					Number(userMid),
					path,
				);
				await imapCache.invalidateMailboxes(userEmail);
				for (const uid of delta.removed) {
					await imapCache.invalidateEmailBody(userEmail, path, uid);
				}

				const changed = delta.added.length > 0 || delta.removed.length > 0;
				const quota = changed
					? await quotaService
							.refresh(imapService, userEmail, Number(userMid), "INBOX")
							.catch(() => null)
					: null;

				if (closed) {
					return;
				}

				announceDelta(sendEvent, delta, quota, hints);
			} catch (error) {
				Logging.dev(
					`[ImapStreamService] Sync of ${path} failed: ${formatImapError(error)}`,
				);
				sendEvent(ImapStreamEvent.WARNING, {
					message: `Sync of ${path} failed: ${formatImapError(error)}`,
				});
			}
		};

		const scheduleSync = (path: string) => {
			if (timers.has(path)) {
				return;
			}
			timers.set(
				path,
				setTimeout(() => {
					timers.delete(path);
					queue = queue.then(() => (closed ? undefined : syncFolder(path)));
				}, SYNC_DEBOUNCE_MS),
			);
		};

		const onNewMsg = (data: {
			path: string;
			count: number;
			prevCount: number;
		}) => {
			scheduleSync(data?.path || "INBOX");

			// If new message arrived, check and trigger vacation auto-reply asynchronously
			if (data && data.count > (data.prevCount ?? 0)) {
				setImmediate(async () => {
					try {
						const latestMsg = await imapService.fetchLatestMessageContext(
							data.path || "INBOX",
						);
						if (latestMsg) {
							await vacationSenderService.evaluateAndSendVacationReply(
								userEmail,
								latestMsg,
							);
						}
					} catch (err: any) {
						Logging.dev(`[ImapStreamService AutoReply Check] ${err?.message}`);
					}
				});
			}
		};
		const onExpunged = (data: { path: string }) => {
			scheduleSync(data?.path || "INBOX");
		};
		const onFlags = (data: {
			path: string;
			uid?: number;
			flags: Set<string>;
		}) => {
			const path = data?.path || "INBOX";
			if (data?.uid !== undefined) {
				const forPath = flagHints.get(path) ?? new Map<number, string[]>();
				forPath.set(data.uid, Array.from(data.flags ?? []));
				flagHints.set(path, forPath);
			}
			scheduleSync(path);
		};

		imapService.onNewMessage(onNewMsg);
		imapService.onMessageExpunged(onExpunged);
		imapService.onFlagsUpdated(onFlags);
		const unsubscribeHub = imapEventHub.subscribe(userEmail, (event, data) =>
			sendEvent(event, data),
		);
		const releaseWatcher = folderWatcher.acquire(userEmail, Number(userMid));

		const keepAlive = setInterval(() => {
			if (!res.writableEnded) {
				res.write(": keepalive\n\n");
			}
		}, 25000);

		let cleanedUp = false;
		const cleanup = () => {
			if (cleanedUp) return;
			cleanedUp = true;
			closed = true;

			clearInterval(keepAlive);
			for (const timer of timers.values()) {
				clearTimeout(timer);
			}
			timers.clear();
			unsubscribeHub();
			releaseWatcher();

			// Unbind all listeners from imapService to prevent memory leaks
			imapService.offNewMessage(onNewMsg);
			imapService.offMessageExpunged(onExpunged);
			imapService.offFlagsUpdated(onFlags);
		};

		req.on("close", cleanup);
		res.on("close", cleanup);
		res.on("finish", cleanup);
	}
}

export const imapStreamService = new ImapStreamService();
