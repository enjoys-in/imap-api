import type { ImapConfig } from "@/utils/interfaces/imap.interface";
import type { CapabilityManager } from "../services/CapabilityManager";
import { ImapService } from "../services/ImapService";

export class ImapFactory {
	private static instances: Map<string, ImapService> = new Map();

	static getOrCreate(useremail: string, config: ImapConfig): ImapService {
		if (!ImapFactory.instances.has(useremail)) {
			const service = new ImapService(config);
			ImapFactory.instances.set(useremail, service);
		}
		return ImapFactory.instances.get(useremail)!;
	}

	/**
	 * Get the CapabilityManager for a connected user.
	 * Returns null if the user has no active ImapService.
	 */
	static getCapabilities(useremail: string): CapabilityManager | null {
		const service = ImapFactory.instances.get(useremail);
		return service ? service.capabilities : null;
	}

	static async firstTimeSetup(config: ImapConfig) {
		const emails: any = {};
		const service = ImapFactory.getOrCreate(config.imap_username, config);
		if (!service.getConnection().authenticated) {
			await service.authenticate();
			// After authenticate(), capabilities are probed automatically
		}
		const mailboxList = await service.listMailboxes();
		for (const mailbox of mailboxList) {
			const searchResult = await service.listUnseenOnly();
			const data = await service.selectMailbox(mailbox.path);
			emails[mailbox.name] = {
				info: mailbox,
				total_count: data.totalCount,
				unseen_count: Array.isArray(searchResult) ? searchResult.length : 0,
				emails: data.emails.reverse(),
				hasMore: data.hasMore,
			};
		}
		return {
			email: config.imap_username,
			mailboxList,
			messages: emails,
			serverCapabilities: service.capabilities.toJSON(),
		};
	}

	static getAllDomains(): string[] {
		return Array.from(ImapFactory.instances.keys());
	}

	static getInstance(useremail: string): ImapService | undefined {
		return ImapFactory.instances.get(useremail);
	}

	static removeInstance(useremail: string): void {
		ImapFactory.instances.delete(useremail);
	}

	static clearAll(): void {
		ImapFactory.instances.clear();
	}
}
