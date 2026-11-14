import { MailboxEntity, MailboxQuotaEntity } from "@/factory/entities";
import { InjectRepository } from "@/factory/typeorm";
import { toClientMailbox } from "../helpers/email.helper";

export class MailboxStorageService {
	private get mailboxRepo() {
		return InjectRepository(MailboxEntity);
	}

	private get quotaRepo() {
		return InjectRepository(MailboxQuotaEntity);
	}

	/**
	 * Retrieve all stored mailboxes for a connection from the database.
	 */
	async getMailboxes(connectionId: number): Promise<MailboxEntity[]> {
		return this.mailboxRepo.find({
			where: { connection_id: connectionId },
			order: { id: "ASC" },
		});
	}

	/**
	 * Retrieve a single mailbox by path for a connection.
	 */
	async getMailboxByPath(
		connectionId: number,
		path: string,
	): Promise<MailboxEntity | null> {
		return this.mailboxRepo.findOne({
			where: { connection_id: connectionId, path },
		});
	}

	async ensureMailbox(
		connectionId: number,
		path: string,
	): Promise<MailboxEntity> {
		const existing = await this.getMailboxByPath(connectionId, path);
		if (existing) {
			return existing;
		}
		await this.mailboxRepo.upsert(
			[{ connection_id: connectionId, name: path, path }],
			["connection_id", "path"],
		);
		return (await this.getMailboxByPath(connectionId, path))!;
	}

	/**
	 * Persist raw IMAP mailbox metadata into PostgreSQL.
	 * Performs atomic upsert and prunes removed mailboxes.
	 */
	async saveMailboxes(
		connectionId: number,
		rawMailboxes: any[],
	): Promise<MailboxEntity[]> {
		if (!rawMailboxes || rawMailboxes.length === 0) {
			return [];
		}

		const entities: Partial<MailboxEntity>[] = rawMailboxes.map((box) => {
			const totalCount =
				box.total_count ?? box.status?.messages ?? box.messages;
			const unseenCount =
				box.unseen_count ?? box.status?.unseen ?? box.unseen;
			const uidValidity =
				box.status?.uidValidity ?? box.uidValidity ?? box.uid_validity;
			const uidNext = box.status?.uidNext ?? box.uidNext ?? box.uid_next;
			const modseq =
				box.status?.highestModseq ?? box.highestModseq ?? box.highest_modseq;

			return {
				connection_id: connectionId,
				name: box.name || box.path,
				path: box.path,
				delimiter: box.delimiter || "/",
				special_use: box.specialUse || box.special_use || null,
				listed: Boolean(box.listed),
				subscribed: Boolean(box.subscribed),
				...(totalCount !== undefined && { total_count: Number(totalCount) }),
				...(unseenCount !== undefined && { unseen_count: Number(unseenCount) }),
				...(uidValidity != null && { uid_validity: uidValidity }),
				...(uidNext != null && { uid_next: uidNext }),
				...(modseq && { highest_modseq: String(modseq) }),
			};
		});

		// 1. Upsert all current mailboxes
		await this.mailboxRepo.upsert(entities, ["connection_id", "path"]);

		// 2. Prune mailboxes that no longer exist on IMAP server
		const currentPaths = rawMailboxes.map((b) => b.path).filter(Boolean);
		if (currentPaths.length > 0) {
			await this.mailboxRepo
				.createQueryBuilder()
				.delete()
				.where("connection_id = :connId", { connId: connectionId })
				.andWhere("path NOT IN (:...paths)", { paths: currentPaths })
				.execute();
		}

		return this.getMailboxes(connectionId);
	}

	/**
	 * Updates counts for a specific mailbox in the database.
	 */
	async updateMailboxCounts(
		connectionId: number,
		path: string,
		counts: {
			total_count?: number;
			unseen_count?: number;
			uid_next?: number;
			uid_validity?: number;
			synced_uid_next?: number;
			highest_modseq?: string;
		},
	): Promise<void> {
		const updateData: Partial<MailboxEntity> = {};
		if (counts.total_count !== undefined) {
			updateData.total_count = counts.total_count;
		}
		if (counts.unseen_count !== undefined) {
			updateData.unseen_count = counts.unseen_count;
		}
		if (counts.uid_next !== undefined) {
			updateData.uid_next = counts.uid_next;
		}
		if (counts.uid_validity !== undefined) {
			updateData.uid_validity = counts.uid_validity;
		}
		if (counts.synced_uid_next !== undefined) {
			updateData.synced_uid_next = counts.synced_uid_next;
		}
		if (counts.highest_modseq !== undefined) {
			updateData.highest_modseq = counts.highest_modseq;
		}

		if (Object.keys(updateData).length > 0) {
			await this.mailboxRepo.update(
				{ connection_id: connectionId, path },
				updateData,
			);
		}
	}

	/**
	 * Persist mailbox storage quota into PostgreSQL.
	 */
	async saveQuota(
		connectionId: number,
		mailbox = "INBOX",
		quotaData: any,
	): Promise<MailboxQuotaEntity> {
		const quota = this.normalizeQuota(quotaData);
		if (!quota) {
			throw new Error("Quota is not available from the IMAP server");
		}

		const messagesUsed =
			quota.messagesUsed ??
			(await this.getMailboxes(connectionId)).reduce(
				(sum, box) => sum + Number(box.total_count),
				0,
			);
		const storagePercentage =
			quota.storageLimit > 0
				? Math.min(
					Number(((quota.storageUsed / quota.storageLimit) * 100).toFixed(2)),
					999.99,
					)
				: 0;

		const entityData: Partial<MailboxQuotaEntity> = {
			connection_id: connectionId,
			mailbox,
			storage_used: quota.storageUsed,
			storage_limit: quota.storageLimit,
			storage_percentage: storagePercentage,
			messages_used: messagesUsed,
			messages_limit: quota.messagesLimit,
		};

		await this.quotaRepo.upsert([entityData], ["connection_id", "mailbox"]);

		return (await this.quotaRepo.findOne({
			where: { connection_id: connectionId, mailbox },
		}))!;
	}

	private normalizeQuota(raw: any) {
		const storage = raw?.storage;
		const messages = raw?.message ?? raw?.messages;
		if (!storage && !messages) {
			return null;
		}
		return {
			storageUsed: Number(storage?.usage ?? storage?.used ?? 0),
			storageLimit: Number(storage?.limit ?? 0),
			messagesUsed: messages
				? Number(messages.usage ?? messages.used ?? 0)
				: null,
			messagesLimit: Number(messages?.limit ?? 0),
		};
	}

	/**
	 * Retrieve stored quota for a connection from the database.
	 */
	async getQuota(
		connectionId: number,
		mailbox = "INBOX",
	): Promise<MailboxQuotaEntity | null> {
		return this.quotaRepo.findOne({
			where: { connection_id: connectionId, mailbox },
		});
	}

	/**
	 * Format MailboxEntity array into standard frontend envelope.
	 */
	formatMailboxesForClient(
		entities: MailboxEntity[],
		accountId: string,
	): any[] {
		return entities.map((box, index) => toClientMailbox(box, accountId, index));
	}

	/**
	 * Format MailboxQuotaEntity into standard client quota schema.
	 */
	formatQuotaForClient(quota: MailboxQuotaEntity): any {
		return {
			storage: {
				used: Number(quota.storage_used),
				limit: Number(quota.storage_limit),
				percentage: Number(quota.storage_percentage),
			},
			messages: {
				used: Number(quota.messages_used),
				limit: Number(quota.messages_limit),
			},
			mailbox: quota.mailbox,
			updatedAt: quota.updated_at.toISOString(),
		};
	}
}

export const mailboxStorageService = new MailboxStorageService();
