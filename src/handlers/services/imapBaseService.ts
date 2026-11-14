import { createTransport } from "nodemailer";
import { ImapFactory } from "../factory/ImapFactory";
import { formatImapError } from "../helpers/error.helper";
import { ImapService } from "./ImapService";
import { mailboxStorageService } from "./MailboxStorageService";

import { ImapUsersEmailConnectionEntity } from "@/factory/entities/imap.entity";
import { InjectRepository } from "@/factory/typeorm";
import type { ImapRequestBody } from "@/utils/interfaces/imap.interface";
import { ListResponse } from "imapflow";

const imapUser = InjectRepository(ImapUsersEmailConnectionEntity);

class ImapBaseService {
	async getUserEmail(useremail: string) {
		return imapUser.findOne({
			where: {
				imap_username: useremail,
				first_time_setup: false,
			},
		});
	}

	async getUserById(mid: number | string) {
		return imapUser.findOne({
			where: {
				id: Number(mid),
				first_time_setup: false,
			},
		});
	}

	configDTO(config: any) {
		return {
			imap_host: config.imap_host,
			imap_port: config.imap_port,
			imap_secure: config.imap_secure,
			imap_username: config.imap_username,
			imap_password: config.imap_password,
			smtp_host: config.smtp_host,
			smtp_port: config.smtp_port,
			smtp_secure: config.smtp_secure,
			smtp_username: config.smtp_username,
			smtp_password: config.smtp_password,
		};
	}

	async loginUser(config: ImapRequestBody, mid?: number | string) {
		try {
			const imap = ImapFactory.getOrCreate(config.imap_username, config, mid);

			if (!imap.isConnected()) {
				await imap.authenticate();
			}
			const data = await imap.syncFolders();

			if (mid && data) {
				await mailboxStorageService.saveMailboxes(Number(mid), data);
			}

			return data;
		} catch (error: any) {
			throw new Error(error);
		}
	}

	async setupUser(
		config: Omit<ImapRequestBody, "uses_separate_credentials">,
		skipSMTP: string | undefined = undefined,
		mid?: number | string,
	) {
		let imap_configured = false;
		let smtp_configured = false;
		let data: any[] | null = null;
		try {
			const imap = ImapFactory.getOrCreate(config.imap_username, config, mid);

			if (!imap.isConnected()) {
				await imap.authenticate();
			}
			data = await imap.syncFolders();

			if (mid && data) {
				await mailboxStorageService.saveMailboxes(Number(mid), data);
			}

			imap_configured = true;

			if (!skipSMTP || skipSMTP !== "1") {
				const transport = createTransport({
					host: config.smtp_host,
					port: config.smtp_port,
					secure: config.smtp_secure,
					auth: {
						user: config.smtp_username,
						pass: config.smtp_password,
					},
				});
				smtp_configured = Boolean(await transport.verify());
			}

			return {
				imap_configured,
				smtp_configured,
				data,
			};
		} catch (error: any) {
			// Never report a half-finished setup as success: callers must see the
			// failure so they do not create a session (cookie/token) for it.
			const stage = imap_configured
				? "SMTP verification failed"
				: "IMAP setup failed";
			throw new Error(`${stage}: ${formatImapError(error)}`);
		}
	}
	async insertIntoDb(config: Partial<ImapUsersEmailConnectionEntity>) {
		const instance = imapUser.create({
			...config,
			first_time_setup: false,
			last_synced_at: new Date(),
		});
		return imapUser.save(instance);
	}

	async upsertUser(config: Partial<ImapUsersEmailConnectionEntity>) {
		const existingUser = await this.getUserEmail(
			config.imap_username as string,
		);
		if (existingUser) {
			existingUser.imap_host = config.imap_host ?? existingUser.imap_host;
			existingUser.imap_port = config.imap_port ?? existingUser.imap_port;
			existingUser.imap_secure = config.imap_secure ?? existingUser.imap_secure;
			existingUser.imap_username =
				config.imap_username ?? existingUser.imap_username;
			if (config.imap_password) {
				existingUser.imap_password = config.imap_password;
			}
			existingUser.smtp_host = config.smtp_host ?? existingUser.smtp_host;
			existingUser.smtp_port = config.smtp_port ?? existingUser.smtp_port;
			existingUser.smtp_secure = config.smtp_secure ?? existingUser.smtp_secure;
			existingUser.smtp_username =
				config.smtp_username ?? existingUser.smtp_username;
			if (config.smtp_password) {
				existingUser.smtp_password = config.smtp_password;
			}
			if (config.display_name) {
				existingUser.display_name = config.display_name;
			}
			existingUser.imap_configured = config.imap_configured ?? true;
			existingUser.smtp_configured = config.smtp_configured ?? true;
			existingUser.first_time_setup = false;
			existingUser.last_synced_at = new Date();
			return imapUser.save(existingUser);
		}

		return this.insertIntoDb(config);
	}
}

export default new ImapBaseService();
