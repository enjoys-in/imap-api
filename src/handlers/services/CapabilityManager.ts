import type { ImapFlow } from "imapflow";

/**
 * Well-known IMAP capabilities that we actively check for.
 * @see https://www.iana.org/assignments/imap-capabilities/imap-capabilities.xhtml
 */
export enum ImapCapability {
	// RFC 2177 – IDLE push notifications
	IDLE = "IDLE",
	// RFC 5256 – server-side SORT
	SORT = "SORT",
	// RFC 5256 – server-side THREAD (ORDEREDSUBJECT / REFERENCES)
	THREAD_ORDEREDSUBJECT = "THREAD=ORDEREDSUBJECT",
	THREAD_REFERENCES = "THREAD=REFERENCES",
	// RFC 2087 – mailbox QUOTA
	QUOTA = "QUOTA",
	// RFC 4314 – per-mailbox ACL
	ACL = "ACL",
	// RFC 3501 §6.3.11 – NAMESPACE
	NAMESPACE = "NAMESPACE",
	// RFC 4551 – CONDSTORE (mod-sequences)
	CONDSTORE = "CONDSTORE",
	// RFC 7162 – quick resync
	QRESYNC = "QRESYNC",
	// RFC 5161 – ENABLE (allows enabling CONDSTORE/QRESYNC etc.)
	ENABLE = "ENABLE",
	// RFC 3516 – server-side binary content
	BINARY = "BINARY",
	// RFC 4978 – compress
	COMPRESS_DEFLATE = "COMPRESS=DEFLATE", 
	// RFC 2971 – server ID
	ID = "ID",
	// RFC 5258 – LIST-EXTENDED
	LIST_EXTENDED = "LIST-EXTENDED",
	// RFC 5819 – LIST-STATUS
	LIST_STATUS = "LIST-STATUS",
	// RFC 6851 – MOVE command
	MOVE = "MOVE",
	// RFC 3502 – MULTIAPPEND
	MULTIAPPEND = "MULTIAPPEND",
	// RFC 4731 – ESEARCH
	ESEARCH = "ESEARCH",
	// RFC 5182 – SEARCHRES
	SEARCHRES = "SEARCHRES",
	// RFC 2342 – STARTTLS
	STARTTLS = "STARTTLS",
	// RFC 4959 – SASL-IR (initial response)
	SASL_IR = "SASL-IR",
	// RFC 5530 – LOGIN-REFERRALS
	LOGIN_REFERRALS = "LOGIN-REFERRALS",
	// RFC 7889 – APPENDLIMIT
	APPENDLIMIT = "APPENDLIMIT",
	// RFC 3348 – CHILDREN (mailbox child info)
	CHILDREN = "CHILDREN",
	// RFC 6154 – SPECIAL-USE
	SPECIAL_USE = "SPECIAL-USE",
	// RFC 4315 – UIDPLUS
	UIDPLUS = "UIDPLUS",
	// RFC 3691 – UNSELECT
	UNSELECT = "UNSELECT",
	// RFC 5162 – WITHIN (search improvements)
	WITHIN = "WITHIN",
	// RFC 5032 – LITERAL+
	LITERAL_PLUS = "LITERAL+",
	// RFC 7888 – LITERAL-
	LITERAL_MINUS = "LITERAL-",
	// RFC 2595 – LOGINDISABLED
	LOGINDISABLED = "LOGINDISABLED",
	// AUTH schemes (common)
	AUTH_PLAIN = "AUTH=PLAIN",
	AUTH_LOGIN = "AUTH=LOGIN",
	AUTH_XOAUTH2 = "AUTH=XOAUTH2",
	AUTH_OAUTHBEARER = "AUTH=OAUTHBEARER",
}

/**
 * Snapshot of what the IMAP server supports — captured both before and after
 * authentication (the set often changes after LOGIN / AUTHENTICATE).
 */
export interface CapabilitySnapshot {
	/** Raw capability strings from the server */
	raw: string[];
	/** Timestamp when this snapshot was captured */
	capturedAt: Date;
	/** Whether taken before or after authentication */
	phase: "pre-login" | "post-login";
}

/**
 * Resolved feature map — the result of merging pre- and post-login
 * capability sets into human-friendly booleans the rest of the app can query.
 */
export interface ResolvedFeatures {
	idle: boolean;
	sortServer: boolean;
	threadOrderedSubject: boolean;
	threadReferences: boolean;
	quota: boolean;
	acl: boolean;
	namespace: boolean;
	condstore: boolean;
	qresync: boolean;
	enable: boolean;
	binary: boolean;
	compressDeflate: boolean;
	id: boolean;
	listExtended: boolean;
	listStatus: boolean;
	move: boolean;
	multiAppend: boolean;
	esearch: boolean;
	searchRes: boolean;
	startTls: boolean;
	saslIr: boolean;
	appendLimit: boolean | number;
	children: boolean;
	specialUse: boolean;
	uidPlus: boolean;
	unselect: boolean;
	within: boolean;
	literalPlus: boolean;
	literalMinus: boolean;
	loginDisabled: boolean;
	authPlain: boolean;
	authLogin: boolean;
	authXOAuth2: boolean;
	authOAuthBearer: boolean;
}

/**
 * CapabilityManager
 *
 * Reads IMAP server capabilities at two phases:
 *   1. **Pre-login** — right after TCP + TLS handshake (from server greeting)
 *   2. **Post-login** — after successful AUTHENTICATE / LOGIN
 *
 * The manager caches both snapshots and produces a merged `ResolvedFeatures`
 * map that the rest of the application can query before attempting an operation.
 *
 * Usage:
 * ```ts
 *   const mgr = new CapabilityManager(imapFlowClient);
 *   await mgr.probePreLogin();   // call right after connect()
 *   await mgr.probePostLogin();  // call after authenticate()
 *   if (mgr.supports(ImapCapability.IDLE)) { ... }
 * ```
 */
export class CapabilityManager {
	private preLogin: CapabilitySnapshot | null = null;
	private postLogin: CapabilitySnapshot | null = null;
	private features: ResolvedFeatures | null = null;

	constructor(private readonly client: ImapFlow) {}

	// ──────────────────────────────────────────────
	// Probing
	// ──────────────────────────────────────────────

	/**
	 * Capture the capability set advertised by the server **before** login.
	 * Call this right after `client.connect()` but before authentication.
	 *
	 * NOTE: ImapFlow automatically connects + authenticates in `connect()`,
	 * so in practice we capture after connect and treat the first read as
	 * "pre-login" (ImapFlow stores the greeting capabilities internally).
	 */
	probePreLogin(): CapabilitySnapshot {
		const raw = this.readRawCapabilities();
		this.preLogin = {
			raw,
			capturedAt: new Date(),
			phase: "pre-login",
		};
		this.features = null; // invalidate cache
		return this.preLogin;
	}

	/**
	 * Capture the capability set advertised by the server **after** login.
	 * Must be called after a successful `client.connect()` which also
	 * authenticates the user.
	 */
	probePostLogin(): CapabilitySnapshot {
		const raw = this.readRawCapabilities();
		this.postLogin = {
			raw,
			capturedAt: new Date(),
			phase: "post-login",
		};
		this.features = null; // invalidate cache
		return this.postLogin;
	}

	/**
	 * Force a re-read of capabilities from the server. Useful after STARTTLS
	 * or when the server signals `* OK [CAPABILITY …]` in an untagged response.
	 */
	async refresh(): Promise<void> {
		if (this.client.authenticated) {
			this.probePostLogin();
		} else {
			this.probePreLogin();
		}
	}

	// ──────────────────────────────────────────────
	// Queries
	// ──────────────────────────────────────────────

	/**
	 * Check whether the server advertised a specific capability
	 * (looks in both pre- and post-login sets; post-login wins).
	 */
	supports(cap: ImapCapability | string): boolean {
		const merged = this.getMergedRawCaps();
		return merged.has(cap.toUpperCase());
	}

	/**
	 * Get the numeric value of a capability that carries one (e.g. APPENDLIMIT=1048576).
	 * Returns `undefined` when the capability is absent or is purely boolean.
	 */
	getCapabilityValue(cap: ImapCapability | string): number | undefined {
		const capMap = this.client.capabilities;
		const val = capMap.get(cap.toUpperCase());
		if (typeof val === "number") return val;
		return undefined;
	}

	/**
	 * Return the fully resolved feature map (cached until the next probe).
	 */
	getFeatures(): ResolvedFeatures {
		if (this.features) return this.features;
		this.features = this.resolveFeatures();
		return this.features;
	}

	/**
	 * Get the pre-login capability snapshot (null if not yet probed).
	 */
	getPreLoginSnapshot(): CapabilitySnapshot | null {
		return this.preLogin;
	}

	/**
	 * Get the post-login capability snapshot (null if not yet probed).
	 */
	getPostLoginSnapshot(): CapabilitySnapshot | null {
		return this.postLogin;
	}

	/**
	 * Throw if a specific capability is not supported.
	 * Useful as a guard before executing commands that depend on extensions.
	 */
	require(cap: ImapCapability | string, operationName?: string): void {
		if (!this.supports(cap)) {
			throw new CapabilityNotSupportedError(cap, operationName);
		}
	}

	/**
	 * Check multiple capabilities at once. Returns an object mapping each
	 * capability to its support status.
	 */
	supportsBatch(caps: (ImapCapability | string)[]): Record<string, boolean> {
		const result: Record<string, boolean> = {};
		for (const cap of caps) {
			result[cap] = this.supports(cap);
		}
		return result;
	}

	/**
	 * Return a compact summary suitable for API responses / logs.
	 */
	toJSON() {
		return {
			preLogin: this.preLogin,
			postLogin: this.postLogin,
			features: this.getFeatures(),
			rawMerged: Array.from(this.getMergedRawCaps()),
		};
	}

	// ──────────────────────────────────────────────
	// Internals
	// ──────────────────────────────────────────────

	/**
	 * Read raw capability strings from the ImapFlow client.
	 * ImapFlow stores them in `client.capabilities` as a Map<string, boolean|number>.
	 */
	private readRawCapabilities(): string[] {
		const caps: string[] = [];
		for (const [key] of this.client.capabilities) {
			caps.push(key.toUpperCase());
		}
		// Also include enabled set
		for (const key of this.client.enabled) {
			const upper = key.toUpperCase();
			if (!caps.includes(upper)) caps.push(upper);
		}
		return caps.sort();
	}

	/**
	 * Merge pre- and post-login raw caps into a single Set<string>.
	 * Post-login capabilities supersede pre-login.
	 */
	private getMergedRawCaps(): Set<string> {
		const merged = new Set<string>();
		if (this.preLogin) {
			for (const c of this.preLogin.raw) merged.add(c);
		}
		if (this.postLogin) {
			for (const c of this.postLogin.raw) merged.add(c);
		}
		// Always also read live from the client in case the server updated them
		for (const [key] of this.client.capabilities) {
			merged.add(key.toUpperCase());
		}
		return merged;
	}

	/**
	 * Resolve the merged capability strings into a typed features object.
	 */
	private resolveFeatures(): ResolvedFeatures {
		const has = (cap: string) => this.supports(cap);

		const appendLimitVal = this.getCapabilityValue(ImapCapability.APPENDLIMIT);

		return {
			idle: has(ImapCapability.IDLE),
			sortServer: has(ImapCapability.SORT),
			threadOrderedSubject: has(ImapCapability.THREAD_ORDEREDSUBJECT),
			threadReferences: has(ImapCapability.THREAD_REFERENCES),
			quota: has(ImapCapability.QUOTA),
			acl: has(ImapCapability.ACL),
			namespace: has(ImapCapability.NAMESPACE),
			condstore: has(ImapCapability.CONDSTORE),
			qresync: has(ImapCapability.QRESYNC),
			enable: has(ImapCapability.ENABLE),
			binary: has(ImapCapability.BINARY),
			compressDeflate: has(ImapCapability.COMPRESS_DEFLATE),
			id: has(ImapCapability.ID),
			listExtended: has(ImapCapability.LIST_EXTENDED),
			listStatus: has(ImapCapability.LIST_STATUS),
			move: has(ImapCapability.MOVE),
			multiAppend: has(ImapCapability.MULTIAPPEND),
			esearch: has(ImapCapability.ESEARCH),
			searchRes: has(ImapCapability.SEARCHRES),
			startTls: has(ImapCapability.STARTTLS),
			saslIr: has(ImapCapability.SASL_IR),
			appendLimit: appendLimitVal !== undefined ? appendLimitVal : has(ImapCapability.APPENDLIMIT),
			children: has(ImapCapability.CHILDREN),
			specialUse: has(ImapCapability.SPECIAL_USE),
			uidPlus: has(ImapCapability.UIDPLUS),
			unselect: has(ImapCapability.UNSELECT),
			within: has(ImapCapability.WITHIN),
			literalPlus: has(ImapCapability.LITERAL_PLUS),
			literalMinus: has(ImapCapability.LITERAL_MINUS),
			loginDisabled: has(ImapCapability.LOGINDISABLED),
			authPlain: has(ImapCapability.AUTH_PLAIN),
			authLogin: has(ImapCapability.AUTH_LOGIN),
			authXOAuth2: has(ImapCapability.AUTH_XOAUTH2),
			authOAuthBearer: has(ImapCapability.AUTH_OAUTHBEARER),
		};
	}
}

// ──────────────────────────────────────────────
// Custom Error
// ──────────────────────────────────────────────

/**
 * Thrown when a command requires a capability the server does not support.
 */
export class CapabilityNotSupportedError extends Error {
	public readonly capability: string;
	public readonly operation: string | undefined;

	constructor(capability: string, operation?: string) {
		const msg = operation
			? `IMAP server does not support "${capability}" — required by "${operation}"`
			: `IMAP server does not support "${capability}"`;
		super(msg);
		this.name = "CapabilityNotSupportedError";
		this.capability = capability;
		this.operation = operation;
	}
}
