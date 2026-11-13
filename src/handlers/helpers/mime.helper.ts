/**
 * Normalizes parsed MIME message bodies (from mailparser / simpleParser)
 * or raw fallback strings into clean bodyHtml, bodyText, and attachments list.
 */
export function normalizeEmailBody(parsed: any): {
	bodyHtml: string;
	bodyText: string;
	attachments: any[];
	raw?: string;
} {
	let bodyHtml = "";
	let bodyText = "";
	let attachments: any[] = [];

	if (typeof parsed === "object" && parsed !== null) {
		bodyHtml =
			parsed.html ||
			parsed.textAsHtml ||
			(parsed.text
				? `<pre style="font-family: inherit; white-space: pre-wrap;">${parsed.text}</pre>`
				: "");
		bodyText = parsed.text || "";

		if (Array.isArray(parsed.attachments)) {
			attachments = parsed.attachments.map((att: any, idx: number) => ({
				id: att.cid || `att-${idx}`,
				filename: att.filename || `attachment-${idx}`,
				contentType: att.contentType || "application/octet-stream",
				size: att.size || (att.content ? att.content.length : 0),
				contentId: att.cid || null,
			}));
		}
	} else if (typeof parsed === "string") {
		bodyText = parsed;
		bodyHtml = `<pre style="font-family: inherit; white-space: pre-wrap;">${parsed}</pre>`;
	}

	return {
		bodyHtml,
		bodyText,
		attachments,
		raw: typeof parsed === "string" ? parsed : undefined,
	};
}
