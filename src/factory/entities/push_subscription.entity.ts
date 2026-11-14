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

@Entity("push_subscriptions")
export class PushSubscriptionEntity {
	@PrimaryGeneratedColumn()
	id!: number;

	@Index()
	@Column({ type: "int" })
	connection_id!: number;

	@ManyToOne(() => ImapUsersEmailConnectionEntity, { onDelete: "CASCADE" })
	@JoinColumn({ name: "connection_id" })
	connection?: ImapUsersEmailConnectionEntity;

	@Index({ unique: true })
	@Column({ type: "varchar", length: 1024 })
	endpoint!: string;

	@Column({ type: "varchar", length: 255 })
	p256dh!: string;

	@Column({ type: "varchar", length: 255 })
	auth!: string;

	@Column({ type: "varchar", length: 20, default: "all" })
	audience!: string;

	@Column({ type: "boolean", default: true })
	include_preview!: boolean;

	@Column({ type: "varchar", length: 255, nullable: true })
	user_agent!: string | null;

	@Column({ type: "timestamp", nullable: true })
	last_notified_at!: Date | null;

	@CreateDateColumn()
	created_at!: Date;

	@UpdateDateColumn()
	updated_at!: Date;
}
