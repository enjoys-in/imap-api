import type { SearchObject } from "imapflow";

export interface ParsedSearchQuery {
	imapQuery: SearchObject;
	hasAttachment?: boolean;
	fileName?: string;
	rawTerms: string[];
}

/**
 * Parses user search query string into IMAP SearchObject and metadata filters.
 * Supports syntax:
 *   - from:alice or from:"Alice Smith" or from:alice@example.com
 *   - to:bob or to:bob@example.com
 *   - subject:meeting or subject:"quarterly report"
 *   - body:"invoice details"
 *   - has:attachment or has:file
 *   - file:pdf or file:contract.docx
 *   - is:unread or is:read or is:seen
 *   - is:flagged or is:starred
 *   - since:2026-01-01 or before:2026-12-31
 *   - free text keywords (e.g. "urgent proposal review") matched via IMAP TEXT
 */
export function parseSearchQueryString(rawQuery: string): ParsedSearchQuery {
	const query = rawQuery.trim();
	if (!query) {
		return { imapQuery: { all: true }, rawTerms: [] };
	}

	const imapQuery: SearchObject = {};
	let hasAttachment: boolean | undefined = undefined;
	let fileName: string | undefined = undefined;

	// Pattern to match key:value or key:"quoted value"
	const operatorRegex =
		/(?:(from|to|cc|bcc|subject|body|has|is|file|attachment|since|before):(?:"([^"]+)"|(\S+)))/gi;

	const terms: string[] = [];
	let remaining = query;

	let match: RegExpExecArray | null;
	while ((match = operatorRegex.exec(query)) !== null) {
		const key = match[1].toLowerCase();
		const val = match[2] !== undefined ? match[2] : match[3];

		switch (key) {
			case "from":
				imapQuery.from = val;
				break;
			case "to":
				imapQuery.to = val;
				break;
			case "cc":
				imapQuery.cc = val;
				break;
			case "bcc":
				imapQuery.bcc = val;
				break;
			case "subject":
				imapQuery.subject = val;
				break;
			case "body":
				imapQuery.body = val;
				break;
			case "has":
				if (val.toLowerCase() === "attachment" || val.toLowerCase() === "file") {
					hasAttachment = true;
				}
				break;
			case "file":
			case "attachment":
				hasAttachment = true;
				fileName = val.toLowerCase();
				break;
			case "is":
				if (val.toLowerCase() === "unread") {
					imapQuery.seen = false;
				} else if (val.toLowerCase() === "read" || val.toLowerCase() === "seen") {
					imapQuery.seen = true;
				} else if (
					val.toLowerCase() === "flagged" ||
					val.toLowerCase() === "starred"
				) {
					imapQuery.flagged = true;
				}
				break;
			case "since":
				try {
					imapQuery.since = new Date(val);
				} catch {}
				break;
			case "before":
				try {
					imapQuery.before = new Date(val);
				} catch {}
				break;
		}

		// Remove the matched operator from remaining text
		remaining = remaining.replace(match[0], " ");
	}

	// Split remaining free-text terms
	const freeTerms = remaining
		.split(/\s+/)
		.map((t) => t.trim())
		.filter((t) => t.length > 0);

	if (freeTerms.length > 0) {
		const textQuery = freeTerms.join(" ");
		// If subject was not explicitly specified, search IMAP TEXT (searches subject, headers, and body)
		if (!imapQuery.subject && !imapQuery.body) {
			imapQuery.text = textQuery;
		} else if (!imapQuery.text) {
			imapQuery.text = textQuery;
		}
		terms.push(...freeTerms);
	}

	// If no specific criteria parsed, default to all: true or text
	if (Object.keys(imapQuery).length === 0) {
		if (query) {
			imapQuery.text = query;
		} else {
			imapQuery.all = true;
		}
	}

	return {
		imapQuery,
		hasAttachment,
		fileName,
		rawTerms: terms,
	};
}
