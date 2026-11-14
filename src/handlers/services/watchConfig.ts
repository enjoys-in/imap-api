export interface WatchConfig {
	sweepMs: number;
	hotMs: number;
	backgroundMs: number;
	pingWindowMs: number;
	maxMissedWindows: number;
}

const DEFAULT_SWEEP_MS = 10_000;
const DEFAULT_HOT_MS = 2_000;
const DEFAULT_BACKGROUND_MS = 30_000;
const DEFAULT_PING_WINDOW_MS = 60_000;
const DEFAULT_MAX_MISSED = 3;
const MIN_INTERVAL_MS = 1_000;

function readNumber(name: string): number | null {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") {
		return null;
	}
	const value = Number(raw);
	return Number.isFinite(value) ? value : 0;
}

function readInterval(name: string, fallback: number): number {
	const value = readNumber(name);
	if (value === null) {
		return fallback;
	}
	return value <= 0 ? 0 : Math.max(MIN_INTERVAL_MS, value);
}

export function watchConfig(): WatchConfig {
	const sweepMs = readInterval("FOLDER_WATCH_INTERVAL_MS", DEFAULT_SWEEP_MS);
	const hotRaw = readInterval("FOLDER_WATCH_HOT_INTERVAL_MS", DEFAULT_HOT_MS);
	const backgroundRaw = readInterval(
		"FOLDER_WATCH_BACKGROUND_INTERVAL_MS",
		DEFAULT_BACKGROUND_MS,
	);
	const window = readInterval(
		"FOLDER_WATCH_PING_WINDOW_MS",
		DEFAULT_PING_WINDOW_MS,
	);
	const missed = readNumber("FOLDER_WATCH_MAX_MISSED");

	return {
		sweepMs,
		hotMs: hotRaw === 0 ? 0 : Math.min(hotRaw, sweepMs || hotRaw),
		backgroundMs: Math.max(backgroundRaw, sweepMs),
		pingWindowMs: window === 0 ? DEFAULT_PING_WINDOW_MS : window,
		maxMissedWindows:
			missed === null ? DEFAULT_MAX_MISSED : Math.max(1, Math.floor(missed)),
	};
}
