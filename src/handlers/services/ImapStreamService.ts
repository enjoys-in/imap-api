import type { Request, Response } from "express";
import { ImapFactory } from "../factory/ImapFactory";

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

		const sendEvent = (event: string, data: any) => {
			if (!res.writableEnded) {
				res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
			}
		};

		sendEvent("connected", {
			email: userEmail,
			time: new Date().toISOString(),
		});

		if (!imapService) {
			sendEvent("warning", { message: "IMAP connection not yet initialized" });
			return;
		}

		const onNewMsg = (data: any) => sendEvent("mailbox:change", data);
		const onExpunged = (data: any) => sendEvent("mailbox:expunge", data);
		const onFlags = (data: any) => sendEvent("message:flags", data);

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
