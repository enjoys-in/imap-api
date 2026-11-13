import type { ImapConfig } from "@/utils/interfaces/imap.interface";
import {
	type FetchMessageObject,
	type FetchQueryObject,
	ImapFlow,
	type ListResponse,
	type ListTreeResponse,
	type MessageEnvelopeObject,
	type SearchObject,
} from "imapflow";
import { type ParsedMail, simpleParser } from "mailparser";
import {
	CapabilityManager,
	CapabilityNotSupportedError,
	ImapCapability,
} from "./CapabilityManager";

export class ImapService {
	private client: ImapFlow;
	private _capabilities: CapabilityManager;

	constructor(config: ImapConfig) {
		this.client = new ImapFlow({
			host: config.imap_host,
			port: config.imap_port,
			logger: false,
			secure: !!config?.imap_secure,
			auth: {
				user: config.imap_username,
				pass: config.imap_password,
			},
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
		// ImapFlow populates greeting caps during connect — snapshot them as "pre-login"
		await this.client.connect();

		// After connect() completes, the client is already authenticated.
		// Capture the post-login snapshot as well.
		this._capabilities.probePostLogin();
	}

	async logout() {
		return this.client.logout();
	}

	async closeConnection() {
		return this.client.close();
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
			const searchResult = await this.listUnseenOnly();
			const data = await this.selectMailbox(mailbox.path);
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
			const searchResult = await this.listUnseenOnly();
			const data = await this.selectMailbox(mailbox.path);
			response.push({
				id,
				...mailbox,
				total_count: data.totalCount,
				unseen_count: Array.isArray(searchResult) ? searchResult.length : 0,
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
		};
	}
	async selectMailbox(mailbox = "INBOX", start = 1) {
		const {
			exists: totalCount,
			uidNext,
			uidValidity,
			mailboxId,
			flags,
		} = await this.client.mailboxOpen(mailbox);
		const lock = await this.client.getMailboxLock(mailbox, {});
		const emails = [];
		const endSeq = totalCount - start;
		const startSeq = Math.max(endSeq - 50 + 1, 1);

		const range = `${startSeq}:${endSeq < 50 ? "*" : endSeq}`;
		try {
			const checkForAttachments = (structure: any, attachments: any[]) => {
				if (Array.isArray(structure)) {
					for (const part of structure) {
						checkForAttachments(part, attachments);
					}
				} else {
					if (
						structure.disposition &&
						structure.disposition.type?.toLowerCase() === "attachment"
					) {
						attachments.push({
							filename: structure.disposition?.params?.filename || "unnamed",
							mimeType: `${structure.type}/${structure.subtype}`,
						});
					}
				}
			};

			for await (const message of this.client.fetch(range, {
				envelope: true,
				uid: true,
				flags: true,
				bodyStructure: true,
			})) {
				const attachments: any[] = [];
				checkForAttachments(message.bodyStructure, attachments);

				emails.push({
					message_id: message?.envelope?.messageId,
					uid: message.uid,
					type: message.bodyStructure?.type,
					size: message.bodyStructure?.size,
					subject: message?.envelope?.subject,
					from: message?.envelope?.from?.map((f) => f.address).join(", "),
					to: message?.envelope?.to?.map((t) => t.address).join(", "),
					date: message?.envelope?.date,
					flags: message.flags,
					attachments,
				});
			}
		} finally {
			lock.release();
		}

		return {
			emails,
			totalCount,
			hasMore: endSeq - 50 > 0,
			uidNext,
			uidValidity,
			flags,
		};
	}
	async listUnseenOnly() {
		return this.client.search({ seen: false }, { uid: true });
	}
	async searchMailbox() {
		return this.client.search({ seen: false }, { uid: true });
	}

	async fetchMessages(mailbox = "INBOX") {
		await this.client.mailboxOpen(mailbox);
		const messages = [];
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
	 * Remove all event listeners to prevent memory leaks on cleanup.
	 */
	removeAllListeners() {
		this.client.removeAllListeners();
		return this;
	}
}
