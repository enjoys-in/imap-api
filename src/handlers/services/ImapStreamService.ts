import { Logging } from "@/logs";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { ImapFactory } from "../factory/ImapFactory";
import { formatImapError } from "../helpers/error.helper";
import { requireIdentity } from "../helpers/mailbox.helper";
import { sendError, sendSuccess } from "../helpers/response.helper";
import { folderWatcher } from "./FolderWatcher";
import { imapEventHub } from "./ImapEventHub";
import { ImapStreamEvent } from "./ImapStreamEvent";
import { messageSyncService } from "./MessageSyncService";
import { streamPresence } from "./StreamPresence";
import { announceSync } from "./SyncAnnouncer";
import { vacationSenderService } from "./VacationSenderService";

export { ImapStreamEvent };

const SYNC_DEBOUNCE_MS = 60;
const TAB_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_FOLDER_PATH = 500;

const readTabId = (value: unknown): string | null =>
	typeof value === "string" && TAB_ID_PATTERN.test(value) ? value : null;

const readFolder = (value: unknown): string | null =>
	typeof value === "string" && value.length > 0 && value.length <= MAX_FOLDER_PATH
		? value
		: null;

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

		const syncFolder = async (path: string, signalledAt: number) => {
			const hints = flagHints.get(path);
			flagHints.delete(path);

			try {
				const delta = await messageSyncService.syncMailbox(
					imapService,
					Number(userMid),
					path,
					signalledAt,
				);
				await announceSync(
					{
						imap: imapService,
						email: userEmail,
						connectionId: Number(userMid),
						publish: sendEvent,
						isClosed: () => closed,
					},
					delta,
					hints,
				);
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
			const signalledAt = Date.now();
			timers.set(
				path,
				setTimeout(() => {
					timers.delete(path);
					queue = queue.then(() =>
						closed ? undefined : syncFolder(path, signalledAt),
					);
				}, SYNC_DEBOUNCE_MS),
			);
		};

		const onNewMsg = (data: {
			path: string;
			count: number;
			prevCount: number;
		}) => {
			const path = data?.path || "INBOX";
			scheduleSync(path);

			if (data && data.count > (data.prevCount ?? 0)) {
				void vacationSenderService.handleArrival(
					imapService,
					userEmail,
					path,
					data.count,
				);
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
		const closePresence = streamPresence.open(
			Number(userMid),
			readTabId(req.query?.tab) ?? randomUUID(),
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
			closePresence();

			// Unbind all listeners from imapService to prevent memory leaks
			imapService.offNewMessage(onNewMsg);
			imapService.offMessageExpunged(onExpunged);
			imapService.offFlagsUpdated(onFlags);
		};

		req.on("close", cleanup);
		res.on("close", cleanup);
		res.on("finish", cleanup);
	}

	ping(req: Request, res: Response) {
		try {
			const { connectionId } = requireIdentity(req);
			const body = (req.body ?? {}) as Record<string, unknown>;
			const tabId = readTabId(body.tabId);
			if (!tabId) {
				throw new Error("A valid tabId is required");
			}
			const snapshot = streamPresence.report(connectionId, {
				tabId,
				visible: body.visible !== false,
				folder: readFolder(body.folder),
			});
			const watching = folderWatcher.status(connectionId);
			return sendSuccess(res, {
				level: snapshot.level,
				watching: watching !== null && !watching.suspended,
			});
		} catch (error) {
			return sendError(res, error);
		}
	}
}

export const imapStreamService = new ImapStreamService();
