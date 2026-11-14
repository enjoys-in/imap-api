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
