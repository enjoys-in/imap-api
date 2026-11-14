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
import { ImapUsersEmailConnectionEntity } from "./imap.entity";

@Entity("mailbox_quotas")
@Index(["connection_id", "mailbox"], { unique: true })
export class MailboxQuotaEntity {
	@PrimaryGeneratedColumn({ type: "int" })
	id!: number;

	@Index()
	@Column({ type: "int" })
	connection_id!: number;

	@ManyToOne(() => ImapUsersEmailConnectionEntity, { onDelete: "CASCADE" })
	@JoinColumn({ name: "connection_id" })
	connection!: ImapUsersEmailConnectionEntity;

	@Column({ type: "varchar", length: 255, default: "INBOX" })
	mailbox!: string;

	@Column({ type: "bigint", default: 0 })
	storage_used!: string | number;

	@Column({ type: "bigint", default: 0 })
	storage_limit!: string | number;

	@Column({ type: "decimal", precision: 5, scale: 2, default: 0.0 })
	storage_percentage!: number;

	@Column({ type: "int", default: 0 })
	messages_used!: number;

	@Column({ type: "int", default: 0 })
	messages_limit!: number;

	@CreateDateColumn({ name: "created_at" })
	created_at!: Date;

	@UpdateDateColumn({ name: "updated_at" })
	updated_at!: Date;
}
