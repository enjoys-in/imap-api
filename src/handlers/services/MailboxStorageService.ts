import { MailboxEntity, MailboxQuotaEntity } from "@/factory/entities";
import { InjectRepository } from "@/factory/typeorm";
import { getFolderSortRank, getFolderSpecial } from "../helpers/folder.helper";

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
			const totalCount = Number(
				box.total_count ?? box.status?.messages ?? box.messages ?? 0,
			);
			const unseenCount = Number(
				box.unseen_count ?? box.status?.unseen ?? box.unseen ?? 0,
			);

			return {
				connection_id: connectionId,
				name: box.name || box.path,
				path: box.path,
				delimiter: box.delimiter || "/",
				special_use: box.specialUse || box.special_use || null,
				listed: Boolean(box.listed),
				subscribed: Boolean(box.subscribed),
				total_count: totalCount,
				unseen_count: unseenCount,
				uid_validity:
					box.status?.uidValidity ??
					box.uidValidity ??
					box.uid_validity ??
					null,
				uid_next: box.status?.uidNext ?? box.uidNext ?? box.uid_next ?? null,
				highest_modseq: box.status?.highestModseq
					? String(box.status.highestModseq)
					: box.highest_modseq
						? String(box.highest_modseq)
						: null,
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
	 * Increments or decrements counts atomically (e.g. on IMAP IDLE exists/expunge events).
	 */
	async adjustMailboxCounts(
		connectionId: number,
		path: string,
		totalDelta: number,
		unseenDelta: number,
	): Promise<void> {
		await this.mailboxRepo
			.createQueryBuilder()
			.update(MailboxEntity)
			.set({
				total_count: () => `GREATEST(0, total_count + ${totalDelta})`,
				unseen_count: () => `GREATEST(0, unseen_count + ${unseenDelta})`,
			})
			.where("connection_id = :connId AND path = :path", {
				connId: connectionId,
				path,
			})
			.execute();
	}

	/**
	 * Persist mailbox storage quota into PostgreSQL.
	 */
	async saveQuota(
		connectionId: number,
		mailbox = "INBOX",
		quotaData: any,
	): Promise<MailboxQuotaEntity> {
		const storageUsed = Number(
			quotaData?.storage?.used ?? quotaData?.usage ?? 0,
		);
		const storageLimit = Number(
			quotaData?.storage?.limit ?? quotaData?.limit ?? 1073741824,
		);
		const storagePercentage =
			storageLimit > 0
				? Number(((storageUsed / storageLimit) * 100).toFixed(2))
				: 0;

		const messagesUsed = Number(
			quotaData?.messages?.used ?? quotaData?.messageCount ?? 0,
		);
		const messagesLimit = Number(
			quotaData?.messages?.limit ?? quotaData?.messageLimit ?? 10000,
		);

		const entityData: Partial<MailboxQuotaEntity> = {
			connection_id: connectionId,
			mailbox,
			storage_used: storageUsed,
			storage_limit: storageLimit,
			storage_percentage: storagePercentage,
			messages_used: messagesUsed,
			messages_limit: messagesLimit,
		};

		await this.quotaRepo.upsert([entityData], ["connection_id", "mailbox"]);

		return (await this.quotaRepo.findOne({
			where: { connection_id: connectionId, mailbox },
		}))!;
	}

	/**
	 * Retrieve stored quota for a connection from the database.
	 */
	async getQuota(
		connectionId: number,
		mailbox = "INBOX",
	): Promise<MailboxQuotaEntity | null> {
		let quota = await this.quotaRepo.findOne({
			where: { connection_id: connectionId, mailbox },
		});
		if (!quota) {
			// Fallback to any recorded quota for this connection
			quota = await this.quotaRepo.findOne({
				where: { connection_id: connectionId },
			});
		}
		return quota;
	}

	/**
	 * Format MailboxEntity array into standard frontend envelope.
	 */
	formatMailboxesForClient(
		entities: MailboxEntity[],
		accountId = "acc-1",
	): any[] {
		return entities.map((box, index) => {
			const special = getFolderSpecial(box.name, box.special_use);
			return {
				id: `fld-${box.id}`,
				numericId: box.id,
				accountId,
				name: box.name,
				path: box.path,
				fullName: box.path,
				displayName: box.name,
				delimiter: box.delimiter,
				specialUse: box.special_use,
				special,
				listed: box.listed,
				subscribed: box.subscribed,
				parentFullName: null,
				uidValidity: box.uid_validity ? Number(box.uid_validity) : 20261113,
				uidNext: box.uid_next,
				highestModseq: box.highest_modseq,
				unreadCount: box.unseen_count,
				unseen_count: box.unseen_count,
				totalCount: box.total_count,
				total_count: box.total_count,
				lastSyncedAt: box.updated_at.toISOString(),
				sortRank: getFolderSortRank(special, index),
			};
		});
	}

	/**
	 * Format MailboxQuotaEntity into standard client quota schema.
	 */
	formatQuotaForClient(quota: MailboxQuotaEntity | null): any {
		if (!quota) {
			return {
				storage: { used: 0, limit: 1073741824, percentage: 0 },
				messages: { used: 0, limit: 10000 },
				mailbox: "INBOX",
				updatedAt: new Date().toISOString(),
			};
		}

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
