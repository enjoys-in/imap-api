/**
 * Unified Cache Engine Interface.
 *
 * Provides a standardized contract for all pluggable storage engines
 * (In-Memory Process Cache, Redis, and RocksDB).
 */
export interface CacheEntryMetadata<T = any> {
	value: T;
	expiresAt: number;
	createdAt: number;
}

export interface ICacheEngine {
	/** Identifier name of the active storage engine (e.g. 'memory', 'redis', 'rocksdb') */
	readonly name: string;

	/**
	 * Retrieve a cached item.
	 * Returns undefined if key is missing or expired.
	 */
	get<T = any>(key: string): Promise<T | undefined>;

	/**
	 * Store a value with an optional TTL in seconds.
	 */
	set<T = any>(key: string, value: T, ttlSeconds?: number): Promise<void>;

	/**
	 * Check if a key exists and has not expired.
	 */
	has(key: string): Promise<boolean>;

	/**
	 * Delete a specific key from the cache.
	 */
	delete(key: string): Promise<boolean>;

	/**
	 * Delete all keys matching a specific prefix.
	 */
	deletePrefix(prefix: string): Promise<number>;

	/**
	 * Clear all entries in the cache.
	 */
	clear(): Promise<void>;

	/**
	 * Optional cleanup or graceful teardown on application shutdown.
	 */
	close?(): Promise<void>;
}
