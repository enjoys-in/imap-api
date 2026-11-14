export enum ImapStreamEvent {
	CONNECTED = "connected",
	MAILBOX_CHANGE = "mailbox:change",
	MAILBOX_EXPUNGE = "mailbox:expunge",
	MESSAGE_FLAGS = "message:flags",
	QUOTA_UPDATE = "quota:update",
	WARNING = "warning",
	SYNC_START = "sync:start",
	SYNC_FOLDER = "sync:folder",
	SYNC_COMPLETE = "sync:complete",
}
