import { ImapCapability } from "../../services/CapabilityManager";
import type { ImapService } from "../../services/ImapService";
import type { IImapCommand } from "../types";

/**
 * Create a new mailbox.
 */
export class CreateMailboxCommand implements IImapCommand {
	readonly name = "CreateMailbox";
	constructor(private readonly mailbox: string) {}

	async execute(service: ImapService) {
		return service.createMailbox(this.mailbox);
	}
}

/**
 * Delete a mailbox.
 */
export class DeleteMailboxCommand implements IImapCommand {
	readonly name = "DeleteMailbox";
	constructor(private readonly mailbox: string) {}

	async execute(service: ImapService) {
		return service.deleteMailbox(this.mailbox);
	}
}

/**
 * Rename a mailbox.
 */
export class RenameMailboxCommand implements IImapCommand {
	readonly name = "RenameMailbox";
	constructor(
		private readonly oldName: string,
		private readonly newName: string,
	) {}

	async execute(service: ImapService) {
		return service.renameMailbox(this.oldName, this.newName);
	}
}

/**
 * Subscribe to a mailbox.
 */
export class SubscribeMailboxCommand implements IImapCommand {
	readonly name = "SubscribeMailbox";
	constructor(private readonly mailbox: string) {}

	async execute(service: ImapService) {
		return service.subscribeMailbox(this.mailbox);
	}
}

/**
 * Unsubscribe from a mailbox.
 */
export class UnsubscribeMailboxCommand implements IImapCommand {
	readonly name = "UnsubscribeMailbox";
	constructor(private readonly mailbox: string) {}

	async execute(service: ImapService) {
		return service.unsubscribeMailbox(this.mailbox);
	}
}

/**
 * Get mailbox status (message count, unseen, uidNext, etc.).
 */
export class MailboxStatusCommand implements IImapCommand {
	readonly name = "MailboxStatus";
	constructor(private readonly mailbox: string) {}

	async execute(service: ImapService) {
		return service.getMailboxStatus(this.mailbox);
	}
}

/**
 * Get mailbox quota information.
 * Requires QUOTA capability (RFC 2087).
 */
export class MailboxQuotaCommand implements IImapCommand {
	readonly name = "MailboxQuota";
	constructor(private readonly mailbox: string) {}

	async execute(service: ImapService) {
		service.requireCapability(ImapCapability.QUOTA, this.name);
		return service.getQuota(this.mailbox);
	}
}
