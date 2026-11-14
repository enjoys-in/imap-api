import { watchConfig } from "./watchConfig";

export type PresenceLevel = "active" | "idle" | "gone";

export interface PresenceSnapshot {
	level: PresenceLevel;
	lastSeen: number | null;
	missedWindows: number;
}

export interface PresenceLease {
	beat: (at?: number) => void;
	close: (at?: number) => void;
}

type PresenceListener = (snapshot: PresenceSnapshot) => void;

interface Lease {
	seenAt: number;
}

const LEVEL_RANK: Record<PresenceLevel, number> = {
	gone: 0,
	idle: 1,
	active: 2,
};

export const presenceRank = (level: PresenceLevel): number => LEVEL_RANK[level];

export class StreamPresence {
	private readonly leases = new Map<number, Set<Lease>>();
	private readonly listeners = new Map<number, Set<PresenceListener>>();

	open(connectionId: number, at = Date.now()): PresenceLease {
		const lease: Lease = { seenAt: at };
		this.apply(connectionId, at, (leases) => {
			leases.add(lease);
		});

		let closed = false;
		return {
			beat: (beatAt = Date.now()) => {
				if (closed) {
					return;
				}
				this.apply(connectionId, beatAt, () => {
					lease.seenAt = beatAt;
				});
			},
			close: (closeAt = Date.now()) => {
				if (closed) {
					return;
				}
				closed = true;
				this.apply(connectionId, closeAt, (leases) => {
					leases.delete(lease);
				});
				if (this.leases.get(connectionId)?.size === 0) {
					this.leases.delete(connectionId);
				}
			},
		};
	}

	snapshot(connectionId: number, at = Date.now()): PresenceSnapshot {
		const { pingWindowMs, maxMissedWindows } = watchConfig();

		let lastSeen: number | null = null;
		for (const lease of this.leases.get(connectionId) ?? []) {
			lastSeen = lastSeen === null ? lease.seenAt : Math.max(lastSeen, lease.seenAt);
		}

		const missedWindows =
			lastSeen === null
				? maxMissedWindows
				: Math.max(0, Math.floor((at - lastSeen) / pingWindowMs));

		let level: PresenceLevel;
		if (lastSeen === null || missedWindows >= maxMissedWindows) {
			level = "gone";
		} else if (missedWindows >= 1) {
			level = "idle";
		} else {
			level = "active";
		}

		return { level, lastSeen, missedWindows };
	}

	subscribe(connectionId: number, listener: PresenceListener): () => void {
		const set = this.listeners.get(connectionId) ?? new Set<PresenceListener>();
		set.add(listener);
		this.listeners.set(connectionId, set);
		return () => {
			set.delete(listener);
			if (set.size === 0 && this.listeners.get(connectionId) === set) {
				this.listeners.delete(connectionId);
			}
		};
	}

	private apply(
		connectionId: number,
		at: number,
		change: (leases: Set<Lease>) => void,
	) {
		const before = this.snapshot(connectionId, at).level;
		const leases = this.leases.get(connectionId) ?? new Set<Lease>();
		this.leases.set(connectionId, leases);
		change(leases);
		const after = this.snapshot(connectionId, at);
		if (before === after.level) {
			return;
		}
		for (const listener of [...(this.listeners.get(connectionId) ?? [])]) {
			listener(after);
		}
	}
}

export const streamPresence = new StreamPresence();
