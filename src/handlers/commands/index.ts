// ── Command Pattern Infrastructure ──
export { CommandExecutor } from "./CommandExecutor";
export type { CommandResult, IImapCommand } from "./types";

// ── Fetch Commands ──
export {
	FetchMessageBodyCommand,
	FetchMessagesCommand,
	GlobalSyncCommand,
	ListMailboxesCommand,
	ListUnseenCommand,
	SyncFoldersCommand,
} from "./impl/FetchCommands";

// ── Flag Commands ──
export {
	MarkAllAsReadCommand,
	MarkAllAsUnreadCommand,
	MarkAsReadCommand,
	MarkAsUnreadCommand,
} from "./impl/FlagCommands";

// ── Message Commands ──
export {
	CopyMessagesCommand,
	DeleteAllMessagesCommand,
	DeleteMessagesCommand,
	MoveAllMessagesCommand,
	MoveMessagesCommand,
} from "./impl/MessageCommands";

// ── Mailbox Commands ──
export {
	CreateMailboxCommand,
	DeleteMailboxCommand,
	MailboxQuotaCommand,
	MailboxStatusCommand,
	RenameMailboxCommand,
	SubscribeMailboxCommand,
	UnsubscribeMailboxCommand,
} from "./impl/MailboxCommands";
