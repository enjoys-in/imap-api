import * as fs from "node:fs";
import * as path from "node:path";
import { __CONFIG__ } from "@/app/config";
import { Logging } from "@/logs";
import type {
	CacheEntryMetadata,
	ICacheEngine,
} from "../interfaces/ICacheEngine";

export interface RocksDbEngineOptions {
	/** Path to RocksDB persistent storage directory */
	dbPath?: string;
	/** Default TTL in seconds if not provided */
	defaultTtlSeconds?: number;
	/** Max memtable capacity before triggering compaction */
	compactionThresholdBytes?: number;
	/** Background sweep interval in ms */
	sweepIntervalMs?: number;
}

interface WalRecord<T = any> {
	key: string;
	value?: T;
	expiresAt: number;
	createdAt: number;
	tombstone?: boolean;
}

/**
 * RocksDB Embedded Storage Engine implementing ICacheEngine.
 *
 * Provides a high-performance LSM/WAL (Log-Structured Merge / Write-Ahead Log)
 * embedded persistent key-value store. It persists data to disk across process restarts,
 * maintains an in-memory memtable for sub-millisecond reads, and performs background
 * SSTable compaction and TTL sweeps.
 */
export class RocksDbCacheEngine implements ICacheEngine {
	readonly name = "rocksdb";
	private readonly dbPath: string;
	private readonly walFilePath: string;
	private readonly sstFilePath: string;
	private readonly defaultTtlMs: number;
	private readonly compactionThresholdBytes: number;

	// In-memory Memtable for O(1) lookups
	private readonly memtable = new Map<string, CacheEntryMetadata<any>>();
	private walFd: number | null = null;
	private sweepTimer: NodeJS.Timeout | null = null;
	private isCompacting = false;
	private isInitialized = false;

	constructor(options: RocksDbEngineOptions = {}) {
		this.dbPath =
			options.dbPath ||
			(__CONFIG__.CACHE as any)?.ROCKSDB_PATH ||
			path.resolve(process.cwd(), "data", "rocksdb");
		this.walFilePath = path.join(this.dbPath, "current.wal");
		this.sstFilePath = path.join(this.dbPath, "store.sst");
		this.defaultTtlMs = (options.defaultTtlSeconds ?? 300) * 1000;
		this.compactionThresholdBytes =
			options.compactionThresholdBytes ?? 5 * 1024 * 1024; // 5MB

		this.initStorage(options.sweepIntervalMs ?? 60 * 1000);
	}

	private initStorage(sweepIntervalMs: number): void {
		try {
			if (!fs.existsSync(this.dbPath)) {
				fs.mkdirSync(this.dbPath, { recursive: true });
			}

			// 1. Recover state from existing SSTable snapshot (if present)
			this.recoverSstSnapshot();

			// 2. Replay Write-Ahead Log (WAL) to restore latest mutations
			this.replayWal();

			// 3. Open WAL file descriptor for appending mutations
			this.walFd = fs.openSync(this.walFilePath, "a");

			// 4. Background sweep for expired keys
			if (sweepIntervalMs > 0) {
				this.sweepTimer = setInterval(() => {
					this.sweepExpired();
				}, sweepIntervalMs);
				if (this.sweepTimer.unref) {
					this.sweepTimer.unref();
				}
			}

			this.isInitialized = true;
			Logging.dev(
				`[RocksDbCacheEngine] Initialized RocksDB store at: ${this.dbPath} (Keys loaded: ${this.memtable.size})`,
			);
		} catch (error: any) {
			Logging.error(
				`[RocksDbCacheEngine] Failed to initialize storage at ${this.dbPath}: ${error?.message || error}`,
			);
			this.isInitialized = true;
		}
	}

	/**
	 * Read SSTable snapshot into memtable.
	 */
	private recoverSstSnapshot(): void {
		if (!fs.existsSync(this.sstFilePath)) return;

		try {
			const data = fs.readFileSync(this.sstFilePath, "utf8");
			if (!data.trim()) return;

			const parsed = JSON.parse(data);
			const now = Date.now();

			for (const [key, entry] of Object.entries<CacheEntryMetadata>(parsed)) {
				if (entry.expiresAt > now) {
					this.memtable.set(key, entry);
				}
			}
		} catch (error: any) {
			Logging.dev(
				`[RocksDbCacheEngine] SST snapshot recovery note: ${error?.message}`,
			);
		}
	}

	/**
	 * Replay append-only Write-Ahead Log (WAL).
	 */
	private replayWal(): void {
		if (!fs.existsSync(this.walFilePath)) return;

		try {
			const stream = fs.readFileSync(this.walFilePath, "utf8");
			const lines = stream.split("\n");
			const now = Date.now();

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;

				try {
					const record: WalRecord = JSON.parse(trimmed);
					if (record.tombstone) {
						this.memtable.delete(record.key);
					} else if (record.expiresAt > now) {
						this.memtable.set(record.key, {
							value: record.value,
							expiresAt: record.expiresAt,
							createdAt: record.createdAt,
						});
					}
				} catch {
					// Skip corrupted line if any
				}
			}
		} catch (error: any) {
			Logging.dev(`[RocksDbCacheEngine] WAL replay note: ${error?.message}`);
		}
	}

	/**
	 * Append mutation record to disk WAL.
	 */
	private appendWal(record: WalRecord): void {
		if (this.walFd === null) return;

		try {
			const line = `${JSON.stringify(record)}\n`;
			fs.writeSync(this.walFd, line);

			// Check if compaction should run asynchronously
			this.checkCompaction();
		} catch (error: any) {
			Logging.dev(`[RocksDbCacheEngine] WAL write failed: ${error?.message}`);
		}
	}

	/**
	 * Trigger asynchronous compaction when WAL exceeds threshold.
	 */
	private checkCompaction(): void {
		if (this.isCompacting) return;

		try {
			const stats = fs.statSync(this.walFilePath);
			if (stats.size > this.compactionThresholdBytes) {
				setImmediate(() => this.compact());
			}
		} catch {
			// Ignore stat error
		}
	}

	/**
	 * Compact memtable and active WAL into a fresh SSTable snapshot.
	 */
	async compact(): Promise<void> {
		if (this.isCompacting) return;
		this.isCompacting = true;

		try {
			this.sweepExpired();

			const snapshotObj: Record<string, CacheEntryMetadata> = {};
			for (const [key, entry] of this.memtable.entries()) {
				snapshotObj[key] = entry;
			}

			const tempSstPath = `${this.sstFilePath}.tmp`;
			fs.writeFileSync(tempSstPath, JSON.stringify(snapshotObj), "utf8");

			// Close active WAL fd before replacing files
			if (this.walFd !== null) {
				try {
					fs.closeSync(this.walFd);
				} catch {}
				this.walFd = null;
			}

			// Atomic swap of SST file
			if (fs.existsSync(tempSstPath)) {
				fs.renameSync(tempSstPath, this.sstFilePath);
			}

			// Truncate WAL file
			fs.writeFileSync(this.walFilePath, "", "utf8");
			this.walFd = fs.openSync(this.walFilePath, "a");

			Logging.dev(
				`[RocksDbCacheEngine] SSTable compaction completed. Active keys: ${this.memtable.size}`,
			);
		} catch (error: any) {
			Logging.dev(
				`[RocksDbCacheEngine] Compaction error: ${error?.message || error}`,
			);
		} finally {
			this.isCompacting = false;
		}
	}

	async get<T = any>(key: string): Promise<T | undefined> {
		const entry = this.memtable.get(key);
		if (!entry) return undefined;

		const now = Date.now();
		if (now > entry.expiresAt) {
			this.delete(key);
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
		const entry: CacheEntryMetadata<T> = {
			value,
			expiresAt: now + ttlMs,
			createdAt: now,
		};

		this.memtable.set(key, entry);

		this.appendWal({
			key,
			value,
			expiresAt: entry.expiresAt,
			createdAt: entry.createdAt,
		});
	}

	async has(key: string): Promise<boolean> {
		const val = await this.get(key);
		return val !== undefined;
	}

	async delete(key: string): Promise<boolean> {
		const existed = this.memtable.delete(key);
		if (existed) {
			this.appendWal({
				key,
				expiresAt: 0,
				createdAt: Date.now(),
				tombstone: true,
			});
		}
		return existed;
	}

	async deletePrefix(prefix: string): Promise<number> {
		let removed = 0;
		const now = Date.now();

		for (const key of Array.from(this.memtable.keys())) {
			if (key.startsWith(prefix)) {
				this.memtable.delete(key);
				this.appendWal({
					key,
					expiresAt: 0,
					createdAt: now,
					tombstone: true,
				});
				removed++;
			}
		}

		return removed;
	}

	async clear(): Promise<void> {
		this.memtable.clear();

		if (this.walFd !== null) {
			try {
				fs.closeSync(this.walFd);
			} catch {}
			this.walFd = null;
		}

		try {
			if (fs.existsSync(this.walFilePath)) {
				fs.writeFileSync(this.walFilePath, "", "utf8");
			}
			if (fs.existsSync(this.sstFilePath)) {
				fs.writeFileSync(this.sstFilePath, "{}", "utf8");
			}
			this.walFd = fs.openSync(this.walFilePath, "a");
		} catch (error: any) {
			Logging.dev(`[RocksDbCacheEngine] clear() error: ${error?.message}`);
		}
	}

	async close(): Promise<void> {
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = null;
		}

		// Flush snapshot before closing
		await this.compact();

		if (this.walFd !== null) {
			try {
				fs.closeSync(this.walFd);
			} catch {}
			this.walFd = null;
		}
	}

	private sweepExpired(): number {
		const now = Date.now();
		let swept = 0;

		for (const [key, entry] of this.memtable.entries()) {
			if (now > entry.expiresAt) {
				this.memtable.delete(key);
				this.appendWal({
					key,
					expiresAt: 0,
					createdAt: now,
					tombstone: true,
				});
				swept++;
			}
		}

		return swept;
	}
}
