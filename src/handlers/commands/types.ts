import type { ImapService } from "../services/ImapService";

/**
 * Command Pattern — every IMAP operation implements this interface.
 * Commands are self-contained, serialisable descriptions of work.
 */
export interface IImapCommand<TResult = unknown> {
	/** Human-readable name for logging / audit */
	readonly name: string;
	execute(service: ImapService): Promise<TResult>;
}

/**
 * Metadata returned alongside a command result for audit/logging.
 */
export interface CommandResult<T = unknown> {
	command: string;
	success: boolean;
	data: T | null;
	error?: string;
	executedAt: Date;
	durationMs: number;
}
