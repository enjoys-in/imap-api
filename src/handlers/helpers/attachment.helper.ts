import { __CONFIG__ } from "@/app/config";
import type { AttachmentInfo } from "@/utils/interfaces/imap.interface";

export const PART_ID_PATTERN = /^\d+(\.\d+)*$/;

export function attachmentDownloadUrl(
	folder: string,
	uid: number | string,
	part: string,
): string {
	return `/api/${__CONFIG__.APP.API_VERSION}/imap/emails/${uid}/attachments/${part}?folder=${encodeURIComponent(folder)}`;
}

export function toClientAttachment(
	attachment: AttachmentInfo,
	folder: string,
	uid: number | string,
) {
	return {
		id: `att-${attachment.part}`,
		messageId: `msg-${uid}`,
		fileName: attachment.fileName,
		contentType: attachment.contentType,
		size: attachment.size,
		contentId: attachment.contentId,
		isInline: attachment.isInline,
		part: attachment.part,
		downloadUrl: attachmentDownloadUrl(folder, uid, attachment.part),
	};
}

export function contentDispositionAttachment(fileName: string): string {
	const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
	const encoded = encodeURIComponent(fileName).replace(
		/['()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
