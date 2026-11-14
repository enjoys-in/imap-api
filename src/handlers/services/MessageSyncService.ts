import type { MailboxEntity, MessageEntity } from "@/factory/entities";
import type { EmailSummary, ImapService, MailboxSession } from "./ImapService";
import { mailboxStorageService } from "./MailboxStorageService";
import {
	type StoredMessageInput,
	messageStorageService,
} from "./MessageStorageService";

const BACKFILL_CHUNK = 100;
const NEW_MESSAGE_CHUNK = 500;
const RECONCILE_WINDOW = 100;
const SYNC_WINDOW = 50;
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

export interface SyncDelta {
	path: string;
	added: (Omit<EmailSummary, "flags"> & { flags: string[] })[];
	stored: number;
	removed: number[];
	updated: { uid: number; flags: string[] }[];
	totalCount: number;
	unseenCount: number;
	uidNext: number;
	uidValidity: number;
}

export class MessageSyncService {
	private readonly inFlight = new Map<string, Promise<SyncDelta>>();

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

			const cursor = await this.resetIfStale(mailbox, box);
			const pulled = await this.pullNew(box, mailbox.id, limit, cursor);
			const fresh = new Set(pulled.map((message) => message.uid));

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
				const { removed } = await this.reconcile(
					box,
					mailbox.id,
					rows.filter((row) => !fresh.has(row.uid)),
				);
				if (removed.length === 0) {
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

	async readStored(
		connectionId: number,
		path: string,
		offset: number,
		limit: number,
	) {
		const mailbox = await mailboxStorageService.ensureMailbox(
			connectionId,
			path,
		);
		const rows = await messageStorageService.getPage(mailbox.id, offset, limit);
		return rows.map((row) => messageStorageService.toEmail(row)).reverse();
	}

	async syncMailbox(
		imap: ImapService,
		connectionId: number,
		path: string,
	): Promise<SyncDelta> {
		const key = `${connectionId}:${path}`;
		const running = this.inFlight.get(key);
		if (running) {
			return running;
		}
		const task = this.runSync(imap, connectionId, path).finally(() => {
			this.inFlight.delete(key);
		});
		this.inFlight.set(key, task);
		return task;
	}

	private async runSync(
		imap: ImapService,
		connectionId: number,
		path: string,
	): Promise<SyncDelta> {
		const mailbox = await mailboxStorageService.ensureMailbox(
			connectionId,
			path,
		);

		return imap.withMailbox(path, async (box) => {
			const { exists, uidNext, uidValidity, highestModseq } = box.info;

			const cursor = await this.resetIfStale(mailbox, box);
			const previousNext = cursor ?? mailbox.uid_next;
			const pulled = await this.pullNew(box, mailbox.id, SYNC_WINDOW, cursor);
			const fresh = new Set(pulled.map((message) => message.uid));
			const arrived =
				cursor !== null
					? pulled
					: pulled.filter(
							(message) => previousNext !== null && message.uid >= previousNext,
						);

			const rows = await messageStorageService.getPage(
				mailbox.id,
				0,
				RECONCILE_WINDOW,
			);
			const { removed, updated } = await this.reconcile(
				box,
				mailbox.id,
				rows.filter((row) => !fresh.has(row.uid)),
			);

			const unseen = exists === 0 ? [] : await box.search({ seen: false });

			await mailboxStorageService.updateMailboxCounts(connectionId, path, {
				total_count: exists,
				unseen_count: unseen.length,
				uid_next: uidNext,
				uid_validity: uidValidity,
				synced_uid_next: uidNext,
				...(highestModseq ? { highest_modseq: highestModseq } : {}),
			});

			return {
				path,
				added: arrived.map((message) => ({
					...message,
					flags: Array.from(message.flags ?? []),
				})),
				stored: pulled.length,
				removed,
				updated,
				totalCount: exists,
				unseenCount: unseen.length,
				uidNext,
				uidValidity,
			};
		});
	}

	private async resetIfStale(
		mailbox: MailboxEntity,
		box: MailboxSession,
	): Promise<number | null> {
		const { exists, uidValidity } = box.info;
		const changed =
			mailbox.uid_validity !== null &&
			mailbox.uid_validity !== undefined &&
			Number(mailbox.uid_validity) !== uidValidity;
		if (exists === 0 || changed) {
			await messageStorageService.deleteAll(mailbox.id);
			return null;
		}
		return mailbox.synced_uid_next;
	}

	private async pullNew(
		box: MailboxSession,
		mailboxId: number,
		window: number,
		cursor: number | null,
	): Promise<EmailSummary[]> {
		const { exists, uidNext } = box.info;
		if (exists === 0) {
			return [];
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
		return fetched;
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
	): Promise<{
		removed: number[];
		updated: { uid: number; flags: string[] }[];
	}> {
		if (rows.length === 0) {
			return { removed: [], updated: [] };
		}

		const current = await box.flags(rows.map((row) => row.uid));
		const removed = rows
			.filter((row) => !current.has(row.uid))
			.map((row) => row.uid);
		const updated = rows
			.filter((row) => {
				const flags = current.get(row.uid);
				return flags !== undefined && !sameFlags(row.flags, flags);
			})
			.map((row) => ({ uid: row.uid, flags: current.get(row.uid) as string[] }));

		await messageStorageService.deleteUids(mailboxId, removed);
		await messageStorageService.updateFlags(mailboxId, updated);
		for (const change of updated) {
			const row = rows.find((candidate) => candidate.uid === change.uid);
			if (row) {
				row.flags = change.flags;
			}
		}

		return { removed, updated };
	}
}

export const messageSyncService = new MessageSyncService();
