import { ImapCapability } from "../../services/CapabilityManager";
import type { ImapService } from "../../services/ImapService";
import type { IImapCommand } from "../types";

/**
 * Delete specific messages by UID.
 */
export class DeleteMessagesCommand implements IImapCommand {
	readonly name = "DeleteMessages";
	constructor(
		private readonly uids: number[],
		private readonly mailbox: string = "INBOX",
	) {}

	async execute(service: ImapService) {
		return service.deleteMessages(this.uids, this.mailbox);
	}
}

/**
 * Delete ALL messages in a mailbox.
 */
export class DeleteAllMessagesCommand implements IImapCommand {
	readonly name = "DeleteAllMessages";
	constructor(private readonly mailbox: string = "INBOX") {}

	async execute(service: ImapService) {
		return service.deleteAllMessages(this.mailbox);
	}
}

/**
 * Move messages from one mailbox to another.
 * Uses MOVE extension (RFC 6851) when available, falls back to COPY+DELETE.
 */
export class MoveMessagesCommand implements IImapCommand {
	readonly name = "MoveMessages";
	constructor(
		private readonly uids: number[],
		private readonly from: string,
		private readonly to: string,
	) {}

	async execute(service: ImapService) {
		// Use safe move — auto-falls back when MOVE not supported
		return service.moveMessageSafe(this.uids, this.from, this.to);
	}
}

/**
 * Move ALL messages from one mailbox to another.
 */
export class MoveAllMessagesCommand implements IImapCommand {
	readonly name = "MoveAllMessages";
	constructor(
		private readonly from: string,
		private readonly to: string,
	) {}

	async execute(service: ImapService) {
		return service.moveAllMessages(this.from, this.to);
	}
}

/**
 * Copy messages to another mailbox (without removing from source).
 */
export class CopyMessagesCommand implements IImapCommand {
	readonly name = "CopyMessages";
	constructor(
		private readonly uids: number[],
		private readonly destination: string,
	) {}

	async execute(service: ImapService) {
		return service.copyMailToOtherMailbox(this.uids, this.destination);
	}
}
