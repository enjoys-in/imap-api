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
		const service = ImapFactory.instances.get(useremail);
		if (service) {
			service.touch();
		}
		return service;
	}

	static removeInstance(useremail: string): void {
		const service = ImapFactory.instances.get(useremail);
		if (service) {
			try {
				service.removeAllListeners();
				service.getConnection()?.close?.();
			} catch (_) {}
		}
		ImapFactory.instances.delete(useremail);
	}

	static clearAll(): void {
		for (const [, service] of ImapFactory.instances) {
			try {
				service.removeAllListeners();
				service.getConnection()?.close?.();
			} catch (_) {}
		}
		ImapFactory.instances.clear();
	}

	/**
	 * Cleans up idle connections that have had no activity for `maxIdleMs`
	 * (default: 30 minutes) and are not actively IDLE-listening.
	 */
	static cleanupIdle(maxIdleMs = 30 * 60 * 1000): number {
		const now = Date.now();
		let evicted = 0;
		for (const [useremail, service] of ImapFactory.instances) {
			if (!service.isIdling() && now - service.lastActivity > maxIdleMs) {
				ImapFactory.removeInstance(useremail);
				evicted++;
			}
		}
		return evicted;
	}
}
