/**
 * Resolves frontend folder identifiers (e.g. "fld-inbox", "fld-sent", "trash")
 * to standard IMAP mailbox names recognized by the mail server.
 */
export function resolveMailboxFolder(folderParam?: string): string {
	if (!folderParam) return "INBOX";
	const decoded = decodeURIComponent(folderParam).trim();
	const lower = decoded.toLowerCase();

	if (lower === "fld-inbox" || lower === "inbox") return "INBOX";
	if (lower === "fld-sent" || lower === "sent" || lower === "sent items") {
		return "Sent Items";
	}
	if (
		lower === "fld-trash" ||
		lower === "fld-deleted" ||
		lower === "deleted" ||
		lower === "deleted items" ||
		lower === "trash"
	) {
		return "Deleted Items";
	}
	if (
		lower === "fld-junk" ||
		lower === "fld-spam" ||
		lower === "junk" ||
		lower === "junk email" ||
		lower === "spam"
	) {
		return "Junk Email";
	}
	if (lower === "fld-drafts" || lower === "drafts") return "Drafts";
	if (lower === "fld-archive" || lower === "archive") return "Archive";

	return decoded;
}

/**
 * Maps mailbox name and specialUse flags to standardized folder special category.
 */
export function getFolderSpecial(name: string, specialUse?: string): string {
	const specialLower = (specialUse || name || "")
		.toLowerCase()
		.replace(/\\/g, "");

	if (specialLower.includes("inbox")) return "Inbox";
	if (specialLower.includes("sent")) return "Sent";
	if (specialLower.includes("trash") || specialLower.includes("deleted")) {
		return "Trash";
	}
	if (specialLower.includes("junk") || specialLower.includes("spam")) {
		return "Junk";
	}
	if (specialLower.includes("draft")) return "Drafts";
	if (specialLower.includes("archive") || specialLower.includes("all")) {
		return "Archive";
	}

	return "Custom";
}

/**
 * Returns sort rank for folder ordering in UI.
 */
export function getFolderSortRank(special: string, index = 0): number {
	switch (special) {
		case "Inbox":
			return 1;
		case "Archive":
			return 2;
		case "Sent":
			return 3;
		case "Trash":
			return 4;
		case "Junk":
			return 5;
		default:
			return 10 + index;
	}
}
