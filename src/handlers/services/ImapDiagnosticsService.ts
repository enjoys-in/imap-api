import type { Request, Response } from "express";
import { imapCache } from "../cache/ImapCacheService";
import { ImapFactory } from "../factory/ImapFactory";
import {
	sendAccepted,
	sendError,
	sendSuccess,
} from "../helpers/response.helper";
import { ImapJobProcessor } from "../jobs/ImapJobProcessor";
import { ImapJobType } from "../jobs/types";
import imapBaseService from "./imapBaseService";

export class ImapDiagnosticsService {
	/**
	 * Checks whether the user has an active, usable IMAP connection.
	 */
	async connectionStatus(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const imapService = ImapFactory.getInstance(userEmail);

			if (!imapService) {
				return sendSuccess(res, { connected: false });
			}

			return sendSuccess(res, {
				connected: imapService.isConnected(),
				idling: imapService.isIdling(),
				currentMailbox: imapService.getCurrentMailbox() || null,
				stats: imapService.getConnectionStats(),
			});
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Returns full capability report for the user's IMAP server with 1h TTL caching.
	 */
	async getServerCapabilities(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			if (!userEmail) throw new Error("Login required");

			const cached = await imapCache.getCapabilities(userEmail);
			if (cached) {
				return sendSuccess(res, cached);
			}

			const capMgr = ImapFactory.getCapabilities(userEmail);
			if (!capMgr) {
				return sendError(
					res,
					"No active IMAP connection. Please login first.",
					undefined,
					400,
				);
			}

			const data = capMgr.toJSON();
			await imapCache.setCapabilities(userEmail, data, 3600);

			return sendSuccess(res, data);
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Checks whether specific IMAP capabilities are supported by the server.
	 */
	async checkCapability(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			if (!userEmail) throw new Error("Login required");

			const capMgr = ImapFactory.getCapabilities(userEmail);
			if (!capMgr) {
				return sendError(
					res,
					"No active IMAP connection. Please login first.",
					undefined,
					400,
				);
			}

			const { capability, capabilities } = req.body as {
				capability?: string;
				capabilities?: string[];
			};

			if (!capability && !capabilities) {
				return sendError(
					res,
					'Provide "capability" (string) or "capabilities" (string[]) in request body.',
					undefined,
					400,
				);
			}

			if (capability && !capabilities) {
				const supported = capMgr.supports(capability);
				return sendSuccess(res, {
					capability,
					supported,
					features: capMgr.getFeatures(),
				});
			}

			const capsToCheck = capabilities || [capability!];
			const result = capMgr.supportsBatch(capsToCheck);

			return sendSuccess(res, {
				capabilities: result,
				allSupported: Object.values(result).every(Boolean),
				features: capMgr.getFeatures(),
			});
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Forces a re-read of server capabilities.
	 */
	async refreshCapabilities(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			if (!userEmail) throw new Error("Login required");

			const service = ImapFactory.getInstance(userEmail);
			if (!service) {
				return sendError(
					res,
					"No active IMAP connection. Please login first.",
					undefined,
					400,
				);
			}

			await service.capabilities.refresh();
			const data = service.capabilities.toJSON();
			await imapCache.setCapabilities(userEmail, data, 3600);

			return sendSuccess(res, data, "Capabilities refreshed");
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Dispatches a background job.
	 */
	async dispatchJob(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			if (!userEmail) throw new Error("Login required");

			const { type, ...extra } = req.body as {
				type: string;
				[key: string]: any;
			};

			if (!type) throw new Error("Job type is required");

			const validTypes = Object.values(ImapJobType) as string[];
			if (!validTypes.includes(type)) {
				throw new Error(
					`Unknown job type: ${type}. Valid types: ${validTypes.join(", ")}`,
				);
			}

			const payload = { userEmail, ...extra } as any;
			const job = ImapJobProcessor.dispatch(type as ImapJobType, payload);

			return sendAccepted(res, "Job dispatched", {
				jobId: job.id,
				type: job.type,
				status: job.status,
			});
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Retrieves status of a specific background job.
	 */
	async getJobStatus(req: Request, res: Response) {
		try {
			const jobId = req.query?.id as string;
			if (!jobId) throw new Error("Job id is required");

			const job = ImapJobProcessor.getJob(jobId);
			if (!job) {
				return sendError(res, "Job not found", undefined, 404);
			}

			return sendSuccess(res, job);
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Lists recent background jobs.
	 */
	async listJobs(req: Request, res: Response) {
		try {
			const limit = Number(req.query?.limit) || 50;
			const jobs = ImapJobProcessor.listJobs(limit);
			return sendSuccess(res, jobs);
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * Health check / test endpoint.
	 */
	async test(_req: Request, res: Response) {
		try {
			return sendSuccess(res, "Please Select any operation");
		} catch (error) {
			return sendError(res, error);
		}
	}

	/**
	 * First-time setup envelope retrieval.
	 */
	async onFirstLoad(req: Request, res: Response) {
		try {
			const isUser = await imapBaseService.getUserEmail(
				req.user?.email as string,
			);
			const config = imapBaseService.configDTO(isUser);
			const envelope = await ImapFactory.firstTimeSetup(config);

			return sendSuccess(res, envelope);
		} catch (error) {
			return sendError(res, error);
		}
	}
}

export const imapDiagnosticsService = new ImapDiagnosticsService();
