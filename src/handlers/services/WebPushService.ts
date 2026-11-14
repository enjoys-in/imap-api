import { Logging } from "@/logs";
import { WebPushError, sendNotification } from "web-push";
import type { PushSubscriptionEntity } from "@/factory/entities";
import { formatImapError } from "../helpers/error.helper";
import { pushSubscriptionService } from "./PushSubscriptionService";
import { vapidConfig } from "./pushConfig";

export interface PushPayload {
	title: string;
	body: string;
	tag: string;
	data: { url: string; folder?: string; uid?: number };
}

export type PushOutcome = "sent" | "gone" | "failed";

export interface PushTarget {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

export interface PushVapid {
	subject: string;
	publicKey: string;
	privateKey: string;
}

export type PushTransport = (
	target: PushTarget,
	body: string,
	options: { TTL: number; urgency: "normal"; vapidDetails: PushVapid },
) => Promise<unknown>;

const TTL_SECONDS = 60 * 60;
const GONE_STATUS = new Set([404, 410]);
const RETRIES = 1;
const RETRY_DELAY_MS = 400;

const isTransient = (error: unknown): boolean =>
	!(error instanceof WebPushError) ||
	error.statusCode === 429 ||
	error.statusCode >= 500;

export class WebPushService {
	private transport: PushTransport = (target, body, options) =>
		sendNotification(target, body, options);

	isConfigured(): boolean {
		return vapidConfig() !== null;
	}

	publicKey(): string | null {
		return vapidConfig()?.publicKey ?? null;
	}

	useTransport(transport: PushTransport | null): void {
		this.transport =
			transport ??
			((target, body, options) => sendNotification(target, body, options));
	}

	async send(
		subscription: Pick<PushSubscriptionEntity, "id" | "endpoint" | "p256dh" | "auth">,
		payload: PushPayload,
	): Promise<PushOutcome> {
		const vapid = vapidConfig();
		if (!vapid) {
			return "failed";
		}
		const target = {
			endpoint: subscription.endpoint,
			keys: { p256dh: subscription.p256dh, auth: subscription.auth },
		};
		const body = JSON.stringify(payload);
		const options = {
			TTL: TTL_SECONDS,
			urgency: "normal" as const,
			vapidDetails: vapid,
		};

		for (let attempt = 0; attempt <= RETRIES; attempt++) {
			try {
				await this.transport(target, body, options);
				return "sent";
			} catch (error) {
				if (error instanceof WebPushError && GONE_STATUS.has(error.statusCode)) {
					await pushSubscriptionService.removeId(subscription.id);
					return "gone";
				}
				if (attempt < RETRIES && isTransient(error)) {
					await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
					continue;
				}
				Logging.dev(`[WebPush] delivery failed: ${formatImapError(error)}`);
				return "failed";
			}
		}
		return "failed";
	}
}

export const webPushService = new WebPushService();
