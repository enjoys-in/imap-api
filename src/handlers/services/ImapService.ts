import { Logging } from "@/logs";
import type { ImapConfig } from "@/utils/interfaces/imap.interface";
import {
	type FetchMessageObject,
	type FetchQueryObject,
	ImapFlow,
	type ListResponse,
	type ListTreeResponse,
	type MessageEnvelopeObject,
	type MessageStructureObject,
	type SearchObject,
} from "imapflow";
import { type ParsedMail, simpleParser } from "mailparser";
import {
	CapabilityManager,
	CapabilityNotSupportedError,
	ImapCapability,
} from "./CapabilityManager";

const MESSAGE_QUERY: FetchQueryObject = {
	envelope: true,
	uid: true,
	flags: true,
	bodyStructure: true,
	size: true,
};

function collectAttachments(
	structure: MessageStructureObject | undefined,
	found: { filename: string; mimeType: string }[],
) {
	if (!structure) {
		return;
	}
	if (structure.disposition === "attachment") {
		found.push({
			filename:
				structure.dispositionParameters?.filename ||
				structure.parameters?.name ||
				"unnamed",
			mimeType: structure.type,
		});
	}
	for (const child of structure.childNodes ?? []) {
		collectAttachments(child, found);
	}
}

export function toEmailSummary(message: FetchMessageObject) {
	const attachments: { filename: string; mimeType: string }[] = [];
	collectAttachments(message.bodyStructure, attachments);
	return {
		message_id: message.envelope?.messageId,
		uid: message.uid,
		type: message.bodyStructure?.type,
		size: message.size ?? message.bodyStructure?.size,
		subject: message.envelope?.subject,
		from: message.envelope?.from?.map((f) => f.address).join(", "),
		to: message.envelope?.to?.map((t) => t.address).join(", "),
		date: message.envelope?.date,
		flags: message.flags,
		attachments,
	};
}

export type EmailSummary = ReturnType<typeof toEmailSummary>;

export interface MailboxSession {
	info: {
		exists: number;
		uidNext: number;
		uidValidity: number;
		highestModseq: string | null;
	};
	fetch(range: string, byUid: boolean): Promise<EmailSummary[]>;
	flags(uids: number[]): Promise<Map<number, string[]>>;
	search(query: SearchObject): Promise<number[]>;
}

export class ImapService {
	private client!: ImapFlow;
	private _capabilities!: CapabilityManager;
	private config: ImapConfig;

	constructor(config: ImapConfig) {
		this.config = config;
		this.initClient();
	}

	/**
	 * Re-initializes the underlying ImapFlow client if closed or previously connected.
	 * ImapFlow does not allow re-using an instance once connect() has been called.
	 */
	private initClient(): void {
		if (this.client) {
			try {
				this.client.removeAllListeners?.();
				if (this.client.usable) {
					this.client.close();
				}
			} catch (_) {}
		}
		this.client = new ImapFlow({
			host: this.config.imap_host,
			port: this.config.imap_port,
			logger: false,
			secure: !!this.config?.imap_secure,
			auth: {
				user: this.config.imap_username,
				pass: this.config.imap_password,
			},
		});

		// Attach default error handler so socket errors on idle connections don't crash the process
		this.client.on("error", (err) => {
			Logging.dev(
				`[ImapFlow] Connection error for ${this.config.imap_username}: ${err?.message || err}`,
			);
		});

		this._capabilities = new CapabilityManager(this.client);
	}

	getConnection() {
		return this.client;
	}

	/**
	 * The CapabilityManager for this connection.
	 */
	get capabilities(): CapabilityManager {
		return this._capabilities;
	}

	/**
	 * Connect and authenticate, probing capabilities at both phases.
	 *
	 * ImapFlow's `connect()` opens the socket **and** authenticates in one call.
	 * The server greeting already populates `client.capabilities` (pre-login set).
	 * After authentication the server typically sends an updated capability list
	 * which ImapFlow stores automatically.
	 *
	 * We capture snapshots at both moments so the CapabilityManager can track
	 * what changed.
	 */
	async authenticate() {
		// If connection is already authenticated and usable, reuse immediately!
		if (this.isConnected()) {
			return;
		}

		// ImapFlow strictly prohibits re-using an instance once connect() has been called.
		// If connect was previously called or client is not usable, create a fresh ImapFlow instance:
		if ((this.client as any)?._connectCalled || !this.client.usable) {
			this.initClient();
		}

		// ImapFlow populates greeting caps during connect — snapshot them as "pre-login"
		await this.client.connect();

		// After connect() completes, the client is already authenticated.
		// Capture the post-login snapshot as well.
		this._capabilities.probePostLogin();
	}

	async logout() {
		try {
			if (this.client && this.client.usable) {
				return await this.client.logout();
			}
		} catch (_) {}
	}

	async closeConnection() {
		try {
			if (this.client) {
				this.client.close();
			}
		} catch (_) {}
	}

	/**
	 * Require a capability before executing an operation. Throws
	 * `CapabilityNotSupportedError` when the server doesn't advertise it.
	 */
	requireCapability(
		cap: ImapCapability | string,
		operationName?: string,
	): void {
		this._capabilities.require(cap, operationName);
	}
	async listMailboxes() {
		return this.client.list();
	}
	isSelectable(mailbox: ListResponse): boolean {
		const flags = Array.from(mailbox.flags ?? [], (f) =>
			String(f).toLowerCase(),
		);
		return !flags.includes("\\noselect") && !flags.includes("\\nonexistent");
	}
	async openedMailbox(mailbox = "INBOX") {
		return this.client.mailboxOpen(mailbox);
	}
	async globalSync(email: string) {
		const emails: any = {};
		if (!this.client.authenticated) {
			await this.authenticate();
		}
		const mailboxList = await this.listMailboxes();
		for (const mailbox of mailboxList) {
			if (!this.isSelectable(mailbox)) {
				emails[mailbox.name] = {
					info: mailbox,
					total_count: 0,
					uidNext: null,
					unseen_count: 0,
					emails: [],
					hasMore: false,
				};
				continue;
			}
			const data = await this.selectMailbox(mailbox.path);
			const searchResult =
				data.totalCount > 0 ? await this.listUnseenOnly() : [];
			emails[mailbox.name] = {
				info: mailbox,
				total_count: data.totalCount,
				uidNext: data.uidNext,
				unseen_count: Array.isArray(searchResult) ? searchResult.length : 0,
				emails: data.emails.reverse(),
				hasMore: data.hasMore,
			};
		}
		return {
			email,
			mailboxList,
			messages: emails,
		};
	}
	async syncFolders(): Promise<
		| ({
				total_count: string;
				unseen_count: string;
		  } & ListResponse)[]
		| null
	> {
		const mailboxList = await this.listMailboxes();
		const response: any[] = [];
		let id = 1;
		for (const mailbox of mailboxList) {
			let totalCount = 0;
			let unseenCount = 0;
			let uidValidity: number | null = null;
			let uidNext: number | null = null;
			let highestModseq: string | null = null;

			if (this.isSelectable(mailbox)) {
				const lock = await this.client.getMailboxLock(mailbox.path, {});
				try {
					const opened = this.client.mailbox;
					if (opened) {
						totalCount = opened.exists;
						uidValidity = opened.uidValidity ? Number(opened.uidValidity) : null;
						uidNext = opened.uidNext ?? null;
						highestModseq = opened.highestModseq
							? String(opened.highestModseq)
							: null;
					}
					if (totalCount > 0) {
						const unseen = await this.listUnseenOnly();
						unseenCount = Array.isArray(unseen) ? unseen.length : 0;
					}
				} finally {
					lock.release();
				}
			}

			response.push({
				id,
				...mailbox,
				total_count: totalCount,
				unseen_count: unseenCount,
				uidValidity,
				uidNext,
				highestModseq,
			});
			id++;
		}
		return response;
	}
	async syncEmailsInMailbox(mailbox = "INBOX") {
		return this.selectMailbox(mailbox);
	}
	async synceSingleFolder(mailbox = "INBOX") {
		const emails = await this.openedMailbox(mailbox);
		const unseenCount = await this.listUnseenOnly();
		return {
			path: emails.path,
			name: mailbox,
			delimiter: emails.delimiter,
			flags: emails.flags,
			specialUse: emails.specialUse,
			listed: emails.listed,
			subscribed: emails.subscribed,
			total_count: emails.exists,
			unseen_count: Array.isArray(unseenCount) ? unseenCount.length : 0,
			uidNext: emails.uidNext,
			uidValidity: Number(emails.uidValidity),
			highestModseq: emails.highestModseq
				? String(emails.highestModseq)
				: undefined,
		};
	}
	async selectMailbox(mailbox = "INBOX", offset = 0, limit = 50) {
		const {
			exists: totalCount,
			uidNext,
			uidValidity,
			flags,
		} = await this.client.mailboxOpen(mailbox);
		const emails: EmailSummary[] = [];

		const skip = Math.max(0, Math.floor(Number(offset) || 0));
		const size = Math.max(1, Math.floor(Number(limit) || 50));
		const endSeq = totalCount - skip;

		if (endSeq < 1) {
			return {
				emails,
				totalCount,
				hasMore: false,
				uidNext,
				uidValidity,
				flags,
			};
		}

		const startSeq = Math.max(endSeq - size + 1, 1);
		const range = `${startSeq}:${endSeq}`;
		const lock = await this.client.getMailboxLock(mailbox, {});
		try {
			for await (const message of this.client.fetch(range, MESSAGE_QUERY)) {
				emails.push(toEmailSummary(message));
			}
		} finally {
			lock.release();
		}

		return {
			emails,
			totalCount,
			hasMore: startSeq > 1,
			uidNext,
			uidValidity,
			flags,
		};
	}
	async withMailbox<T>(
		path: string,
		run: (box: MailboxSession) => Promise<T>,
	): Promise<T> {
		const lock = await this.client.getMailboxLock(path, {});
		try {
			const opened = await this.client.mailboxOpen(path);
			return await run({
				info: {
					exists: opened.exists,
					uidNext: opened.uidNext,
					uidValidity: Number(opened.uidValidity),
					highestModseq: opened.highestModseq
						? String(opened.highestModseq)
						: null,
				},
				fetch: async (range, byUid) => {
					const found: EmailSummary[] = [];
					for await (const message of this.client.fetch(range, MESSAGE_QUERY, {
						uid: byUid,
					})) {
						found.push(toEmailSummary(message));
					}
					return found;
				},
				flags: async (uids) => {
					const current = new Map<number, string[]>();
					if (uids.length === 0) {
						return current;
					}
					for await (const message of this.client.fetch(
						uids.join(","),
						{ uid: true, flags: true },
						{ uid: true },
					)) {
						current.set(message.uid, Array.from(message.flags ?? []));
					}
					return current;
				},
				search: async (query) => {
					const found = await this.client.search(query, { uid: true });
					return Array.isArray(found) ? found : [];
				},
			});
		} finally {
			lock.release();
		}
	}
	async listUnseenOnly() {
		return this.client.search({ seen: false }, { uid: true });
	}
	async searchMailbox() {
		return this.client.search({ seen: false }, { uid: true });
	}

	async fetchMessages(mailbox = "INBOX") {
		const opened = await this.client.mailboxOpen(mailbox);
		const messages: FetchMessageObject[] = [];
		if (!opened.exists) {
			return messages;
		}
		for await (const msg of this.client.fetch("1:*", {
			envelope: true,
			uid: true,
			flags: true,
		})) {
			messages.push(msg);
		}
		return messages;
	}
	async fetchMessageBody(mailbox: string, uid: string, is_parsed = false) {
		await this.client.mailboxOpen(mailbox);
		const source = await this.client.download(uid);

		let mailchunks: any = null;

		if (is_parsed) {
			mailchunks = await simpleParser(source.content);
		} else {
			mailchunks = ""; // initialize as empty string
			await new Promise((resolve, reject) => {
				source.content.on("data", (chunk) => {
					mailchunks += chunk.toString();
				});
				source.content.on("end", resolve);
				source.content.on("error", reject);
			});
		}

		return mailchunks;
	}
	async fetchMessageHeaders(
		mailbox: string,
		uid: string,
		headerKeys?: string[],
	) {
		await this.client.mailboxOpen(mailbox);
		const msg = await this.client.fetchOne(
			uid,
			{
				uid: true,
				headers: headerKeys ?? true,
			},
			{ uid: true },
		);
		if (!msg) return null;
		return {
			uid: msg.uid,
			headers: msg.headers?.toString() ?? null,
		};
	}

	/**
	 * Download a specific attachment by its MIME part number.
	 * The part number comes from `bodyStructure.part` in a fetch response.
	 */
	async fetchMessageAttachments(mailbox: string, uid: string, partId: string) {
		await this.client.mailboxOpen(mailbox);
		const download = await this.client.download(uid, partId, { uid: true });
		const chunks: Buffer[] = [];
		await new Promise<void>((resolve, reject) => {
			download.content.on("data", (chunk: Buffer) => chunks.push(chunk));
			download.content.on("end", resolve);
			download.content.on("error", reject);
		});
		return {
			meta: download.meta,
			content: Buffer.concat(chunks),
		};
	}

	/**
	 * Download multiple attachment parts at once.
	 */
	async downloadManyAttachments(
		mailbox: string,
		uid: string,
		partIds: string[],
	) {
		await this.client.mailboxOpen(mailbox);
		return this.client.downloadMany(uid, partIds, { uid: true });
	}

	/**
	 * Flexible search with any combination of IMAP search criteria.
	 *
	 * @example
	 *   // Unread messages from a specific sender
	 *   searchMessages("INBOX", { seen: false, from: "alice@example.com" })
	 *
	 *   // Messages since a date, larger than 1MB
	 *   searchMessages("INBOX", { since: new Date("2025-01-01"), larger: 1048576 })
	 */
	async searchMessages(
		mailbox: string,
		query: SearchObject,
		useUid = true,
	): Promise<number[] | false> {
		await this.client.mailboxOpen(mailbox);
		return this.client.search(query, { uid: useUid });
	}

	/**
	 * Fetch specific messages by a list of UIDs.
	 */
	async fetchMessagesByUids(
		mailbox: string,
		uids: number[],
		query: FetchQueryObject = {
			envelope: true,
			uid: true,
			flags: true,
			bodyStructure: true,
		},
	): Promise<FetchMessageObject[]> {
		await this.client.mailboxOpen(mailbox);
		return this.client.fetchAll(uids, query, { uid: true });
	}

	/**
	 * Fetch detailed enriched email message summaries for a list of UIDs.
	 */
	async fetchDetailedMessagesByUids(mailbox: string, uids: number[]) {
		if (!uids || uids.length === 0) return [];
		await this.client.mailboxOpen(mailbox);
		const lock = await this.client.getMailboxLock(mailbox, {});
		const emails: any[] = [];
		try {
			const checkForAttachments = (structure: any, attachments: any[]) => {
				if (Array.isArray(structure)) {
					for (const part of structure) {
						checkForAttachments(part, attachments);
					}
				} else if (structure) {
					if (
						structure.disposition &&
						structure.disposition.type?.toLowerCase() === "attachment"
					) {
						attachments.push({
							filename:
								structure.disposition?.params?.filename ||
								structure.parameters?.name ||
								"unnamed",
							mimeType: `${structure.type}/${structure.subtype}`,
						});
					}
				}
			};

			for await (const message of this.client.fetch(
				uids,
				{
					envelope: true,
					uid: true,
					flags: true,
					bodyStructure: true,
				},
				{ uid: true },
			)) {
				const attachments: any[] = [];
				checkForAttachments(message.bodyStructure, attachments);

				emails.push({
					message_id: message?.envelope?.messageId,
					uid: message.uid,
					type: message.bodyStructure?.type,
					size: message.bodyStructure?.size,
					subject: message?.envelope?.subject,
					from: message?.envelope?.from?.map((f: any) => f.address).join(", "),
					to: message?.envelope?.to?.map((t: any) => t.address).join(", "),
					date: message?.envelope?.date,
					flags: message.flags,
					attachments,
				});
			}
		} finally {
			lock.release();
		}
		return emails;
	}

	/**
	 * Append (upload) a message to a mailbox. Useful for saving drafts or
	 * copying a composed message to the Sent folder.
	 */
	async appendMessage(
		mailbox: string,
		rawMessage: string | Buffer,
		flags?: string[],
		internalDate?: Date | string,
	) {
		return this.client.append(mailbox, rawMessage, flags, internalDate);
	}

	/**
	 * List mailboxes as a tree structure (parent → children hierarchy).
	 */
	async listMailboxTree(): Promise<ListTreeResponse> {
		return this.client.listTree();
	}

	/**
	 * List only subscribed mailboxes (uses LIST with SUBSCRIBED return).
	 * Falls back to full list if LIST-EXTENDED is unavailable.
	 */
	async listSubscribedMailboxes(): Promise<ListResponse[]> {
		const allBoxes = await this.client.list();
		return allBoxes.filter((box) => box.subscribed);
	}

	/**
	 * Set custom flags (keywords) on messages — e.g. $Starred, $Important.
	 */
	async setCustomFlags(uids: number[], flags: string[]) {
		return this.client.messageFlagsAdd(uids, flags);
	}

	/**
	 * Remove custom flags (keywords) from messages.
	 */
	async removeCustomFlags(uids: number[], flags: string[]) {
		return this.client.messageFlagsRemove(uids, flags);
	}

	/**
	 * Replace all flags on messages with the given set.
	 */
	async setFlags(uids: number[], flags: string[]) {
		return this.client.messageFlagsSet(uids, flags);
	}

	/**
	 * Get server identification info (RFC 2971 ID extension).
	 */
	async getServerInfo() {
		if (!this._capabilities.supports(ImapCapability.ID)) {
			return null;
		}
		return this.client.serverInfo;
	}

	/**
	 * Send a NOOP command. Useful for keep-alive or triggering
	 * pending server notifications.
	 */
	async noop() {
		return this.client.noop();
	}

	/**
	 * Get connection statistics (bytes sent/received).
	 */
	getConnectionStats(reset = false) {
		return this.client.stats(reset);
	}

	/**
	 * Check if the connection is currently authenticated and usable.
	 */
	isConnected(): boolean {
		return !!this.client.authenticated && this.client.usable;
	}

	/**
	 * Check if the connection is currently idling.
	 */
	isIdling(): boolean {
		return this.client.idling;
	}

	/**
	 * Get the currently selected mailbox (or false if none).
	 */
	getCurrentMailbox() {
		return this.client.mailbox;
	}

	async deleteMessages(uids: number[], mailbox = "INBOX") {
		await this.client.mailboxOpen(mailbox);
		return this.client.messageDelete(uids);
	}
	async deleteAllMessages(mailbox = "INBOX") {
		await this.client.mailboxOpen(mailbox);
		const uids = [];
		for await (const msg of this.client.fetch("1:*", { uid: true })) {
			uids.push(msg.uid);
		}
		if (uids.length) {
			await this.client.messageDelete(uids);
		}
	}
	async moveMessage(
		uid: number[],
		currentMailbox: string,
		targetMailbox: string,
	) {
		await this.client.mailboxOpen(currentMailbox);
		await this.client.messageMove(uid, targetMailbox);
	}

	async moveAllMessages(currentMailbox: string, targetMailbox: string) {
		await this.client.mailboxOpen(currentMailbox);
		const uids = [];
		for await (const msg of this.client.fetch("1:*", { uid: true })) {
			uids.push(msg.uid);
		}
		if (uids.length) {
			await this.client.messageMove(uids, targetMailbox);
		}
	}
	async copyMailToOtherMailbox(uid: number[], destination: string) {
		return this.client.messageCopy(uid, destination);
	}

	async markAsRead(uid: number[]) {
		return this.client.messageFlagsAdd(uid, ["\\Seen"]);
	}
	async markAsUnread(uid: number[]) {
		return this.client.messageFlagsRemove(uid, ["\\Seen"]);
	}
	async markAllAsRead(mailbox: string) {
		await this.client.mailboxOpen(mailbox); // Select mailbox
		const uids = await this.client.search({ seen: false }); // Find unread
		if (!Array.isArray(uids) || uids.length === 0)
			return "No unread messages in this mailbox.";
		return this.markAsRead(uids);
	}

	async markAllAsUnread(mailbox: string) {
		await this.client.mailboxOpen(mailbox); // Select mailbox
		const uids = await this.client.search({ seen: true }); // Find read
		if (!Array.isArray(uids) || uids.length === 0)
			return "All messages are already unread.";
		return this.markAsUnread(uids);
	}
	async createMailbox(mailbox: string) {
		return this.client.mailboxCreate(mailbox);
	}

	async deleteMailbox(mailbox: string) {
		return this.client.mailboxDelete(mailbox);
	}

	async renameMailbox(oldName: string, newName: string) {
		return this.client.mailboxRename(oldName, newName);
	}

	async subscribeMailbox(mailbox: string) {
		return this.client.mailboxSubscribe(mailbox);
	}

	async unsubscribeMailbox(mailbox: string) {
		return this.client.mailboxUnsubscribe(mailbox);
	}

	async listMailboxStatuses() {
		const mailboxes = [];
		for await (const box of await this.client.list()) {
			mailboxes.push(box);
		}
		return mailboxes;
	}

	async getMailboxStatus(mailbox: string) {
		return this.client.status(mailbox, {
			messages: true,
			recent: true,
			unseen: true,
			uidNext: true,
			uidValidity: true,
		});
	}

	// ----------- Quota Management -----------

	async getQuota(mailbox: string) {
		this.requireCapability(ImapCapability.QUOTA, "getQuota");
		return this.client.getQuota(mailbox);
	}

	// ----------- Capability-Guarded Operations -----------

	/**
	 * Start IMAP IDLE on the currently selected mailbox.
	 * Requires the IDLE capability (RFC 2177).
	 */
	async startIdle(): Promise<boolean> {
		this.requireCapability(ImapCapability.IDLE, "startIdle");
		return this.client.idle();
	}

	/**
	 * Move messages using the MOVE extension (RFC 6851).
	 * Falls back to COPY+DELETE when MOVE is not available.
	 */
	async moveMessageSafe(
		uid: number[],
		currentMailbox: string,
		targetMailbox: string,
	) {
		await this.client.mailboxOpen(currentMailbox);
		if (this._capabilities.supports(ImapCapability.MOVE)) {
			return this.client.messageMove(uid, targetMailbox);
		}
		// Fallback: COPY + mark \Deleted + EXPUNGE
		await this.client.messageCopy(uid, targetMailbox);
		await this.client.messageFlagsAdd(uid, ["\\Deleted"]);
		// Note: ImapFlow doesn't expose raw EXPUNGE; messageDelete handles it
		return true;
	}

	// ----------- Event Registration & Cleanup -----------

	public lastActivity: number = Date.now();

	public touch() {
		this.lastActivity = Date.now();
	}

	/**
	 * Register a listener for the `exists` event (new message count change).
	 * Fires when the number of messages in the currently selected mailbox changes.
	 */
	onNewMessage(
		handler: (data: { path: string; count: number; prevCount: number }) => void,
	) {
		this.client.on("exists", handler);
		return this;
	}

	/**
	 * Remove a listener for the `exists` event to prevent memory leaks.
	 */
	offNewMessage(
		handler: (data: { path: string; count: number; prevCount: number }) => void,
	) {
		this.client.off("exists", handler);
		return this;
	}

	/**
	 * Register a listener for the `expunge` event (message deleted on server).
	 */
	onMessageExpunged(
		handler: (data: {
			path: string;
			seq?: number;
			uid?: number;
			vanished: boolean;
		}) => void,
	) {
		this.client.on("expunge", handler);
		return this;
	}

	/**
	 * Remove a listener for the `expunge` event to prevent memory leaks.
	 */
	offMessageExpunged(
		handler: (data: {
			path: string;
			seq?: number;
			uid?: number;
			vanished: boolean;
		}) => void,
	) {
		this.client.off("expunge", handler);
		return this;
	}

	/**
	 * Register a listener for the `flags` event (flags updated on a message).
	 */
	onFlagsUpdated(
		handler: (data: {
			path: string;
			seq: number;
			uid?: number;
			flags: Set<string>;
		}) => void,
	) {
		this.client.on("flags", handler);
		return this;
	}

	/**
	 * Remove a listener for the `flags` event to prevent memory leaks.
	 */
	offFlagsUpdated(
		handler: (data: {
			path: string;
			seq: number;
			uid?: number;
			flags: Set<string>;
		}) => void,
	) {
		this.client.off("flags", handler);
		return this;
	}

	/**
	 * Register a listener for connection close.
	 */
	onClose(handler: () => void) {
		this.client.on("close", handler);
		return this;
	}

	/**
	 * Remove a listener for connection close.
	 */
	offClose(handler: () => void) {
		this.client.off("close", handler);
		return this;
	}

	/**
	 * Register a listener for connection errors.
	 */
	onError(handler: (error: Error) => void) {
		this.client.on("error", handler);
		return this;
	}

	/**
	 * Remove a listener for connection errors.
	 */
	offError(handler: (error: Error) => void) {
		this.client.off("error", handler);
		return this;
	}

	/**
	 * Fetches lightweight envelope and parsed headers for the latest inbound message
	 * in a mailbox (used for vacation reply evaluation and push notifications).
	 */
	async fetchLatestMessageContext(mailbox = "INBOX"): Promise<{
		fromAddress: string;
		toAddress?: string;
		subject: string;
		messageId?: string;
		headers?: Record<string, string | string[] | undefined>;
	} | null> {
		try {
			await this.client.mailboxOpen(mailbox);
			const status = await this.client.status(mailbox, { messages: true });
			const total = status.messages || 0;
			if (total === 0) return null;

			const msg = await this.client.fetchOne(`${total}`, {
				envelope: true,
				headers: true,
			});
			if (!msg || !msg.envelope) return null;

			const fromAddress = msg.envelope.from?.[0]?.address || "";
			const toAddress = msg.envelope.to?.[0]?.address || "";
			const subject = msg.envelope.subject || "";
			const messageId = msg.envelope.messageId || "";

			// Parse raw headers buffer into key-value map if present
			const parsedHeaders: Record<string, string> = {};
			if (msg.headers) {
				const headerStr = msg.headers.toString("utf8");
				const lines = headerStr.split(/\r?\n/);
				let currentHeader = "";
				for (const line of lines) {
					if (/^\s/.test(line)) {
						if (currentHeader) {
							parsedHeaders[currentHeader] += " " + line.trim();
						}
					} else {
						const colonIdx = line.indexOf(":");
						if (colonIdx > 0) {
							currentHeader = line.substring(0, colonIdx).trim().toLowerCase();
							parsedHeaders[currentHeader] = line
								.substring(colonIdx + 1)
								.trim();
						}
					}
				}
			}

			return {
				fromAddress,
				toAddress,
				subject,
				messageId,
				headers: parsedHeaders,
			};
		} catch (error: any) {
			Logging.dev(`[fetchLatestMessageContext] Error: ${error?.message}`);
			return null;
		}
	}

	/**
	 * Remove all event listeners to prevent memory leaks on cleanup.
	 */
	removeAllListeners() {
		this.client.removeAllListeners();
		return this;
	}
}
