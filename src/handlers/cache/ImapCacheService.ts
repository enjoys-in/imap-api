import { CacheEngineFactory, type CacheEngineType } from "./CacheEngineFactory";
import type { ICacheEngine } from "./interfaces/ICacheEngine";

/**
 * Domain-specific Cache Service for IMAP operations.
 * Decoupled storage layer that operates on top of any pluggable ICacheEngine
 * (In-Memory, Redis, or RocksDB).
 *
 * Caches expensive operations like folder lists, parsed MIME bodies,
 * server capabilities, and storage quotas with safe TTLs and automatic
 * invalidation on state mutations.
 */
export class ImapCacheService {
  private engine: ICacheEngine;

  constructor(engine?: ICacheEngine) {
    this.engine = engine || CacheEngineFactory.create();
  }

  /**
   * Switch the underlying cache storage engine dynamically.
   */
  public setEngine(engineOrType: ICacheEngine | CacheEngineType): void {
    if (typeof engineOrType === "string") {
      this.engine = CacheEngineFactory.create(engineOrType);
    } else {
      this.engine = engineOrType;
    }
  }

  /**
   * Returns the currently active storage engine instance.
   */
  public getEngine(): ICacheEngine {
    return this.engine;
  }

  /**
   * Identifier of the active storage engine (e.g. 'memory', 'redis', 'rocksdb').
   */
  public getEngineName(): string {
    return this.engine.name;
  }

  // ── Mailboxes / Folders ──

  async getMailboxes(email: string): Promise<any[] | undefined> {
    return this.engine.get<any[]>(`mailboxes:${email.toLowerCase()}`);
  }

  async setMailboxes(
    email: string,
    mailboxes: any[],
    ttlSeconds = 30,
  ): Promise<void> {
    await this.engine.set(
      `mailboxes:${email.toLowerCase()}`,
      mailboxes,
      ttlSeconds,
    );
  }

  async invalidateMailboxes(email: string): Promise<void> {
    await this.engine.delete(`mailboxes:${email.toLowerCase()}`);
  }

  // ── Email Bodies (Parsed MIME) ──

  async getEmailBody(
    email: string,
    folder: string,
    uid: string | number,
  ): Promise<any | undefined> {
    const key = `body:${email.toLowerCase()}:${folder.toLowerCase()}:${uid}`;
    return this.engine.get(key);
  }

  async setEmailBody(
    email: string,
    folder: string,
    uid: string | number,
    bodyData: any,
    ttlSeconds = 600,
  ): Promise<void> {
    const key = `body:${email.toLowerCase()}:${folder.toLowerCase()}:${uid}`;
    await this.engine.set(key, bodyData, ttlSeconds);
  }

  async invalidateEmailBody(
    email: string,
    folder?: string,
    uid?: string | number,
  ): Promise<void> {
    if (folder && uid !== undefined) {
      const key = `body:${email.toLowerCase()}:${folder.toLowerCase()}:${uid}`;
      await this.engine.delete(key);
    } else if (folder) {
      const prefix = `body:${email.toLowerCase()}:${folder.toLowerCase()}:`;
      await this.engine.deletePrefix(prefix);
    } else {
      const prefix = `body:${email.toLowerCase()}:`;
      await this.engine.deletePrefix(prefix);
    }
  }

  // ── Quota ──

  async getQuota(email: string, folder = "INBOX"): Promise<any | undefined> {
    const key = `quota:${email.toLowerCase()}:${folder.toLowerCase()}`;
    return this.engine.get(key);
  }

  async setQuota(
    email: string,
    folder = "INBOX",
    quotaData: any,
    ttlSeconds = 60,
  ): Promise<void> {
    const key = `quota:${email.toLowerCase()}:${folder.toLowerCase()}`;
    await this.engine.set(key, quotaData, ttlSeconds);
  }

  async invalidateQuota(email: string): Promise<void> {
    await this.engine.deletePrefix(`quota:${email.toLowerCase()}:`);
  }

  // ── Server Capabilities ──

  async getCapabilities(email: string): Promise<any | undefined> {
    return this.engine.get(`caps:${email.toLowerCase()}`);
  }

  async setCapabilities(
    email: string,
    capabilities: any,
    ttlSeconds = 3600,
  ): Promise<void> {
    await this.engine.set(
      `caps:${email.toLowerCase()}`,
      capabilities,
      ttlSeconds,
    );
  }

  async invalidateCapabilities(email: string): Promise<void> {
    await this.engine.delete(`caps:${email.toLowerCase()}`);
  }

  // ── Global Invalidation for User ──

  async invalidateUser(email: string): Promise<void> {
    await Promise.all([
      this.invalidateMailboxes(email),
      this.invalidateEmailBody(email),
      this.invalidateQuota(email),
      this.invalidateCapabilities(email),
    ]);
  }

  async clearAll(): Promise<void> {
    await this.engine.clear();
  }
}

export const imapCache = new ImapCacheService();
