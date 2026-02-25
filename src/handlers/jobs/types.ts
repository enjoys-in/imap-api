/**
 * Job types that should run in the background instead of blocking
 * the HTTP response. These are heavy / destructive operations the
 * frontend doesn't need an immediate result for.
 */
export enum ImapJobType {
	/** Delete specific messages by UID */
	DELETE_MESSAGES = "imap:delete_messages",
	/** Delete ALL messages in a mailbox */
	DELETE_ALL_MESSAGES = "imap:delete_all_messages",
	/** Move ALL messages between mailboxes */
	MOVE_ALL_MESSAGES = "imap:move_all_messages",
	/** Mark ALL messages as read in a mailbox */
	MARK_ALL_READ = "imap:mark_all_read",
	/** Mark ALL messages as unread in a mailbox */
	MARK_ALL_UNREAD = "imap:mark_all_unread",
	/** Full global sync across every mailbox */
	GLOBAL_SYNC = "imap:global_sync",
	/** Permanently expunge deleted messages */
	EXPUNGE_MAILBOX = "imap:expunge_mailbox",
	/** Bulk flag update on many messages */
	BULK_FLAG_UPDATE = "imap:bulk_flag_update",
}

export type ImapJobStatus = "queued" | "processing" | "completed" | "failed";

/**
 * Payload shape for each job type.
 */
export interface ImapJobPayloads {
	[ImapJobType.DELETE_MESSAGES]: {
		userEmail: string;
		uids: number[];
		mailbox: string;
	};
	[ImapJobType.DELETE_ALL_MESSAGES]: {
		userEmail: string;
		mailbox: string;
	};
	[ImapJobType.MOVE_ALL_MESSAGES]: {
		userEmail: string;
		fromMailbox: string;
		toMailbox: string;
	};
	[ImapJobType.MARK_ALL_READ]: {
		userEmail: string;
		mailbox: string;
	};
	[ImapJobType.MARK_ALL_UNREAD]: {
		userEmail: string;
		mailbox: string;
	};
	[ImapJobType.GLOBAL_SYNC]: {
		userEmail: string;
	};
	[ImapJobType.EXPUNGE_MAILBOX]: {
		userEmail: string;
		mailbox: string;
	};
	[ImapJobType.BULK_FLAG_UPDATE]: {
		userEmail: string;
		uids: number[];
		addFlags?: string[];
		removeFlags?: string[];
	};
}

/**
 * A single queued job.
 */
export interface ImapJob<T extends ImapJobType = ImapJobType> {
	id: string;
	type: T;
	payload: ImapJobPayloads[T];
	status: ImapJobStatus;
	createdAt: Date;
	startedAt?: Date;
	completedAt?: Date;
	error?: string;
	result?: unknown;
}
