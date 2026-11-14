import type { ImapConfig } from "@/utils/interfaces/imap.interface";
import type { CapabilityManager } from "../services/CapabilityManager";
import { ImapService } from "../services/ImapService";

export class ImapFactory {
	private static instances: Map<string, ImapService> = new Map();

	static getOrCreate(
		useremail: string,
		config: ImapConfig,
		mid?: number | string,
	): ImapService {
		const emailKey = useremail.toLowerCase();
		const midKey = mid !== undefined && mid !== null ? `mid:${mid}` : null;

		let service = ImapFactory.instances.get(emailKey);
		if (!service && midKey) {
			service = ImapFactory.instances.get(midKey);
		}

		if (!service) {
			service = new ImapService(config);
		}

		ImapFactory.instances.set(emailKey, service);
		if (midKey) {
			ImapFactory.instances.set(midKey, service);
		}

		return service;
	}

	/**
	 * Get the CapabilityManager for a connected user.
	 * Returns null if the user has no active ImapService.
	 */
	static getCapabilities(
		identifier: string | number,
	): CapabilityManager | null {
		const service = ImapFactory.getInstance(identifier);
		return service ? service.capabilities : null;
	}

	static async firstTimeSetup(config: ImapConfig, mid?: number | string) {
		const emails: any = {};
		const service = ImapFactory.getOrCreate(config.imap_username, config, mid);
		if (!service.isConnected()) {
			await service.authenticate();
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
		const keys = Array.from(ImapFactory.instances.keys());
		return keys.filter((k) => !k.startsWith("mid:"));
	}

	static getInstance(identifier?: string | number): ImapService | undefined {
		if (identifier === undefined || identifier === null) {
			return undefined;
		}
		const key = String(identifier).toLowerCase();
		let service = ImapFactory.instances.get(key);
		if (!service) {
			service = ImapFactory.instances.get(`mid:${key}`);
		}
		if (service) {
			service.touch();
		}
		return service;
	}

	static removeInstance(identifier?: string | number): void {
		if (identifier === undefined || identifier === null) {
			return;
		}
		const service = ImapFactory.getInstance(identifier);
		if (service) {
			try {
				service.removeAllListeners();
				service.getConnection()?.close?.();
			} catch (_) {}

			for (const [key, val] of ImapFactory.instances.entries()) {
				if (val === service) {
					ImapFactory.instances.delete(key);
				}
			}
		} else {
			const key = String(identifier).toLowerCase();
			ImapFactory.instances.delete(key);
			ImapFactory.instances.delete(`mid:${key}`);
		}
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
		for (const [key, service] of ImapFactory.instances) {
			if (
				!key.startsWith("mid:") &&
				!service.isIdling() &&
				now - service.lastActivity > maxIdleMs
			) {
				ImapFactory.removeInstance(key);
				evicted++;
			}
		}
		return evicted;
	}
}
