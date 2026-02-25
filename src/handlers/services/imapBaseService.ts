import { createTransport } from "nodemailer";
import { ImapService } from "./ImapService";

import { ImapFactory } from "../factory/ImapFactory";

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
	async loginUser(config: ImapRequestBody) {
		try {
			const imap = ImapFactory.getOrCreate(config.imap_username, config);

			!(await imap.getConnection().authenticated) &&
				(await imap.authenticate());
			const data = await imap.syncFolders();

			return data;
		} catch (error: any) {
			throw new Error(error);
		}
	}
	async setupUser(
		config: Omit<ImapRequestBody, "uses_separate_credentials">,
		skipSMTP: string | undefined = undefined,
	) {
		let imap_configured = false;
		let smtp_configured = false;
		let data: any[] | null = null;
		try {
			const imap = ImapFactory.getOrCreate(config.imap_username, config);

			if (imap.getConnection().authenticated) {
				data = await imap.syncFolders();
				await imap.logout();
				imap.getConnection().close();
			} else {
				await imap.authenticate();
				data = await imap.syncFolders();
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
				const response = await transport.verify();
				if (!response) {
					smtp_configured = false;
				}
			}

			return {
				imap_configured,
				smtp_configured,
				data,
			};
		} catch (error: any) {
			return {
				imap_configured,
				smtp_configured,
				data,
			};
		}
	}
	async insertIntoDb(config: Partial<ImapUsersEmailConnectionEntity>) {
		const instance = imapUser.create({
			...config,
			first_time_setup: false,
			last_synced_at: new Date().toISOString(),
		});
		return imapUser.save(instance);
	}
}

export default new ImapBaseService();
