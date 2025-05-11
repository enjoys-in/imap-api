
import { ImapConfig } from '@/utils/interfaces/imap.interface';
import { ImapFlow, ListResponse } from 'imapflow'
import { ParsedMail, simpleParser } from 'mailparser';

export class ImapService {

    private client: ImapFlow
    constructor(config: ImapConfig) {
        this.client = new ImapFlow({
            host: config.imap_host,
            port: 993,
            logger: false,
            secure: config.imap_secure ? true : false,
            auth: {
                user: config.imap_username,
                pass: config.imap_password,
            }
        });

    }
    getConnection() { return this.client }
    async authenticate() {
        return this.client.connect()
    }
    async logout() {
        return this.client.logout()
    }
    async listMailboxes() {
        return this.client.list()
    }
    async openedMailbox(mailbox: string = 'INBOX') {
        return this.client.mailboxOpen(mailbox)
    }
    async globalSync(email: string) {
        let emails: any = {};
        return new Promise(async (resolve, reject) => {
            !this.client.authenticated && await this.authenticate()
            const mailboxList = await this.listMailboxes()
            for (const mailbox of mailboxList) {
                try {

                    const searchResult = await this.listUnseenOnly()
                    const data = await this.selectMailbox(mailbox.path)
                    emails[mailbox.name] = {
                        info: mailbox,
                        total_count: data.totalCount,
                        uidNext: data.uidNext,
                        unseen_count: searchResult.length,
                        emails: data.emails.reverse(),
                        hasMore: data.hasMore
                    }

                } catch (e: any) {
                    reject(e)
                }
            }
            resolve({
                email,
                mailboxList,
                messages: emails,
            })
        })
    }
    async syncFolders(): Promise<({
        total_count: string,
        unseen_count: string,
    } & ListResponse)[] | null> {
        const mailboxList = await this.listMailboxes();
        const response: any[] = [];
        return new Promise(async (resolve, reject) => {
            let id = 1
            for (const mailbox of mailboxList) {
                try {
                    const searchResult = await this.listUnseenOnly()
                    const data = await this.selectMailbox(mailbox.path)
                    response.push({
                        id,
                        ...mailbox,
                        total_count: data.totalCount,
                        unseen_count: searchResult?.length || 0,
                    })
                    id++

                } catch (e: any) {
                    reject(e)
                }
            }
            resolve(response)
        })

    }
    async syncEmailsInMailbox(mailbox: string = 'INBOX') {
        return this.selectMailbox(mailbox)
    }
    async synceSingleFolder(mailbox: string = 'INBOX') {
        const emails = await this.openedMailbox(mailbox);
        const unseenCount = await this.listUnseenOnly();
        return {
            path: emails.path,
            name: mailbox,
            delimiter: emails.delimiter,
            flags: emails.flags,
            specialUse: emails.specialUse,
            listed: emails.listed,
            subscribed: emails.subscribed,
            total_count: emails.exists,
            unseen_count: unseenCount?.length
        }
    }
    async selectMailbox(mailbox: string = 'INBOX', start = 1,) {
        const { exists: totalCount, uidNext, uidValidity, mailboxId, flags } = await this.client.mailboxOpen(mailbox);
        let lock = await this.client.getMailboxLock(mailbox, {});
        let emails = [];
        const endSeq = totalCount - start;
        const startSeq = Math.max(endSeq - 50 + 1, 1);

        const range = `${startSeq}:${endSeq < 50 ? "*" : endSeq}`;
        try {
            const attachments: any = [];

            const checkForAttachments = (structure: any) => {
                if (Array.isArray(structure)) {
                    for (const part of structure) {
                        checkForAttachments(part);
                    }
                } else {
                    if (
                        structure.disposition &&
                        structure.disposition.type?.toLowerCase() === 'attachment'
                    ) {
                        attachments.push({
                            filename: structure.disposition?.params?.filename || 'unnamed',
                            mimeType: `${structure.type}/${structure.subtype}`
                        });
                    }
                }
            };

            for await (const message of this.client.fetch(range, {
                envelope: true,
                uid: true,
                flags: true,
                bodyStructure: true,

            })) {

                checkForAttachments(message.bodyStructure);

                emails.push({
                    message_id: message?.envelope?.messageId,
                    uid: message.uid,
                    type: message.bodyStructure?.type,
                    size: message.bodyStructure?.size,
                    subject: message?.envelope?.subject,
                    from: message?.envelope?.from?.map(f => f.address).join(', '),
                    to: message?.envelope?.to?.map(t => t.address).join(', '),
                    date: message?.envelope?.date,
                    flags: message.flags,
                    attachments
                });
            }
        } finally {
            lock.release();
        }

        return {
            emails,
            totalCount,
            hasMore: endSeq - 50 > 0,
            uidNext, uidValidity, flags
        };
    }
    async listUnseenOnly() {
        return this.client.search({ seen: false, }, { uid: true });
    }
    async searchMailbox() {
        return this.client.search({ seen: false, }, { uid: true });
    }

    async fetchMessages(mailbox: string = 'INBOX') {
        await this.client.mailboxOpen(mailbox);
        const messages = [];
        for await (let msg of this.client.fetch('1:*', { envelope: true, uid: true, flags: true, })) {
            messages.push(msg);
        }
        return messages;

    }
    async fetchMessageBody(mailbox: string = 'INBOX', uid: string, is_parsed: boolean = false) {
        await this.client.mailboxOpen(mailbox);
        const source = await this.client.download(uid);

        let mailchunks: any = null;

        if (is_parsed) {
            mailchunks = await simpleParser(source.content);
        } else {
            mailchunks = ''; // initialize as empty string
            await new Promise((resolve, reject) => {
                source.content.on('data', (chunk) => {
                    mailchunks += chunk.toString();
                });
                source.content.on('end', resolve);
                source.content.on('error', reject);
            });
        }

        return mailchunks;

    }
    async fetchMessageHeaders() { }
    async fetchMessageAttachments() { }

    async deleteMessages(uids: number[], mailbox = 'INBOX') {
        await this.client.mailboxOpen(mailbox);
        return this.client.messageDelete(uids);
    }
    async deleteAllMessages(mailbox = 'INBOX') {
        await this.client.mailboxOpen(mailbox);
        const uids = [];
        for await (let msg of this.client.fetch('1:*', { uid: true })) {
            uids.push(msg.uid);
        }
        if (uids.length) {
            await this.client.messageDelete(uids);
        }
    }
    async moveMessage(uid: number[], currentMailbox: string, targetMailbox: string) {
        await this.client.mailboxOpen(currentMailbox);
        await this.client.messageMove(uid, targetMailbox);
    }

    async moveAllMessages(currentMailbox: string, targetMailbox: string) {
        await this.client.mailboxOpen(currentMailbox);
        const uids = [];
        for await (let msg of this.client.fetch('1:*', { uid: true })) {
            uids.push(msg.uid);
        }
        if (uids.length) {
            await this.client.messageMove(uids, targetMailbox);
        }
    }
    async copyMailToOtherMailbox(uid: number[], destination: string) {
        return this.client.messageCopy(uid, destination);
    }

    async markAsRead(uid: number[]) {
        return this.client.messageFlagsAdd(uid, ['\\Seen']);
    }
    async markAsUnread(uid: number[]) {
        return this.client.messageFlagsRemove(uid, ['\\Seen']);
    }
    async markAllAsRead(mailbox: string) {
        await this.client.mailboxOpen(mailbox); // Select mailbox
        const uids = await this.client.search({ seen: false }); // Find unread
        if (uids.length === 0) return 'No unread messages in this mailbox.';
        return this.markAsRead(uids);
    }

    async markAllAsUnread(mailbox: string) {
        await this.client.mailboxOpen(mailbox); // Select mailbox
        const uids = await this.client.search({ seen: true }); // Find read
        if (uids.length === 0) return 'All messages are already unread.';
        return this.markAsUnread(uids);
    }
    async createMailbox(mailbox: string) {
        return this.client.mailboxCreate(mailbox);
    }

    async deleteMailbox(mailbox: string) {
        return this.client.mailboxDelete(mailbox);
    }

    async renameMailbox(oldName: string, newName: string) {
        return this.client.mailboxRename(oldName, newName);
    }

    async subscribeMailbox(mailbox: string) {
        return this.client.mailboxSubscribe(mailbox);
    }

    async unsubscribeMailbox(mailbox: string) {
        return this.client.mailboxUnsubscribe(mailbox);
    }

    async listSubscribedMailboxes() {
        // return this.client.listSubscribed();
    }

    async listMailboxStatuses() {
        const mailboxes = [];
        for await (const box of await this.client.list()) {
            mailboxes.push(box);
        }
        return mailboxes;
    }

    async getMailboxStatus(mailbox: string) {
        return this.client.status(mailbox, {
            messages: true,
            recent: true,
            unseen: true,
            uidNext: true,
            uidValidity: true
        });
    }

    // ----------- Quota Management -----------

    async getQuota(mailbox: string) {
        return this.client.getQuota(mailbox);
    }


}
