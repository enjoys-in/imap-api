import type {
	CacheEntryMetadata,
	ICacheEngine,
} from "../interfaces/ICacheEngine";

export interface MemoryCacheEngineOptions {
	maxSize?: number;
	defaultTtlMs?: number;
	sweepIntervalMs?: number;
}

/**
 * High-performance In-Memory Storage Engine with LRU eviction
 * and unref-bound active sweep timers.
 */
export class MemoryCacheEngine implements ICacheEngine {
	readonly name = "memory";
	private readonly entries = new Map<string, CacheEntryMetadata<any>>();
	private readonly maxSize: number;
	private readonly defaultTtlMs: number;
	private sweepTimer: NodeJS.Timeout | null = null;

	constructor(options: MemoryCacheEngineOptions = {}) {
		this.maxSize = options.maxSize ?? 5000;
		this.defaultTtlMs = options.defaultTtlMs ?? 5 * 60 * 1000;

		const sweepIntervalMs = options.sweepIntervalMs ?? 60 * 1000;
		if (sweepIntervalMs > 0) {
			this.sweepTimer = setInterval(() => {
				this.sweepExpired();
			}, sweepIntervalMs);

			if (this.sweepTimer.unref) {
				this.sweepTimer.unref();
			}
		}
	}

	async get<T = any>(key: string): Promise<T | undefined> {
		const entry = this.entries.get(key);
		if (!entry) return undefined;

		const now = Date.now();
		if (now > entry.expiresAt) {
			this.entries.delete(key);
			return undefined;
		}

		return entry.value as T;
	}

	async set<T = any>(
		key: string,
		value: T,
		ttlSeconds?: number,
	): Promise<void> {
		const ttlMs =
			ttlSeconds !== undefined ? ttlSeconds * 1000 : this.defaultTtlMs;
		const now = Date.now();

		if (!this.entries.has(key) && this.entries.size >= this.maxSize) {
			this.evictOldest();
		}

		this.entries.set(key, {
			value,
			expiresAt: now + ttlMs,
			createdAt: now,
		});
	}

	async has(key: string): Promise<boolean> {
		const val = await this.get(key);
		return val !== undefined;
	}

	async delete(key: string): Promise<boolean> {
		return this.entries.delete(key);
	}

	async deletePrefix(prefix: string): Promise<number> {
		let removed = 0;
		for (const key of this.entries.keys()) {
			if (key.startsWith(prefix)) {
				this.entries.delete(key);
				removed++;
			}
		}
		return removed;
	}

	async clear(): Promise<void> {
		this.entries.clear();
	}

	async close(): Promise<void> {
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = null;
		}
		this.entries.clear();
	}

	private sweepExpired(): number {
		const now = Date.now();
		let swept = 0;
		for (const [key, entry] of this.entries.entries()) {
			if (now > entry.expiresAt) {
				this.entries.delete(key);
				swept++;
			}
		}
		return swept;
	}

	private evictOldest(): void {
		let oldestKey: string | null = null;
		let oldestTime = Number.POSITIVE_INFINITY;

		for (const [key, entry] of this.entries.entries()) {
			if (entry.createdAt < oldestTime) {
				oldestTime = entry.createdAt;
				oldestKey = key;
			}
		}

		if (oldestKey) {
			this.entries.delete(oldestKey);
		}
	}
}
