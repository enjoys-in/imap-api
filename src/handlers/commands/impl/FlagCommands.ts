import type { ImapService } from "../../services/ImapService";
import type { IImapCommand } from "../types";

/**
 * Mark specific messages as read.
 */
export class MarkAsReadCommand implements IImapCommand {
	readonly name = "MarkAsRead";
	constructor(private readonly uids: number[]) {}

	async execute(service: ImapService) {
		return service.markAsRead(this.uids);
	}
}

/**
 * Mark specific messages as unread.
 */
export class MarkAsUnreadCommand implements IImapCommand {
	readonly name = "MarkAsUnread";
	constructor(private readonly uids: number[]) {}

	async execute(service: ImapService) {
		return service.markAsUnread(this.uids);
	}
}

/**
 * Mark ALL messages in a mailbox as read.
 */
export class MarkAllAsReadCommand implements IImapCommand {
	readonly name = "MarkAllAsRead";
	constructor(private readonly mailbox: string) {}

	async execute(service: ImapService) {
		return service.markAllAsRead(this.mailbox);
	}
}

/**
 * Mark ALL messages in a mailbox as unread.
 */
export class MarkAllAsUnreadCommand implements IImapCommand {
	readonly name = "MarkAllAsUnread";
	constructor(private readonly mailbox: string) {}

	async execute(service: ImapService) {
		return service.markAllAsUnread(this.mailbox);
	}
}
