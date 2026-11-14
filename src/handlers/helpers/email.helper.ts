import type { AttachmentInfo } from "@/utils/interfaces/imap.interface";
import { toClientAttachment } from "./attachment.helper";
import { getFolderSortRank, getFolderSpecial } from "./folder.helper";

/**
 * Parses raw "From: Name <email@domain>" strings into separate name and address.
 */
export function parseEmailAddress(fromRaw?: string): {
	name: string;
	address: string;
} {
	if (!fromRaw) return { name: "", address: "" };

	const matchAngle = fromRaw.match(/(.*)<(.*)>/);
	if (matchAngle) {
		const name = matchAngle[1].trim() || matchAngle[2].trim();
		const address = matchAngle[2].trim();
		return { name, address };
	}

	if (fromRaw.includes("@")) {
		return {
			name: fromRaw.split("@")[0].trim(),
			address: fromRaw.trim(),
		};
	}

	return { name: fromRaw, address: fromRaw };
}

/**
 * Maps a mailbox (DB row or raw IMAP listing) into the single camelCase
 * folder schema every endpoint sends to the client.
 */
export function toClientMailbox(box: any, accountId: string, index: number) {
	const name: string = box.name || box.path || `folder-${index}`;
	const path: string = box.path || name;
	const specialUse = box.specialUse ?? box.special_use ?? null;
	const special = getFolderSpecial(name, specialUse ?? undefined);
	const uidValidity = box.uidValidity ?? box.uid_validity;
	const syncedAt = box.updated_at ?? box.lastSyncedAt ?? new Date();

	return {
		id: box.id
			? `fld-${box.id}`
			: `fld-${name.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
		numericId: box.id ?? null,
		accountId,
		name,
		path,
		fullName: path,
		displayName: name,
		delimiter: box.delimiter ?? null,
		specialUse,
		special,
		listed: box.listed ?? null,
		subscribed: box.subscribed ?? null,
		parentFullName: null,
		uidValidity: uidValidity ? Number(uidValidity) : null,
		uidNext: box.uidNext ?? box.uid_next ?? null,
		highestModseq: box.highestModseq ?? box.highest_modseq ?? null,
		unreadCount: Number(box.unreadCount ?? box.unseen_count ?? 0),
		totalCount: Number(box.totalCount ?? box.total_count ?? 0),
		lastSyncedAt: new Date(syncedAt).toISOString(),
		sortRank: getFolderSortRank(special, index),
	};
}

export function enrichMailboxList(
	mailboxes: any[] | null | undefined,
	accountId: string,
) {
	return (mailboxes || []).map((box: any, index: number) =>
		toClientMailbox(box, accountId, index),
	);
}

/**
 * Enriches raw message metadata from IMAP server into standard frontend schema.
 */
export function enrichEmailList(
	emails: any[],
	selectedFolder: string,
	accountId: string,
	folderId?: string,
) {
	return (emails || []).map((msg: any) => {
		const flagsArr = Array.isArray(msg.flags)
			? msg.flags
			: msg.flags
				? Array.from(msg.flags)
				: [];

		const isRead =
			flagsArr.includes("\\Seen") ||
			flagsArr.includes("Seen") ||
			flagsArr.includes("\\seen");

		const isFlagged =
			flagsArr.includes("\\Flagged") ||
			flagsArr.includes("Flagged") ||
			flagsArr.includes("\\flagged");

		const { name: fromName, address: fromAddress } = parseEmailAddress(
			msg.from || "",
		);

		const uid = msg.uid;
		const id = uid
			? `msg-${uid}`
			: msg.message_id || `msg-${Math.random().toString(36).substring(7)}`;

		const attachments: ReturnType<typeof toClientAttachment>[] = (
			Array.isArray(msg.attachments) ? msg.attachments : []
		).map((attachment: AttachmentInfo) =>
			toClientAttachment(attachment, selectedFolder, uid),
		);

		return {
			...msg,
			id,
			folderId:
				folderId ??
				`fld-${selectedFolder.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
			accountId,
			uid,
			messageIdHeader: msg.message_id,
			threadId: msg.message_id || id,
			subject: msg.subject || "(No Subject)",
			fromName: fromName || fromAddress,
			fromAddress,
			to: msg.to || "",
			date: msg.date ? new Date(msg.date).toISOString() : null,
			size: msg.size || 0,
			attachments,
			isRead,
			isFlagged,
			isAnswered: flagsArr.includes("\\Answered"),
			isForwarded:
				flagsArr.includes("$Forwarded") || flagsArr.includes("Forwarded"),
			isDraft: flagsArr.includes("\\Draft"),
			hasAttachments: attachments.some((attachment) => !attachment.isInline),
			hasCalendar: attachments.some(
				(attachment) =>
					attachment.contentType === "text/calendar" ||
					attachment.contentType === "application/ics",
			),
		};
	});
}

export function parseUids(rawUids: unknown): number[] {
	if (!rawUids) return [];
	const list: unknown[] = Array.isArray(rawUids) ? rawUids : [rawUids];
	return list
		.map((uid) =>
			typeof uid === "string" ? Number(uid.replace(/^msg-/, "")) : Number(uid),
		)
		.filter((uid) => Number.isInteger(uid) && uid > 0);
}

/**
 * Recursively converts BigInt and Set objects so JSON.stringify doesn't throw.
 */
export function cleanBigIntJson<T = any>(obj: any): T {
	return JSON.parse(
		JSON.stringify(obj, (_, value) => {
			if (typeof value === "bigint") return value.toString();
			if (value instanceof Set) return Array.from(value);
			return value;
		}),
	);
}
