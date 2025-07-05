import { ImapConfig } from '@/utils/interfaces/imap.interface';
import { ImapService } from '../services/ImapService';



export class ImapFactory {
    private static instances: Map<string, ImapService> = new Map();

    static getOrCreate(useremail: string, config: ImapConfig): ImapService {
        if (!this.instances.has(useremail)) {
            const service = new ImapService(config);          
            this.instances.set(useremail, service);
        }
        return this.instances.get(useremail)!;
    }
    static async firstTimeSetup(config: ImapConfig) {
        let emails: any = {};
        const service = ImapFactory.getOrCreate(config.imap_username, config)
        return new Promise(async (resolve, reject) => {

            !(await service.getConnection().authenticated) && await service.authenticate()
            const mailboxList = await service.listMailboxes()
            for (const mailbox of mailboxList) {
                try {
                    const searchResult = await service.listUnseenOnly()
                    const data = await service.selectMailbox(mailbox.path)
                    emails[mailbox.name] = {
                        info: mailbox,
                        total_count: data.totalCount,
                        unseen_count: searchResult?.length || 0,
                        emails: data.emails.reverse(),
                        hasMore: data.hasMore
                    }

                } catch (e: any) {
                    reject(e)
                }
            }
            resolve({
                email: config.imap_username,
                mailboxList,
                messages: emails,
            })
        })


    }

    static getAllDomains(): string[] {
        return Array.from(this.instances.keys());
    }

    static getInstance(useremail: string): ImapService | undefined {
        return this.instances.get(useremail);
    }

    static removeInstance(useremail: string): void {
        this.instances.delete(useremail);
    }

    static clearAll(): void {
        this.instances.clear();
    }
}
