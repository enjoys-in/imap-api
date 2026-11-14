import { __CONFIG__ } from "@/app/config";
import { Logging } from "@/logs";
import { MemoryCacheEngine } from "./engines/MemoryCacheEngine";
import { RedisCacheEngine } from "./engines/RedisCacheEngine";
import { RocksDbCacheEngine } from "./engines/RocksDbCacheEngine";
import type { ICacheEngine } from "./interfaces/ICacheEngine";

export type CacheEngineType = "memory" | "redis" | "rocksdb";

export class CacheEngineFactory {
  private static instanceCache = new Map<string, ICacheEngine>();

  /**
   * Creates or retrieves a cached instance of the requested storage engine.
   * If no engine is specified, defaults to __CONFIG__.CACHE.CACHE_ENGINE or 'memory'.
   */
  public static create(engineType?: CacheEngineType): ICacheEngine {
    const resolvedType = (
      engineType ||
      (__CONFIG__.CACHE as any)?.CACHE_ENGINE ||
      process.env.CACHE_ENGINE ||
      "memory"
    ).toLowerCase() as CacheEngineType;

    if (this.instanceCache.has(resolvedType)) {
      return this.instanceCache.get(resolvedType)!;
    }

    let engine: ICacheEngine;

    switch (resolvedType) {
      case "redis":
        Logging.dev("[CacheEngineFactory] Initializing Redis Cache Engine");
        engine = new RedisCacheEngine();
        break;

      case "rocksdb":
        Logging.dev("[CacheEngineFactory] Initializing RocksDB Cache Engine");
        engine = new RocksDbCacheEngine();
        break;

      case "memory":
      default:
        Logging.dev("[CacheEngineFactory] Initializing Memory Cache Engine");
        engine = new MemoryCacheEngine();
        break;
    }

    this.instanceCache.set(resolvedType, engine);
    return engine;
  }

  /**
   * Explicitly tear down all initialized engines (e.g. on server shutdown).
   */
  public static async closeAll(): Promise<void> {
    for (const [name, engine] of this.instanceCache.entries()) {
      try {
        if (engine.close) {
          await engine.close();
        }
      } catch (err: any) {
        Logging.dev(
          `[CacheEngineFactory] Error closing engine ${name}: ${err?.message}`,
        );
      }
    }
    this.instanceCache.clear();
  }
}
