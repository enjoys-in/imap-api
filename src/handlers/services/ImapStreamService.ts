import { Logging } from "@/logs";
import type { Request, Response } from "express";
import { ImapFactory } from "../factory/ImapFactory";
import { vacationSenderService } from "./VacationSenderService";

export enum ImapStreamEvent {
	CONNECTED = "connected",
	MAILBOX_CHANGE = "mailbox:change",
	MAILBOX_EXPUNGE = "mailbox:expunge",
	MESSAGE_FLAGS = "message:flags",
	WARNING = "warning",
}

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
		const imapService = ImapFactory.getInstance(userEmail);

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

		if (!imapService) {
			sendEvent(ImapStreamEvent.WARNING, {
				message: "IMAP connection not yet initialized",
			});
			return;
		}

		const onNewMsg = (data: any) => {
			sendEvent(ImapStreamEvent.MAILBOX_CHANGE, data);

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
		const onExpunged = (data: any) =>
			sendEvent(ImapStreamEvent.MAILBOX_EXPUNGE, data);
		const onFlags = (data: any) =>
			sendEvent(ImapStreamEvent.MESSAGE_FLAGS, data);

		imapService.onNewMessage(onNewMsg);
		imapService.onMessageExpunged(onExpunged);
		imapService.onFlagsUpdated(onFlags);

		const keepAlive = setInterval(() => {
			if (!res.writableEnded) {
				res.write(": keepalive\n\n");
			}
		}, 25000);

		let cleanedUp = false;
		const cleanup = () => {
			if (cleanedUp) return;
			cleanedUp = true;

			clearInterval(keepAlive);

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
