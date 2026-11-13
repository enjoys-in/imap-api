import { TtlCache } from "./TtlCache";

/**
 * Domain-specific Cache Service for IMAP operations.
 * Caches expensive operations like folder lists, parsed MIME bodies,
 * server capabilities, and storage quotas with safe TTLs and automatic
 * invalidation on state mutations.
 */
export class ImapCacheService {
	// Folders cache: max 200 users, default TTL 30s
	private readonly folderCache = new TtlCache<any[]>({
		maxSize: 200,
		defaultTtlMs: 30 * 1000,
	});

	// Email bodies cache: max 1000 parsed messages, default TTL 10 minutes (600s)
	private readonly bodyCache = new TtlCache<any>({
		maxSize: 1000,
		defaultTtlMs: 10 * 60 * 1000,
	});

	// Quota cache: max 200 users, default TTL 60s
	private readonly quotaCache = new TtlCache<any>({
		maxSize: 200,
		defaultTtlMs: 60 * 1000,
	});

	// Capabilities cache: max 100 domains, default TTL 1 hour
	private readonly capabilityCache = new TtlCache<any>({
		maxSize: 100,
		defaultTtlMs: 60 * 60 * 1000,
	});

	// ── Mailboxes / Folders ──

	getMailboxes(email: string): any[] | undefined {
		return this.folderCache.get(`mailboxes:${email.toLowerCase()}`);
	}

	setMailboxes(email: string, mailboxes: any[], ttlSeconds = 30): void {
		this.folderCache.set(
			`mailboxes:${email.toLowerCase()}`,
			mailboxes,
			ttlSeconds,
		);
	}

	invalidateMailboxes(email: string): void {
		this.folderCache.delete(`mailboxes:${email.toLowerCase()}`);
	}

	// ── Email Bodies (Parsed MIME) ──

	getEmailBody(
		email: string,
		folder: string,
		uid: string | number,
	): any | undefined {
		const key = `body:${email.toLowerCase()}:${folder.toLowerCase()}:${uid}`;
		return this.bodyCache.get(key);
	}

	setEmailBody(
		email: string,
		folder: string,
		uid: string | number,
		bodyData: any,
		ttlSeconds = 600,
	): void {
		const key = `body:${email.toLowerCase()}:${folder.toLowerCase()}:${uid}`;
		this.bodyCache.set(key, bodyData, ttlSeconds);
	}

	invalidateEmailBody(
		email: string,
		folder?: string,
		uid?: string | number,
	): void {
		if (folder && uid !== undefined) {
			const key = `body:${email.toLowerCase()}:${folder.toLowerCase()}:${uid}`;
			this.bodyCache.delete(key);
		} else if (folder) {
			const prefix = `body:${email.toLowerCase()}:${folder.toLowerCase()}:`;
			this.bodyCache.deletePrefix(prefix);
		} else {
			const prefix = `body:${email.toLowerCase()}:`;
			this.bodyCache.deletePrefix(prefix);
		}
	}

	// ── Quota ──

	getQuota(email: string, folder = "INBOX"): any | undefined {
		const key = `quota:${email.toLowerCase()}:${folder.toLowerCase()}`;
		return this.quotaCache.get(key);
	}

	setQuota(
		email: string,
		folder = "INBOX",
		quotaData: any,
		ttlSeconds = 60,
	): void {
		const key = `quota:${email.toLowerCase()}:${folder.toLowerCase()}`;
		this.quotaCache.set(key, quotaData, ttlSeconds);
	}

	invalidateQuota(email: string): void {
		this.quotaCache.deletePrefix(`quota:${email.toLowerCase()}:`);
	}

	// ── Server Capabilities ──

	getCapabilities(email: string): any | undefined {
		return this.capabilityCache.get(`caps:${email.toLowerCase()}`);
	}

	setCapabilities(email: string, capabilities: any, ttlSeconds = 3600): void {
		this.capabilityCache.set(
			`caps:${email.toLowerCase()}`,
			capabilities,
			ttlSeconds,
		);
	}

	invalidateCapabilities(email: string): void {
		this.capabilityCache.delete(`caps:${email.toLowerCase()}`);
	}

	// ── Global Invalidation for User ──

	invalidateUser(email: string): void {
		this.invalidateMailboxes(email);
		this.invalidateEmailBody(email);
		this.invalidateQuota(email);
		this.invalidateCapabilities(email);
	}

	clearAll(): void {
		this.folderCache.clear();
		this.bodyCache.clear();
		this.quotaCache.clear();
		this.capabilityCache.clear();
	}
}

export const imapCache = new ImapCacheService();
