import { __CONFIG__ } from "@/app/config";
import { Logging } from "@/logs";
import { type RedisClientType, createClient } from "redis";
import type { ICacheEngine } from "../interfaces/ICacheEngine";

export interface RedisCacheEngineOptions {
	url?: string;
	prefix?: string;
	client?: RedisClientType;
	defaultTtlSeconds?: number;
}

/**
 * Distributed Redis Storage Engine implementing ICacheEngine.
 * Provides resilient, TTL-bound caching with automatic JSON serialization,
 * non-blocking prefix scanning, and connection fault tolerance.
 */
export class RedisCacheEngine implements ICacheEngine {
	readonly name = "redis";
	private client: RedisClientType;
	private readonly prefix: string;
	private readonly defaultTtlSeconds: number;
	private isConnected = false;
	private isConnecting = false;

	get available(): boolean {
		return this.isConnected && this.client.isOpen;
	}

	constructor(options: RedisCacheEngineOptions = {}) {
		this.prefix = options.prefix ?? "imap:";
		this.defaultTtlSeconds = options.defaultTtlSeconds ?? 300;

		if (options.client) {
			this.client = options.client;
			this.isConnected = options.client.isOpen;
		} else {
			const rawHost = __CONFIG__.CACHE.CACHE_HOST || "127.0.0.1";
			const rawPort = __CONFIG__.CACHE.CACHE_PORT || 6379;
			const url =
				options.url ||
				(rawHost.startsWith("redis://")
					? new URL(rawHost).port
						? rawHost
						: `${rawHost}:${rawPort}`
					: `redis://${rawHost}:${rawPort}`);

			this.client = createClient({ url }) as RedisClientType;

			this.client.on("connect", () => {
				this.isConnected = true;
				this.isConnecting = false;
				Logging.dev("[RedisCacheEngine] Connected to Redis");
			});

			this.client.on("ready", () => {
				this.isConnected = true;
			});

			this.client.on("error", (err) => {
				this.isConnected = false;
				Logging.dev(`[RedisCacheEngine] Redis error: ${err.message}`);
			});

			this.client.on("end", () => {
				this.isConnected = false;
			});

			this.ensureConnected();
		}
	}

	private async ensureConnected(): Promise<boolean> {
		if (this.isConnected && this.client.isOpen) {
			return true;
		}
		if (this.isConnecting) {
			return false;
		}
		try {
			this.isConnecting = true;
			await this.client.connect();
			this.isConnected = true;
			this.isConnecting = false;
			return true;
		} catch (error: any) {
			this.isConnected = false;
			this.isConnecting = false;
			Logging.dev(
				`[RedisCacheEngine] Connection attempt failed: ${error?.message || error}`,
			);
			return false;
		}
	}

	private prefixedKey(key: string): string {
		return `${this.prefix}${key}`;
	}

	async get<T = any>(key: string): Promise<T | undefined> {
		try {
			if (!this.isConnected && !this.client.isOpen) {
				const connected = await this.ensureConnected();
				if (!connected) return undefined;
			}

			const raw = await this.client.get(this.prefixedKey(key));
			if (!raw) return undefined;

			try {
				return JSON.parse(raw) as T;
			} catch {
				return raw as unknown as T;
			}
		} catch (error: any) {
			Logging.dev(
				`[RedisCacheEngine] get("${key}") failed: ${error?.message || error}`,
			);
			return undefined;
		}
	}

	async set<T = any>(
		key: string,
		value: T,
		ttlSeconds?: number,
	): Promise<void> {
		try {
			if (!this.isConnected && !this.client.isOpen) {
				const connected = await this.ensureConnected();
				if (!connected) return;
			}

			const serialized =
				typeof value === "string" ? value : JSON.stringify(value);
			const ttl = ttlSeconds ?? this.defaultTtlSeconds;

			if (ttl > 0) {
				await this.client.set(this.prefixedKey(key), serialized, { EX: ttl });
			} else {
				await this.client.set(this.prefixedKey(key), serialized);
			}
		} catch (error: any) {
			Logging.dev(
				`[RedisCacheEngine] set("${key}") failed: ${error?.message || error}`,
			);
		}
	}

	async has(key: string): Promise<boolean> {
		try {
			if (!this.isConnected && !this.client.isOpen) {
				const connected = await this.ensureConnected();
				if (!connected) return false;
			}

			const count = await this.client.exists(this.prefixedKey(key));
			return count > 0;
		} catch {
			return false;
		}
	}

	async delete(key: string): Promise<boolean> {
		try {
			if (!this.isConnected && !this.client.isOpen) {
				const connected = await this.ensureConnected();
				if (!connected) return false;
			}

			const deleted = await this.client.del(this.prefixedKey(key));
			return deleted > 0;
		} catch {
			return false;
		}
	}

	async deletePrefix(prefix: string): Promise<number> {
		try {
			if (!this.isConnected && !this.client.isOpen) {
				const connected = await this.ensureConnected();
				if (!connected) return 0;
			}

			const matchPattern = `${this.prefixedKey(prefix)}*`;
			let deletedCount = 0;
			const batch: string[] = [];

			for await (const key of this.client.scanIterator({
				MATCH: matchPattern,
				COUNT: 100,
			})) {
				batch.push(key);
				if (batch.length >= 100) {
					await this.client.del(batch);
					deletedCount += batch.length;
					batch.length = 0;
				}
			}

			if (batch.length > 0) {
				await this.client.del(batch);
				deletedCount += batch.length;
			}

			return deletedCount;
		} catch (error: any) {
			Logging.dev(
				`[RedisCacheEngine] deletePrefix("${prefix}") failed: ${error?.message || error}`,
			);
			return 0;
		}
	}

	async clear(): Promise<void> {
		try {
			if (!this.isConnected && !this.client.isOpen) {
				const connected = await this.ensureConnected();
				if (!connected) return;
			}

			// Clear all keys with our prefix safely via deletePrefix
			await this.deletePrefix("");
		} catch (error: any) {
			Logging.dev(
				`[RedisCacheEngine] clear() failed: ${error?.message || error}`,
			);
		}
	}

	async close(): Promise<void> {
		try {
			if (this.client.isOpen) {
				await this.client.quit();
			}
			this.isConnected = false;
		} catch (error: any) {
			Logging.dev(
				`[RedisCacheEngine] close() error: ${error?.message || error}`,
			);
		}
	}
}
