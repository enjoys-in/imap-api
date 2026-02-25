import { __CONFIG__ } from "@/app/config";
import { Security } from "@/utils/helpers/security";
import {
	AfterLoad,
	BeforeInsert,
	BeforeUpdate,
	Column,
	CreateDateColumn,
	Entity,
	PrimaryGeneratedColumn,
	UpdateDateColumn,
} from "typeorm";
const securityService = new Security();

@Entity("email_connections")
export class ImapUsersEmailConnectionEntity {
	private decrypted = false;

	@PrimaryGeneratedColumn()
	id!: number;

	@Column({ nullable: true })
	display_name!: string;

	// IMAP Config
	@Column()
	imap_host!: string;

	@Column()
	imap_port!: number;

	@Column({ default: false })
	imap_secure!: boolean;

	@Column()
	imap_username!: string;

	@Column()
	imap_password!: string;

	// SMTP Config
	@Column()
	smtp_host!: string;

	@Column()
	smtp_port!: number;

	@Column({ default: false })
	smtp_secure!: boolean;

	@Column()
	smtp_username!: string;

	@Column()
	smtp_password!: string;

	@Column({ default: true })
	first_time_setup!: boolean;

	// Flags & Sync Info
	@Column({ default: false })
	uses_same_credentials!: boolean;

	@Column({ type: "timestamp", nullable: true })
	last_synced_at!: Date;

	@Column({ nullable: true })
	sync_error!: string;

	@Column({ default: false })
	imap_configured!: boolean;

	@Column({ default: false })
	smtp_configured!: boolean;

	@CreateDateColumn({ name: "created_at" })
	created_at!: Date;

	@UpdateDateColumn({ name: "updated_at" })
	updated_at!: Date;

	@BeforeInsert()
	@BeforeUpdate()
	private encryptInfo() {
		this.imap_password = securityService
			.EncryptDecryptData(this.imap_password, __CONFIG__.SECRETS.APP_SECRET)
			.EncryptToString();
		this.smtp_password = securityService
			.EncryptDecryptData(this.smtp_password, __CONFIG__.SECRETS.APP_SECRET)
			.EncryptToString();
	}
	@AfterLoad()
	private decryptInfo(): void {
		if (!this.decrypted) {
			this.imap_password = securityService
				.EncryptDecryptData(this.imap_password, __CONFIG__.SECRETS.APP_SECRET)
				.DecryptFromString();

			this.smtp_password = securityService
				.EncryptDecryptData(this.smtp_password, __CONFIG__.SECRETS.APP_SECRET)
				.DecryptFromString();

			this.decrypted = true;
		}
	}
}
