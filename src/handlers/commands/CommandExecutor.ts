import type { ImapService } from "../services/ImapService";
import type { CommandResult, IImapCommand } from "./types";

/**
 * CommandExecutor — the invoker in the Command pattern.
 *
 * Responsibilities:
 *  - Execute any IImapCommand against an ImapService
 *  - Keep a history ring-buffer for undo / audit
 *  - Provide batch execution for multiple commands
 */
export class CommandExecutor {
	private history: CommandResult[] = [];
	private static readonly MAX_HISTORY = 200;

	constructor(private readonly service: ImapService) {}

	/**
	 * Run a single command and return a typed result envelope.
	 */
	async run<T>(command: IImapCommand<T>): Promise<CommandResult<T>> {
		const start = Date.now();
		try {
			const data = await command.execute(this.service);
			const result: CommandResult<T> = {
				command: command.name,
				success: true,
				data,
				executedAt: new Date(),
				durationMs: Date.now() - start,
			};
			this.pushHistory(result);
			return result;
		} catch (err: any) {
			const result: CommandResult<T> = {
				command: command.name,
				success: false,
				data: null,
				error: err?.message ?? String(err),
				executedAt: new Date(),
				durationMs: Date.now() - start,
			};
			this.pushHistory(result);
			throw err;
		}
	}

	/**
	 * Run multiple commands sequentially and return all results.
	 */
	async runBatch(commands: IImapCommand[]): Promise<CommandResult[]> {
		const results: CommandResult[] = [];
		for (const cmd of commands) {
			results.push(await this.run(cmd));
		}
		return results;
	}

	/**
	 * Return the recent command history (newest first).
	 */
	getHistory(limit = 50): CommandResult[] {
		return this.history.slice(-limit).reverse();
	}

	private pushHistory(entry: CommandResult): void {
		this.history.push(entry);
		if (this.history.length > CommandExecutor.MAX_HISTORY) {
			this.history = this.history.slice(-CommandExecutor.MAX_HISTORY);
		}
	}
}
