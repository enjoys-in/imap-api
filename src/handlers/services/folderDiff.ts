import type { MailboxEntity } from "@/factory/entities";
import type { FolderStatus } from "./ImapService";

export type CountedFolder = Pick<
	MailboxEntity,
	"total_count" | "unseen_count" | "uid_next" | "uid_validity" | "highest_modseq"
>;

export const folderDiffers = (
	row: CountedFolder,
	status: NonNullable<FolderStatus["status"]>,
) =>
	Number(row.total_count) !== status.messages ||
	Number(row.unseen_count) !== status.unseen ||
	row.uid_next === null ||
	row.uid_next === undefined ||
	Number(row.uid_next) !== status.uidNext ||
	row.uid_validity === null ||
	row.uid_validity === undefined ||
	Number(row.uid_validity) !== status.uidValidity ||
	(status.highestModseq !== null &&
		row.highest_modseq !== null &&
		row.highest_modseq !== undefined &&
		String(row.highest_modseq) !== status.highestModseq);
