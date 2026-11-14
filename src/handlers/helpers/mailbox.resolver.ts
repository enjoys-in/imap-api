import type { MailboxEntity } from "@/factory/entities";
import { getFolderSpecial } from "./folder.helper";

export type SpecialMailbox =
	| "Inbox"
	| "Sent"
	| "Trash"
	| "Junk"
	| "Drafts"
	| "Archive";

export type MailboxRow = Pick<
	MailboxEntity,
	"id" | "path" | "name" | "special_use"
>;

export interface ResolvedMailbox {
	path: string;
	id: string | null;
}

const SPECIAL_ALIASES: Record<string, SpecialMailbox> = {
	inbox: "Inbox",
	"fld-inbox": "Inbox",
	sent: "Sent",
	"sent items": "Sent",
	"fld-sent": "Sent",
	trash: "Trash",
	deleted: "Trash",
	"deleted items": "Trash",
	"fld-trash": "Trash",
	"fld-deleted": "Trash",
	junk: "Junk",
	"junk email": "Junk",
	spam: "Junk",
	"fld-junk": "Junk",
	"fld-spam": "Junk",
	drafts: "Drafts",
	"fld-drafts": "Drafts",
	archive: "Archive",
	"fld-archive": "Archive",
};

const DEFAULT_PATHS: Record<SpecialMailbox, string> = {
	Inbox: "INBOX",
	Sent: "Sent",
	Trash: "Trash",
	Junk: "Junk",
	Drafts: "Drafts",
	Archive: "Archive",
};

const toResolved = (row: MailboxRow): ResolvedMailbox => ({
	path: row.path,
	id: `fld-${row.id}`,
});

export function readText(value: unknown): string {
	const first: unknown = Array.isArray(value) ? value[0] : value;
	if (typeof first !== "string") return "";
	try {
		return decodeURIComponent(first).trim();
	} catch {
		return first.trim();
	}
}

export function pickMailbox(
	requested: string,
	mailboxes: readonly MailboxRow[],
): ResolvedMailbox {
	const wanted = requested.trim() || "INBOX";
	const lower = wanted.toLowerCase();
	const special = SPECIAL_ALIASES[lower];
	const idMatch = /^fld-(\d+)$/.exec(lower);

	const byId = idMatch
		? mailboxes.find((row) => row.id === Number(idMatch[1]))
		: undefined;
	const byPath =
		mailboxes.find((row) => row.path === wanted) ??
		mailboxes.find((row) => row.path.toLowerCase() === lower);
	const bySpecial = special
		? mailboxes.find(
				(row) =>
					getFolderSpecial(row.name, row.special_use ?? undefined) === special,
			)
		: undefined;

	const row = byId ?? byPath ?? bySpecial;
	if (row) return toResolved(row);
	return { path: special ? DEFAULT_PATHS[special] : wanted, id: null };
}
