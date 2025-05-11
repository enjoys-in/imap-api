
import { createTransport } from "nodemailer";
import { ImapService } from "./ImapService";

import { ImapFactory } from "../factory/ImapFactory";

import { InjectRepository } from "@/factory/typeorm";
import { ImapUsersEmailConnectionEntity } from "@/factory/entities/imap.entity";
import { ImapRequestBody } from "@/utils/interfaces/imap.interface";



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
        }
    }
    async setupUser(config: Omit<ImapRequestBody, "uses_separate_credentials">) {
        try {
            const imap = new ImapService({
                imap_host: config.imap_host,
                imap_port: config.imap_port,
                imap_secure: config.imap_secure,
                imap_username: config.imap_username,
                imap_password: config.imap_password,
            })
            await imap.authenticate()
            const data = await imap.syncFolders()

            imap.getConnection().authenticated && await imap.logout()
            const transport = createTransport({
                host: config.smtp_host,
                port: config.smtp_port,
                secure: config.smtp_secure,
                auth: {
                    user: config.smtp_username,
                    pass: config.smtp_password,
                },
                tls: {
                    rejectUnauthorized: false,
                },
            });
            const response = await transport.verify()
            if (!response) {
                throw new Error("SMTP connection failed");
            }

            return data
        } catch (error: any) {
            throw new Error(error.message);
        }
    }
    async insertIntoDb(config: ImapRequestBody) {

        // Insert in DB and update first time setup status

        return imapUser.save({
            ...config,
            first_time_setup: false,
            last_synced_at: new Date().toISOString(),
        });
        ;
    }
    // @OnEvent("imap.create.user")
    // private createImapUser(payload: string) {
    //     const config = JSON.parse(payload)
    //     this.insertIntoDb({
    //         ...config,
    //         imap_host: __CONFIG__.SMTP_SERVER_HOST,
    //         imap_port: 993,
    //         imap_secure: true,
    //         smtp_host: __CONFIG__.SMTP_SERVER_HOST,
    //         smtp_port: 587,
    //         smtp_secure: false,
    //         smtp_username: config.email,
    //         smtp_password: config.password,
    //         imap_password: config.password,
    //         imap_username: config.email,
    //         display_name: config.name
    //     })
    // }
    // @OnEvent("imap.sync.user", { async: true })
    // private syncUserData(payload: string) {
    //     const config = JSON.parse(payload)
    //     ImapFactory.firstTimeSetup(config)
    // }
}

export default new ImapBaseService()