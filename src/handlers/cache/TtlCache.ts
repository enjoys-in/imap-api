interface CacheEntry<V> {
	value: V;
	expiresAt: number;
	createdAt: number;
}

export interface TtlCacheOptions {
	/** Maximum number of entries before oldest entries are evicted. Defaults to 1000. */
	maxSize?: number;
	/** Default TTL in milliseconds. Defaults to 5 minutes (300,000 ms). */
	defaultTtlMs?: number;
	/** Periodic sweep interval in milliseconds. Defaults to 60 seconds (60,000 ms). */
	sweepIntervalMs?: number;
}

/**
 * Memory-safe TTL Cache with automatic periodic eviction,
 * LRU-style size bounding, and unreferenced sweep timers
 * to prevent memory leaks in long-running Node.js processes.
 */
export class TtlCache<V = any> {
	private readonly entries = new Map<string, CacheEntry<V>>();
	private readonly maxSize: number;
	private readonly defaultTtlMs: number;
	private sweepTimer: NodeJS.Timeout | null = null;

	constructor(options: TtlCacheOptions = {}) {
		this.maxSize = options.maxSize ?? 1000;
		this.defaultTtlMs = options.defaultTtlMs ?? 5 * 60 * 1000;

		const sweepIntervalMs = options.sweepIntervalMs ?? 60 * 1000;
		if (sweepIntervalMs > 0) {
			this.sweepTimer = setInterval(() => {
				this.sweepExpired();
			}, sweepIntervalMs);

			// Unref timer so it doesn't prevent Node process from exiting
			if (this.sweepTimer.unref) {
				this.sweepTimer.unref();
			}
		}
	}

	/**
	 * Retrieve a cached item. Returns undefined if missing or expired.
	 */
	get(key: string): V | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;

		const now = Date.now();
		if (now > entry.expiresAt) {
			this.entries.delete(key);
			return undefined;
		}

		return entry.value;
	}

	/**
	 * Store an item with an optional TTL in seconds.
	 */
	set(key: string, value: V, ttlSeconds?: number): void {
		const ttlMs =
			ttlSeconds !== undefined ? ttlSeconds * 1000 : this.defaultTtlMs;
		const now = Date.now();

		// If entry exists, update it; otherwise bound size before inserting
		if (!this.entries.has(key) && this.entries.size >= this.maxSize) {
			this.evictOldest();
		}

		this.entries.set(key, {
			value,
			expiresAt: now + ttlMs,
			createdAt: now,
		});
	}

	/**
	 * Check if a key exists and is not expired.
	 */
	has(key: string): boolean {
		return this.get(key) !== undefined;
	}

	/**
	 * Delete a specific key.
	 */
	delete(key: string): boolean {
		return this.entries.delete(key);
	}

	/**
	 * Delete all keys starting with a given prefix.
	 */
	deletePrefix(prefix: string): number {
		let removed = 0;
		for (const key of this.entries.keys()) {
			if (key.startsWith(prefix)) {
				this.entries.delete(key);
				removed++;
			}
		}
		return removed;
	}

	/**
	 * Delete all keys matching a regular expression.
	 */
	deletePattern(pattern: RegExp): number {
		let removed = 0;
		for (const key of this.entries.keys()) {
			if (pattern.test(key)) {
				this.entries.delete(key);
				removed++;
			}
		}
		return removed;
	}

	/**
	 * Clear all entries.
	 */
	clear(): void {
		this.entries.clear();
	}

	/**
	 * Current number of entries in the cache.
	 */
	size(): number {
		return this.entries.size;
	}

	/**
	 * Evict expired entries.
	 */
	private sweepExpired(): number {
		const now = Date.now();
		let removed = 0;
		for (const [key, entry] of this.entries) {
			if (now > entry.expiresAt) {
				this.entries.delete(key);
				removed++;
			}
		}
		return removed;
	}

	/**
	 * Evict oldest entries when cache hits max capacity.
	 */
	private evictOldest(): void {
		// Map iterator returns keys in insertion order; first is oldest
		const firstKey = this.entries.keys().next().value;
		if (firstKey !== undefined) {
			this.entries.delete(firstKey);
		}
	}

	/**
	 * Destroy cache and clear the periodic sweep timer.
	 */
	destroy(): void {
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = null;
		}
		this.entries.clear();
	}
}
