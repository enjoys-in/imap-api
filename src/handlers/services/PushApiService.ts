import type { Request, Response } from "express";
import { requireIdentity } from "../helpers/mailbox.helper";
import { sendError, sendSuccess } from "../helpers/response.helper";
import { pushMailWatcher } from "./PushMailWatcher";
import { pushSubscriptionService } from "./PushSubscriptionService";
import { webPushService } from "./WebPushService";
import { isAllowedPushEndpoint, isPushAudience } from "./pushConfig";

const MAX_ENDPOINT = 1024;
const MAX_KEY = 255;
const MAX_AGENT = 255;
const KEY_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/;

const text = (value: unknown, max: number): string | null =>
	typeof value === "string" && value.length > 0 && value.length <= max
		? value
		: null;

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" ? (value as Record<string, unknown>) : {};

function requireConfigured() {
	if (!webPushService.isConfigured()) {
		throw new Error("Web push is not configured on the server");
	}
}

function readEndpoint(value: unknown): string {
	const endpoint = text(value, MAX_ENDPOINT);
	if (!endpoint || !isAllowedPushEndpoint(endpoint)) {
		throw new Error("A valid push endpoint is required");
	}
	return endpoint;
}

export class PushApiService {
	publicKey(_req: Request, res: Response) {
		return sendSuccess(res, {
			configured: webPushService.isConfigured(),
			publicKey: webPushService.publicKey(),
		});
	}

	async subscribe(req: Request, res: Response) {
		try {
			const { connectionId } = requireIdentity(req);
			requireConfigured();
			const body = record(req.body);
			const keys = record(body.keys);
			const endpoint = readEndpoint(body.endpoint);
			const p256dh = text(keys.p256dh, MAX_KEY);
			const auth = text(keys.auth, MAX_KEY);
			if (
				!p256dh ||
				!auth ||
				!KEY_PATTERN.test(p256dh) ||
				!KEY_PATTERN.test(auth)
			) {
				throw new Error("Valid subscription keys are required");
			}
			const audience = body.audience ?? "all";
			if (!isPushAudience(audience)) {
				throw new Error("Unknown notification audience");
			}

			const saved = await pushSubscriptionService.save(connectionId, {
				endpoint,
				p256dh,
				auth,
				audience,
				includePreview: body.includePreview !== false,
				userAgent: text(req.headers["user-agent"], MAX_AGENT),
			});
			pushMailWatcher.start();
			return sendSuccess(res, { subscribed: true, id: saved.id });
		} catch (error) {
			return sendError(res, error);
		}
	}

	async unsubscribe(req: Request, res: Response) {
		try {
			const { connectionId } = requireIdentity(req);
			const endpoint = readEndpoint(record(req.body).endpoint);
			const removed = await pushSubscriptionService.removeEndpoint(
				endpoint,
				connectionId,
			);
			return sendSuccess(res, { removed });
		} catch (error) {
			return sendError(res, error);
		}
	}

	async test(req: Request, res: Response) {
		try {
			const { connectionId } = requireIdentity(req);
			requireConfigured();
			const only = record(req.body).endpoint;
			const subscriptions = (
				await pushSubscriptionService.forConnection(connectionId)
			).filter(
				(subscription) => only === undefined || subscription.endpoint === only,
			);
			if (subscriptions.length === 0) {
				throw new Error("No push subscription is registered for this device");
			}

			const outcomes = await Promise.all(
				subscriptions.map((subscription) =>
					webPushService.send(subscription, {
						title: "AirSend",
						body: "Push notifications are working.",
						tag: "airsend-test",
						data: { url: "/" },
					}),
				),
			);
			return sendSuccess(res, {
				sent: outcomes.filter((outcome) => outcome === "sent").length,
				gone: outcomes.filter((outcome) => outcome === "gone").length,
				failed: outcomes.filter((outcome) => outcome === "failed").length,
			});
		} catch (error) {
			return sendError(res, error);
		}
	}
}

export const pushApiService = new PushApiService();
