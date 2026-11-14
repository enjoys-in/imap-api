import { imapCache } from "../cache/ImapCacheService";
import { CapabilityNotSupportedError } from "./CapabilityManager";
import type { ImapService } from "./ImapService";
import { mailboxStorageService } from "./MailboxStorageService";

const QUOTA_DB_FRESH_MS = 5 * 60 * 1000;
const COUNTS_FRESH_MS = 30 * 1000;

export interface ClientQuota {
	storage: { used: number; limit: number; percentage: number };
	messages: { used: number; limit: number };
	mailbox: string;
	updatedAt: string;
}

export interface MailboxQuota {
	storage: ClientQuota["storage"] | null;
	messages: { used: number; limit: number | null };
	mailbox: string;
	updatedAt: string | null;
	unreadCount: number;
	totalCount: number;
}

export interface QuotaOverview {
	overall: {
		storage: ClientQuota["storage"];
		messages: ClientQuota["messages"];
		updatedAt: string;
	} | null;
	inbox: {
		mailbox: string;
		unreadCount: number;
		totalCount: number;
		storage: ClientQuota["storage"] | null;
		messages: { used: number; limit: number | null };
	};
}

type ImapProvider = () => Promise<ImapService>;

export class QuotaService {
	async getMailboxQuota(
		getImap: ImapProvider,
		userEmail: string,
		connectionId: number,
		mailbox: string,
		forceSync = false,
	): Promise<MailboxQuota> {
		const quota = await this.resolveQuota(
			getImap,
			userEmail,
			connectionId,
			mailbox,
			forceSync,
		);
		const counts = await this.folderCounts(
			getImap,
			connectionId,
			mailbox,
			forceSync,
		);

		if (quota) {
			return { ...quota, ...counts };
		}

		return {
			storage: null,
			messages: { used: await this.accountMessageCount(connectionId), limit: null },
			mailbox,
			updatedAt: null,
			...counts,
		};
	}

	async overview(
		getImap: ImapProvider,
		userEmail: string,
		connectionId: number,
	): Promise<QuotaOverview> {
		const inbox = await this.getMailboxQuota(
			getImap,
			userEmail,
			connectionId,
			"INBOX",
		);
		return {
			overall:
				inbox.storage && inbox.updatedAt
					? {
							storage: inbox.storage,
							messages: inbox.messages as ClientQuota["messages"],
							updatedAt: inbox.updatedAt,
						}
					: null,
			inbox: {
				mailbox: inbox.mailbox,
				unreadCount: inbox.unreadCount,
				totalCount: inbox.totalCount,
				storage: inbox.storage,
				messages: inbox.messages,
			},
		};
	}

	async refresh(
		imap: ImapService,
		userEmail: string,
		connectionId: number,
		mailbox: string,
	): Promise<ClientQuota | null> {
		let live: any;
		try {
			live = await imap.getQuota(mailbox);
		} catch (error) {
			if (error instanceof CapabilityNotSupportedError) {
				return null;
			}
			throw error;
		}
		if (!live || (!live.storage && !live.message && !live.messages)) {
			return null;
		}

		const saved = await mailboxStorageService.saveQuota(
			connectionId,
			mailbox,
			live,
		);
		const quota = mailboxStorageService.formatQuotaForClient(saved);
		await imapCache.setQuota(userEmail, mailbox, quota, 120);
		return quota;
	}

	private async resolveQuota(
		getImap: ImapProvider,
		userEmail: string,
		connectionId: number,
		mailbox: string,
		forceSync: boolean,
	): Promise<ClientQuota | null> {
		if (!forceSync) {
			const cached = await imapCache.getQuota(userEmail, mailbox);
			if (cached) {
				return cached;
			}
			const stored = await mailboxStorageService.getQuota(
				connectionId,
				mailbox,
			);
			if (
				stored &&
				Date.now() - stored.updated_at.getTime() < QUOTA_DB_FRESH_MS
			) {
				const quota = mailboxStorageService.formatQuotaForClient(stored);
				await imapCache.setQuota(userEmail, mailbox, quota, 120);
				return quota;
			}
		}
		return this.refresh(await getImap(), userEmail, connectionId, mailbox);
	}

	private async folderCounts(
		getImap: ImapProvider,
		connectionId: number,
		mailbox: string,
		forceSync: boolean,
	) {
		const row = await mailboxStorageService.getMailboxByPath(
			connectionId,
			mailbox,
		);
		const fresh =
			row && Date.now() - row.updated_at.getTime() < COUNTS_FRESH_MS;
		if (row && fresh && !forceSync) {
			return { unreadCount: row.unseen_count, totalCount: row.total_count };
		}

		const imap = await getImap();
		const live = await imap.synceSingleFolder(mailbox);
		await mailboxStorageService.ensureMailbox(connectionId, mailbox);
		await mailboxStorageService.updateMailboxCounts(connectionId, mailbox, {
			total_count: live.total_count,
			unseen_count: live.unseen_count,
			uid_next: live.uidNext,
			uid_validity: live.uidValidity,
			...(live.highestModseq ? { highest_modseq: live.highestModseq } : {}),
		});
		return { unreadCount: live.unseen_count, totalCount: live.total_count };
	}

	private async accountMessageCount(connectionId: number): Promise<number> {
		const mailboxes = await mailboxStorageService.getMailboxes(connectionId);
		return mailboxes.reduce((sum, box) => sum + Number(box.total_count), 0);
	}
}

export const quotaService = new QuotaService();
