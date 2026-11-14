import type { ImapService } from "../../services/ImapService";
import type { IImapCommand } from "../types";

/**
 * Fetch messages from a mailbox with pagination.
 */
export class FetchMessagesCommand implements IImapCommand {
	readonly name = "FetchMessages";
	constructor(
		private readonly mailbox: string,
		private readonly offset: number,
	) {}

	async execute(service: ImapService) {
		return service.selectMailbox(this.mailbox, this.offset);
	}
}

/**
 * Fetch a single message body (raw or parsed).
 */
export class FetchMessageBodyCommand implements IImapCommand {
	readonly name = "FetchMessageBody";
	constructor(
		private readonly mailbox: string,
		private readonly uid: string,
		private readonly parsed: boolean = false,
	) {}

	async execute(service: ImapService) {
		return service.fetchMessageBody(this.mailbox, this.uid, this.parsed);
	}
}

/**
 * List all mailboxes.
 */
export class ListMailboxesCommand implements IImapCommand {
	readonly name = "ListMailboxes";

	async execute(service: ImapService) {
		return service.listMailboxes();
	}
}

/**
 * Sync folder list with unseen counts.
 */
export class SyncFoldersCommand implements IImapCommand {
	readonly name = "SyncFolders";

	async execute(service: ImapService) {
		return service.syncFolders();
	}
}

/**
 * Full global sync across all mailboxes.
 */
export class GlobalSyncCommand implements IImapCommand {
	readonly name = "GlobalSync";
	constructor(private readonly email: string) {}

	async execute(service: ImapService) {
		return service.globalSync(this.email);
	}
}

/**
 * List unseen (unread) message UIDs.
 */
export class ListUnseenCommand implements IImapCommand {
	readonly name = "ListUnseen";

	async execute(service: ImapService) {
		return service.listUnseenOnly();
	}
}
