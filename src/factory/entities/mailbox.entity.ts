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

@Entity("mailboxes")
@Index(["connection_id", "path"], { unique: true })
export class MailboxEntity {
	@PrimaryGeneratedColumn({ type: "int" })
	id!: number;

	@Index()
	@Column({ type: "int" })
	connection_id!: number;

	@ManyToOne(() => ImapUsersEmailConnectionEntity, { onDelete: "CASCADE" })
	@JoinColumn({ name: "connection_id" })
	connection!: ImapUsersEmailConnectionEntity;

	@Column({ type: "varchar", length: 255 })
	name!: string;

	@Column({ type: "varchar", length: 500 })
	path!: string;

	@Column({ type: "varchar", length: 10, default: "/" })
	delimiter!: string;

	@Column({ type: "varchar", length: 50, nullable: true })
	special_use!: string | null;

	@Column({ type: "boolean", default: false })
	listed!: boolean;

	@Column({ type: "boolean", default: false })
	subscribed!: boolean;

	@Column({ type: "int", default: 0 })
	total_count!: number;

	@Column({ type: "int", default: 0 })
	unseen_count!: number;

	@Column({ type: "bigint", nullable: true })
	uid_validity!: string | number | null;

	@Column({ type: "int", nullable: true })
	uid_next!: number | null;

	@Column({ type: "varchar", length: 100, nullable: true })
	highest_modseq!: string | null;

	@CreateDateColumn({ name: "created_at" })
	created_at!: Date;

	@UpdateDateColumn({ name: "updated_at" })
	updated_at!: Date;
}
