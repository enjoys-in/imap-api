import { randomUUID } from "node:crypto";
import { Logging } from "@/logs";
import { AppEvents } from "@/utils/services/Events";
import { getSocketIo } from "@/utils/services/sockets/Sockets";
import { ImapFactory } from "../factory/ImapFactory";
import { getAuthenticatedImapService } from "../helpers/session.helper";
import { type ImapJob, type ImapJobPayloads, ImapJobType } from "./types";

/** Socket.IO event name for job status updates */
const JOB_STATUS_EVENT = "imap:job:status";

/**
 * ImapJobProcessor
 *
 * A lightweight in-process job queue for IMAP operations that are:
 *   - destructive (deletes, expunges)
 *   - bulk (move-all, mark-all)
 *   - heavy (global sync)
 *
 * These don't need an immediate HTTP response so the API returns a
 * `jobId` instantly and the work happens asynchronously. The client
 * receives status updates via Socket.IO.
 *
 * The queue is in-memory (Map). For production scale you can swap
 * the storage to Redis or BullMQ — the job dispatch API stays the same.
 */
export class ImapJobProcessor {
	private static jobs = new Map<string, ImapJob>();
	private static processing = false;
	private static queue: string[] = []; // ordered job IDs

	/**
	 * Enqueue a new background job and return its ID immediately.
	 */
	static dispatch<T extends ImapJobType>(
		type: T,
		payload: ImapJobPayloads[T],
	): ImapJob<T> {
		const job: ImapJob<T> = {
			id: randomUUID(),
			type,
			payload,
			status: "queued",
			createdAt: new Date(),
		};

		// Bound queue map to prevent unbounded memory growth
		if (ImapJobProcessor.jobs.size > 100) {
			ImapJobProcessor.cleanup(30 * 60 * 1000);
		}

		ImapJobProcessor.jobs.set(job.id, job as ImapJob);
		ImapJobProcessor.queue.push(job.id);

		// Emit internal event so callers can react
		AppEvents.emit("imap:job:queued", job);

		// Kick the processor (non-blocking)
		ImapJobProcessor.processNext();

		return job;
	}

	/**
	 * Get the current status of a job.
	 */
	static getJob(jobId: string): ImapJob | undefined {
		return ImapJobProcessor.jobs.get(jobId);
	}

	/**
	 * List recent jobs, newest first.
	 */
	static listJobs(limit = 50): ImapJob[] {
		const all = Array.from(ImapJobProcessor.jobs.values());
		return all
			.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
			.slice(0, limit);
	}

	/**
	 * Clean up completed/failed jobs older than `maxAge` ms (default 1 hour).
	 */
	static cleanup(maxAgeMs = 60 * 60 * 1000): number {
		const cutoff = Date.now() - maxAgeMs;
		let removed = 0;
		for (const [id, job] of ImapJobProcessor.jobs) {
			if (
				(job.status === "completed" || job.status === "failed") &&
				job.createdAt.getTime() < cutoff
			) {
				ImapJobProcessor.jobs.delete(id);
				removed++;
			}
		}
		return removed;
	}

	// ──────────────────────────────────────────────
	// Internal processing loop
	// ──────────────────────────────────────────────

	private static async processNext(): Promise<void> {
		if (ImapJobProcessor.processing) return; // already running
		const jobId = ImapJobProcessor.queue.shift();
		if (!jobId) return;

		const job = ImapJobProcessor.jobs.get(jobId);
		if (!job) {
			ImapJobProcessor.processNext();
			return;
		}

		ImapJobProcessor.processing = true;
		job.status = "processing";
		job.startedAt = new Date();
		ImapJobProcessor.emitStatus(job);

		try {
			const result = await ImapJobProcessor.execute(job);
			job.status = "completed";
			job.result = result;
			job.completedAt = new Date();
		} catch (err: any) {
			job.status = "failed";
			job.error = err?.message ?? String(err);
			job.completedAt = new Date();
			Logging.error(`[ImapJob] ${job.type} failed: ${job.error}`);
		}

		ImapJobProcessor.emitStatus(job);
		ImapJobProcessor.processing = false;

		// Process next in queue
		if (ImapJobProcessor.queue.length > 0) {
			setImmediate(() => ImapJobProcessor.processNext());
		}
	}

	/**
	 * Route a job to the correct handler.
	 */
	private static async execute(job: ImapJob): Promise<unknown> {
		const { type, payload } = job;

		switch (type) {
			case ImapJobType.DELETE_MESSAGES: {
				const p =
					payload as ImapJobPayloads[typeof ImapJobType.DELETE_MESSAGES];
				const service = await ImapJobProcessor.getService(p.userEmail);
				return service.deleteMessages(p.uids, p.mailbox);
			}

			case ImapJobType.DELETE_ALL_MESSAGES: {
				const p =
					payload as ImapJobPayloads[typeof ImapJobType.DELETE_ALL_MESSAGES];
				const service = await ImapJobProcessor.getService(p.userEmail);
				return service.deleteAllMessages(p.mailbox);
			}

			case ImapJobType.MOVE_ALL_MESSAGES: {
				const p =
					payload as ImapJobPayloads[typeof ImapJobType.MOVE_ALL_MESSAGES];
				const service = await ImapJobProcessor.getService(p.userEmail);
				return service.moveAllMessages(p.fromMailbox, p.toMailbox);
			}

			case ImapJobType.MARK_ALL_READ: {
				const p = payload as ImapJobPayloads[typeof ImapJobType.MARK_ALL_READ];
				const service = await ImapJobProcessor.getService(p.userEmail);
				return service.markAllAsRead(p.mailbox);
			}

			case ImapJobType.MARK_ALL_UNREAD: {
				const p =
					payload as ImapJobPayloads[typeof ImapJobType.MARK_ALL_UNREAD];
				const service = await ImapJobProcessor.getService(p.userEmail);
				return service.markAllAsUnread(p.mailbox);
			}

			case ImapJobType.GLOBAL_SYNC: {
				const p = payload as ImapJobPayloads[typeof ImapJobType.GLOBAL_SYNC];
				const service = await ImapJobProcessor.getService(p.userEmail);
				return service.globalSync(p.userEmail);
			}

			case ImapJobType.EXPUNGE_MAILBOX: {
				const p =
					payload as ImapJobPayloads[typeof ImapJobType.EXPUNGE_MAILBOX];
				const service = await ImapJobProcessor.getService(p.userEmail);
				// Delete messages already marked \Deleted
				const uids = await service.searchMessages(p.mailbox, { deleted: true });
				if (Array.isArray(uids) && uids.length > 0) {
					await service.deleteMessages(uids, p.mailbox);
				}
				return { expunged: Array.isArray(uids) ? uids.length : 0 };
			}

			case ImapJobType.BULK_FLAG_UPDATE: {
				const p =
					payload as ImapJobPayloads[typeof ImapJobType.BULK_FLAG_UPDATE];
				const service = await ImapJobProcessor.getService(p.userEmail);
				if (p.addFlags?.length) {
					await service.setCustomFlags(p.uids, p.addFlags);
				}
				if (p.removeFlags?.length) {
					await service.removeCustomFlags(p.uids, p.removeFlags);
				}
				return { updated: p.uids.length };
			}

			default:
				throw new Error(`Unknown job type: ${type}`);
		}
	}

	/**
	 * Retrieve the ImapService instance for a user. Throws if not found.
	 */
	private static async getService(userEmail: string) {
		const service = await getAuthenticatedImapService(userEmail);
		if (!service) {
			throw new Error(
				`No active IMAP connection for "${userEmail}". User must be logged in.`,
			);
		}
		return service;
	}

	/**
	 * Broadcast job status to all connected Socket.IO clients.
	 */
	private static emitStatus(job: ImapJob) {
		try {
			const io = getSocketIo();
			io.emit(JOB_STATUS_EVENT, {
				id: job.id,
				type: job.type,
				status: job.status,
				error: job.error ?? null,
				createdAt: job.createdAt,
				startedAt: job.startedAt ?? null,
				completedAt: job.completedAt ?? null,
			});
		} catch {
			// Socket.IO might not be ready — swallow
		}
	}
}
