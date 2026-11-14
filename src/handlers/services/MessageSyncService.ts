import type { MessageEntity } from "@/factory/entities";
import type { EmailSummary, ImapService, MailboxSession } from "./ImapService";
import { mailboxStorageService } from "./MailboxStorageService";
import {
	type StoredMessageInput,
	messageStorageService,
} from "./MessageStorageService";

const BACKFILL_CHUNK = 100;
const NEW_MESSAGE_CHUNK = 500;
const MAX_PASSES = 25;

const toStored = (message: EmailSummary): StoredMessageInput => ({
	uid: message.uid,
	message_id: message.message_id ?? null,
	subject: message.subject ?? null,
	from_address: message.from ?? null,
	to_address: message.to ?? null,
	date: message.date ? new Date(message.date) : null,
	size: message.size ?? null,
	content_type: message.type ?? null,
	flags: Array.from(message.flags ?? []),
	attachments: message.attachments,
});

const sameFlags = (a: string[], b: string[]) =>
	a.length === b.length &&
	JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

export class MessageSyncService {
	async getPage(
		imap: ImapService,
		connectionId: number,
		path: string,
		offset: number,
		limit: number,
	) {
		const mailbox = await mailboxStorageService.ensureMailbox(
			connectionId,
			path,
		);

		return imap.withMailbox(path, async (box) => {
			const { exists, uidNext, uidValidity, highestModseq } = box.info;

			const uidValidityChanged =
				mailbox.uid_validity !== null &&
				mailbox.uid_validity !== undefined &&
				Number(mailbox.uid_validity) !== uidValidity;
			if (exists === 0 || uidValidityChanged) {
				await messageStorageService.deleteAll(mailbox.id);
			}

			const cursor =
				exists === 0 || uidValidityChanged ? null : mailbox.synced_uid_next;
			const fresh = await this.pullNew(box, mailbox.id, limit, cursor);

			let rows: MessageEntity[] = [];
			for (let pass = 0; pass < MAX_PASSES; pass++) {
				rows = await messageStorageService.getPage(mailbox.id, offset, limit);
				if (rows.length < limit) {
					const added = await this.backfill(box, mailbox.id);
					if (added.length > 0) {
						for (const uid of added) {
							fresh.add(uid);
						}
						continue;
					}
				}
				const removed = await this.reconcile(
					box,
					mailbox.id,
					rows.filter((row) => !fresh.has(row.uid)),
				);
				if (removed === 0) {
					break;
				}
			}

			await mailboxStorageService.updateMailboxCounts(connectionId, path, {
				total_count: exists,
				uid_next: uidNext,
				uid_validity: uidValidity,
				synced_uid_next: uidNext,
				...(highestModseq ? { highest_modseq: highestModseq } : {}),
			});

			return {
				emails: rows.map((row) => messageStorageService.toEmail(row)).reverse(),
				totalCount: exists,
				hasMore: offset + rows.length < exists,
				uidNext,
				uidValidity,
			};
		});
	}

	private async pullNew(
		box: MailboxSession,
		mailboxId: number,
		window: number,
		cursor: number | null,
	): Promise<Set<number>> {
		const { exists, uidNext } = box.info;
		if (exists === 0) {
			return new Set();
		}

		const { max } = await messageStorageService.bounds(mailboxId);
		let fetched: EmailSummary[] = [];

		if (max === 0 || cursor === null) {
			const start = Math.max(exists - window + 1, 1);
			fetched = await box.fetch(`${start}:${exists}`, false);
		} else if (uidNext > cursor) {
			if (uidNext - cursor <= NEW_MESSAGE_CHUNK) {
				fetched = await box.fetch(`${cursor}:*`, true);
			} else {
				const uids = await box.search({ uid: `${cursor}:*` });
				for (let i = 0; i < uids.length; i += NEW_MESSAGE_CHUNK) {
					fetched.push(
						...(await box.fetch(
							uids.slice(i, i + NEW_MESSAGE_CHUNK).join(","),
							true,
						)),
					);
				}
			}
			fetched = fetched.filter((message) => message.uid >= cursor);
		}

		await messageStorageService.upsertMany(mailboxId, fetched.map(toStored));
		return new Set(fetched.map((message) => message.uid));
	}

	private async backfill(
		box: MailboxSession,
		mailboxId: number,
	): Promise<number[]> {
		const { min } = await messageStorageService.bounds(mailboxId);
		if (min <= 1) {
			return [];
		}

		const older = await box.search({ uid: `1:${min - 1}` });
		if (older.length === 0) {
			return [];
		}

		const chunk = older.sort((a, b) => a - b).slice(-BACKFILL_CHUNK);
		const fetched = await box.fetch(chunk.join(","), true);
		await messageStorageService.upsertMany(mailboxId, fetched.map(toStored));
		return fetched.map((message) => message.uid);
	}

	private async reconcile(
		box: MailboxSession,
		mailboxId: number,
		rows: MessageEntity[],
	): Promise<number> {
		if (rows.length === 0) {
			return 0;
		}

		const current = await box.flags(rows.map((row) => row.uid));
		const gone = rows.filter((row) => !current.has(row.uid));
		const changed = rows.filter((row) => {
			const flags = current.get(row.uid);
			return flags !== undefined && !sameFlags(row.flags, flags);
		});

		await messageStorageService.deleteUids(
			mailboxId,
			gone.map((row) => row.uid),
		);
		await messageStorageService.updateFlags(
			mailboxId,
			changed.map((row) => ({
				uid: row.uid,
				flags: current.get(row.uid) as string[],
			})),
		);
		for (const row of changed) {
			row.flags = current.get(row.uid) as string[];
		}

		return gone.length;
	}
}

export const messageSyncService = new MessageSyncService();
