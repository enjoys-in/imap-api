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
 * Enriches raw mailbox metadata from IMAP server into standard frontend schema.
 */
export function enrichMailboxList(
	mailboxes: any[] | null | undefined,
	accountId = "acc-1",
) {
	return (mailboxes || []).map((box: any, index: number) => {
		const special = getFolderSpecial(box.name, box.specialUse);
		const rawName = box.name || box.path || `folder-${index}`;
		const slug = rawName.toLowerCase().replace(/[^a-z0-9]/g, "-");
		const id = box.id ? `fld-${box.id}` : `fld-${slug}`;

		return {
			...box,
			id,
			accountId,
			fullName: box.path || box.name,
			displayName: box.name,
			parentFullName: null,
			special,
			uidValidity: box.uidValidity || 20261113,
			unreadCount: Number(box.unseen_count || 0),
			totalCount: Number(box.total_count || 0),
			lastSyncedAt: new Date().toISOString(),
			sortRank: getFolderSortRank(special, index),
		};
	});
}

/**
 * Enriches raw message metadata from IMAP server into standard frontend schema.
 */
export function enrichEmailList(
	emails: any[],
	selectedFolder: string,
	accountId = "acc-1",
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

		return {
			...msg,
			id,
			folderId: `fld-${selectedFolder.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
			accountId,
			uid,
			messageIdHeader: msg.message_id,
			threadId: msg.message_id || id,
			subject: msg.subject || "(No Subject)",
			fromName: fromName || fromAddress,
			fromAddress,
			to: msg.to || "",
			date: msg.date
				? new Date(msg.date).toISOString()
				: new Date().toISOString(),
			size: msg.size || 0,
			preview: msg.subject || "",
			isRead,
			isFlagged,
			isPinned: false,
			isAnswered: flagsArr.includes("\\Answered"),
			isForwarded: false,
			isDraft: flagsArr.includes("\\Draft"),
			isThread: false,
			threadCount: 1,
			hasAttachments:
				Array.isArray(msg.attachments) && msg.attachments.length > 0,
			hasCalendar: false,
		};
	});
}

/**
 * Parses numeric UID list from request body/query arrays.
 */
export function parseUids(rawUids: any): number[] {
	if (!rawUids) return [];
	const arr = Array.isArray(rawUids) ? rawUids : [rawUids];
	return arr
		.map((uid) => {
			if (typeof uid === "string" && uid.startsWith("msg-")) {
				return Number(uid.replace("msg-", ""));
			}
			return Number(uid);
		})
		.filter((n) => !Number.isNaN(n) && n > 0);
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
