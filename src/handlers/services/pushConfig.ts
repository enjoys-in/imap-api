export type PushAudience = "all" | "direct" | "vip" | "high_priority";

export const PUSH_AUDIENCES: readonly PushAudience[] = [
	"all",
	"direct",
	"vip",
	"high_priority",
];

export interface VapidConfig {
	publicKey: string;
	privateKey: string;
	subject: string;
}

const DEFAULT_WATCH_MS = 60_000;
const MIN_WATCH_MS = 1_000;

const DEFAULT_ENDPOINT_HOSTS = [
	"fcm.googleapis.com",
	"android.googleapis.com",
	"updates.push.services.mozilla.com",
	"push.services.mozilla.com",
	".notify.windows.com",
	"web.push.apple.com",
	".push.apple.com",
];

export function vapidConfig(): VapidConfig | null {
	const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
	const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
	const subject = process.env.VAPID_SUBJECT?.trim();
	if (!publicKey || !privateKey || !subject) {
		return null;
	}
	return { publicKey, privateKey, subject };
}

export function pushWatchInterval(): number {
	const raw = process.env.PUSH_WATCH_INTERVAL_MS;
	if (raw === undefined || raw.trim() === "") {
		return DEFAULT_WATCH_MS;
	}
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		return 0;
	}
	return Math.max(MIN_WATCH_MS, value);
}

function allowedHosts(): string[] {
	const extra = (process.env.PUSH_ENDPOINT_HOSTS ?? "")
		.split(",")
		.map((host) => host.trim().toLowerCase())
		.filter(Boolean);
	return [...DEFAULT_ENDPOINT_HOSTS, ...extra];
}

export function isAllowedPushEndpoint(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== "https:" || url.username || url.password) {
		return false;
	}
	const host = url.hostname.toLowerCase();
	return allowedHosts().some((allowed) =>
		allowed.startsWith(".") ? host.endsWith(allowed) : host === allowed,
	);
}

export const isPushAudience = (value: unknown): value is PushAudience =>
	typeof value === "string" &&
	(PUSH_AUDIENCES as readonly string[]).includes(value);
