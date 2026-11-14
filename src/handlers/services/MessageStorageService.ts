import { MessageEntity } from "@/factory/entities";
import { InjectRepository } from "@/factory/typeorm";
import { In } from "typeorm";

export interface StoredMessageInput {
	uid: number;
	message_id: string | null;
	subject: string | null;
	from_address: string | null;
	to_address: string | null;
	date: Date | null;
	size: number | null;
	content_type: string | null;
	flags: string[];
	attachments: { filename: string; mimeType: string }[];
}

const UPSERT_CHUNK = 500;

export class MessageStorageService {
	private get repo() {
		return InjectRepository(MessageEntity);
	}

	async bounds(mailboxId: number) {
		const row = await this.repo
			.createQueryBuilder("m")
			.select("MIN(m.uid)", "min")
			.addSelect("MAX(m.uid)", "max")
			.addSelect("COUNT(*)", "count")
			.where("m.mailbox_id = :mailboxId", { mailboxId })
			.getRawOne();
		return {
			min: Number(row?.min ?? 0),
			max: Number(row?.max ?? 0),
			count: Number(row?.count ?? 0),
		};
	}

	async getPage(
		mailboxId: number,
		offset: number,
		limit: number,
	): Promise<MessageEntity[]> {
		return this.repo.find({
			where: { mailbox_id: mailboxId },
			order: { uid: "DESC" },
			skip: offset,
			take: limit,
		});
	}

	async upsertMany(mailboxId: number, messages: StoredMessageInput[]) {
		for (let i = 0; i < messages.length; i += UPSERT_CHUNK) {
			await this.repo.upsert(
				messages
					.slice(i, i + UPSERT_CHUNK)
					.map((message) => ({ ...message, mailbox_id: mailboxId })),
				["mailbox_id", "uid"],
			);
		}
	}

	async deleteUids(mailboxId: number, uids: number[]) {
		if (uids.length === 0) {
			return;
		}
		await this.repo.delete({ mailbox_id: mailboxId, uid: In(uids) });
	}

	async deleteAll(mailboxId: number) {
		await this.repo.delete({ mailbox_id: mailboxId });
	}

	async updateFlags(
		mailboxId: number,
		entries: { uid: number; flags: string[] }[],
	) {
		for (const { uid, flags } of entries) {
			await this.repo.update({ mailbox_id: mailboxId, uid }, { flags });
		}
	}

	toEmail(message: MessageEntity) {
		return {
			message_id: message.message_id,
			uid: message.uid,
			type: message.content_type,
			size: message.size,
			subject: message.subject,
			from: message.from_address,
			to: message.to_address,
			date: message.date,
			flags: message.flags,
			attachments: message.attachments,
		};
	}
}

export const messageStorageService = new MessageStorageService();
