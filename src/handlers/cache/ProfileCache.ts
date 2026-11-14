import type { ICacheEngine } from "./interfaces/ICacheEngine";

export interface ProfilePrimary extends ICacheEngine {
	readonly available: boolean;
}

export class ProfileCache {
	constructor(
		private readonly primary: ProfilePrimary | null,
		private readonly fallback: ICacheEngine,
	) {}

	private key(email: string): string {
		return `profile:${email.toLowerCase()}`;
	}

	async get<T = any>(email: string): Promise<T | undefined> {
		const key = this.key(email);
		if (this.primary?.available) {
			const value = await this.primary.get<T>(key);
			if (value !== undefined) {
				return value;
			}
		}
		return this.fallback.get<T>(key);
	}

	async set(email: string, value: unknown, ttlSeconds: number): Promise<void> {
		const key = this.key(email);
		if (this.primary?.available) {
			await this.primary.set(key, value, ttlSeconds);
			await this.fallback.delete(key);
			return;
		}
		await this.fallback.set(key, value, ttlSeconds);
	}

	async invalidate(email: string): Promise<void> {
		const key = this.key(email);
		await Promise.all([
			this.primary?.available
				? this.primary.delete(key).catch(() => false)
				: undefined,
			this.fallback.delete(key),
		]);
	}
}
