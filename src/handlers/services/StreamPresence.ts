import { watchConfig } from "./watchConfig";

export type PresenceLevel = "active" | "background" | "idle" | "gone";

export interface PresenceReport {
	tabId: string;
	visible: boolean;
	folder: string | null;
}

export interface PresenceSnapshot {
	level: PresenceLevel;
	visible: boolean;
	openFolders: string[];
	focusFolder: string | null;
	lastSeen: number | null;
	missedWindows: number;
}

type PresenceListener = (snapshot: PresenceSnapshot) => void;

interface Tab {
	seenAt: number;
	visible: boolean;
	folder: string | null;
	streams: number;
}

const LEVEL_RANK: Record<PresenceLevel, number> = {
	gone: 0,
	idle: 1,
	background: 2,
	active: 3,
};

export const presenceRank = (level: PresenceLevel): number => LEVEL_RANK[level];

const signature = (snapshot: PresenceSnapshot): string =>
	[
		snapshot.level,
		snapshot.visible,
		snapshot.focusFolder ?? "",
		snapshot.openFolders.join("\n"),
	].join("|");

export class StreamPresence {
	private readonly tabs = new Map<number, Map<string, Tab>>();
	private readonly listeners = new Map<number, Set<PresenceListener>>();

	open(connectionId: number, tabId: string, at = Date.now()): () => void {
		this.apply(connectionId, at, (tabs) => {
			const tab = tabs.get(tabId);
			if (tab) {
				tab.seenAt = at;
				tab.streams++;
			} else {
				tabs.set(tabId, { seenAt: at, visible: true, folder: null, streams: 1 });
			}
		});

		let closed = false;
		return () => {
			if (closed) {
				return;
			}
			closed = true;
			this.apply(connectionId, Date.now(), (tabs) => {
				const tab = tabs.get(tabId);
				if (!tab) {
					return;
				}
				tab.streams--;
				if (tab.streams <= 0) {
					tabs.delete(tabId);
				}
			});
			if (this.tabs.get(connectionId)?.size === 0) {
				this.tabs.delete(connectionId);
			}
		};
	}

	report(
		connectionId: number,
		report: PresenceReport,
		at = Date.now(),
	): PresenceSnapshot {
		this.apply(connectionId, at, (tabs) => {
			this.prune(tabs, at);
			const tab = tabs.get(report.tabId);
			if (tab) {
				tab.seenAt = at;
				tab.visible = report.visible;
				tab.folder = report.folder;
			} else {
				tabs.set(report.tabId, {
					seenAt: at,
					visible: report.visible,
					folder: report.folder,
					streams: 0,
				});
			}
		});
		return this.snapshot(connectionId, at);
	}

	snapshot(connectionId: number, at = Date.now()): PresenceSnapshot {
		const { pingWindowMs, maxMissedWindows } = watchConfig();
		const tabs = this.tabs.get(connectionId);

		let lastSeen: number | null = null;
		let visible = false;
		let focus: { seenAt: number; folder: string } | null = null;
		const open = new Set<string>();

		for (const tab of tabs?.values() ?? []) {
			lastSeen = lastSeen === null ? tab.seenAt : Math.max(lastSeen, tab.seenAt);
			if (!tab.visible || at - tab.seenAt >= pingWindowMs) {
				continue;
			}
			visible = true;
			if (tab.folder) {
				open.add(tab.folder);
				if (!focus || tab.seenAt >= focus.seenAt) {
					focus = { seenAt: tab.seenAt, folder: tab.folder };
				}
			}
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
			level = visible ? "active" : "background";
		}

		return {
			level,
			visible,
			openFolders: [...open],
			focusFolder: focus?.folder ?? null,
			lastSeen,
			missedWindows,
		};
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

	private prune(tabs: Map<string, Tab>, at: number) {
		const { pingWindowMs, maxMissedWindows } = watchConfig();
		const horizon = pingWindowMs * maxMissedWindows * 2;
		for (const [id, tab] of tabs) {
			if (tab.streams === 0 && at - tab.seenAt > horizon) {
				tabs.delete(id);
			}
		}
	}

	private apply(
		connectionId: number,
		at: number,
		change: (tabs: Map<string, Tab>) => void,
	) {
		const before = signature(this.snapshot(connectionId, at));
		const tabs = this.tabs.get(connectionId) ?? new Map<string, Tab>();
		this.tabs.set(connectionId, tabs);
		change(tabs);
		const after = this.snapshot(connectionId, at);
		if (before === signature(after)) {
			return;
		}
		for (const listener of [...(this.listeners.get(connectionId) ?? [])]) {
			listener(after);
		}
	}
}

export const streamPresence = new StreamPresence();
