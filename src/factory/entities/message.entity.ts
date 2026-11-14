import {
	Column,
	CreateDateColumn,
	Entity,
	Index,
	JoinColumn,
	ManyToOne,
	PrimaryGeneratedColumn,
	UpdateDateColumn,
} from "typeorm";
import type { AttachmentInfo } from "@/utils/interfaces/imap.interface";
import { MailboxEntity } from "./mailbox.entity";

const numeric = {
	to: (value?: number | null) => value,
	from: (value?: string | number | null) =>
		value === null || value === undefined ? value : Number(value),
};

@Entity("messages")
@Index(["mailbox_id", "uid"], { unique: true })
export class MessageEntity {
	@PrimaryGeneratedColumn({ type: "int" })
	id!: number;

	@Column({ type: "int" })
	mailbox_id!: number;

	@ManyToOne(() => MailboxEntity, { onDelete: "CASCADE" })
	@JoinColumn({ name: "mailbox_id" })
	mailbox!: MailboxEntity;

	@Column({ type: "bigint", transformer: numeric })
	uid!: number;

	@Column({ type: "varchar", length: 998, nullable: true })
	message_id!: string | null;

	@Column({ type: "text", nullable: true })
	subject!: string | null;

	@Column({ type: "text", nullable: true })
	from_address!: string | null;

	@Column({ type: "text", nullable: true })
	to_address!: string | null;

	@Column({ type: "timestamptz", nullable: true })
	date!: Date | null;

	@Column({ type: "bigint", nullable: true, transformer: numeric })
	size!: number | null;

	@Column({ type: "varchar", length: 100, nullable: true })
	content_type!: string | null;

	@Column({ type: "jsonb", default: () => "'[]'" })
	flags!: string[];

	@Column({ type: "jsonb", default: () => "'[]'" })
	attachments!: AttachmentInfo[];

	@CreateDateColumn({ name: "created_at" })
	created_at!: Date;

	@UpdateDateColumn({ name: "updated_at" })
	updated_at!: Date;
}
