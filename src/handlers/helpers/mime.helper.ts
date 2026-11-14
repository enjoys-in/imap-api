const INLINE_IMAGE_MAX_BYTES = 256 * 1024;
const INLINE_TOTAL_MAX_BYTES = 1024 * 1024;

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const escapeRegExp = (value: string) =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const plainTextToHtml = (text: string) =>
	`<pre style="font-family: inherit; white-space: pre-wrap;">${escapeHtml(text)}</pre>`;

function inlineCidImages(html: string, mailAttachments: any[] | undefined) {
	let total = 0;
	let output = html;
	for (const attachment of mailAttachments ?? []) {
		const cid = String(attachment.cid || attachment.contentId || "").replace(
			/^<|>$/g,
			"",
		);
		const content = attachment.content;
		if (
			!cid ||
			!/^image\//i.test(attachment.contentType || "") ||
			!Buffer.isBuffer(content) ||
			content.length > INLINE_IMAGE_MAX_BYTES ||
			total + content.length > INLINE_TOTAL_MAX_BYTES
		) {
			continue;
		}
		total += content.length;
		const dataUri = `data:${attachment.contentType};base64,${content.toString("base64")}`;
		for (const variant of new Set([cid, encodeURIComponent(cid)])) {
			output = output.replace(
				new RegExp(`cid:${escapeRegExp(variant)}`, "gi"),
				() => dataUri,
			);
		}
	}
	return output;
}

/**
 * Normalizes parsed MIME message bodies (from mailparser / simpleParser)
 * or raw fallback strings into clean bodyHtml, bodyText, and attachments list.
 */
export function normalizeEmailBody<A = unknown>(
	parsed: any,
	attachments: A[] = [],
): {
	bodyHtml: string;
	bodyText: string;
	attachments: A[];
	raw?: string;
} {
	let bodyHtml = "";
	let bodyText = "";

	if (typeof parsed === "object" && parsed !== null) {
		bodyText = parsed.text || "";
		bodyHtml = parsed.html
			? inlineCidImages(parsed.html, parsed.attachments)
			: parsed.textAsHtml || (bodyText ? plainTextToHtml(bodyText) : "");
	} else if (typeof parsed === "string") {
		bodyText = parsed;
		bodyHtml = plainTextToHtml(parsed);
	}

	return {
		bodyHtml,
		bodyText,
		attachments,
		raw: typeof parsed === "string" ? parsed : undefined,
	};
}
