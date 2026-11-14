import {
	Column,
	CreateDateColumn,
	Entity,
	Index,
	PrimaryGeneratedColumn,
	UpdateDateColumn,
} from "typeorm";

@Entity("automatic_replies")
export class AutomaticReplyEntity {
	@PrimaryGeneratedColumn()
	id!: number;

	@Index({ unique: true })
	@Column({ type: "varchar", length: 255 })
	account_email!: string;

	@Column({ type: "boolean", default: false })
	is_enabled!: boolean;

	// Scheduling Window
	@Column({ type: "boolean", default: false })
	only_during_period!: boolean;

	@Column({ type: "timestamp", nullable: true })
	start_time!: Date | null;

	@Column({ type: "timestamp", nullable: true })
	end_time!: Date | null;

	@Column({ type: "varchar", length: 64, default: "UTC" })
	time_zone!: string;

	// Audience Filters
	@Column({ type: "boolean", default: false })
	only_contacts!: boolean;

	@Column({ type: "boolean", default: true })
	reply_outside_org!: boolean;

	// Message Content
	@Column({ type: "text" })
	message_text!: string;

	@Column({ type: "text", nullable: true })
	message_html!: string | null;

	// Delivery Policies
	@Column({ type: "int", default: 1 })
	rate_limit_days!: number;

	@Column({ type: "boolean", default: false })
	block_calendar!: boolean;

	@Column({ type: "boolean", default: false })
	decline_new_invitations!: boolean;

	@CreateDateColumn({ name: "created_at" })
	created_at!: Date;

	@UpdateDateColumn({ name: "updated_at" })
	updated_at!: Date;
}
