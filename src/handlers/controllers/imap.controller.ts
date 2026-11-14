import { PublicRoute } from "@/utils/decorators";
import type { ImapRequestBody } from "@/utils/interfaces/imap.interface";
import type { Request, Response } from "express";
import { sendError, sendSuccess } from "../helpers/response.helper";
import { imapAuthService } from "../services/ImapAuthService";
import { imapDiagnosticsService } from "../services/ImapDiagnosticsService";
import { imapEmailService } from "../services/ImapEmailService";
import { imapMailboxService } from "../services/ImapMailboxService";
import { imapSendService } from "../services/ImapSendService";
import { imapStreamService } from "../services/ImapStreamService";
import { vacationSenderService } from "../services/VacationSenderService";

/**
 * Controller facade for IMAP operations.
 * Routes HTTP requests to dedicated, modular domain services with
 * built-in memory leak protection and TTL caching.
 */
class ImapController {
	// ── Authentication & Account ──

	@PublicRoute()
	async loginUser(
		req: Request<
			{},
			{},
			Pick<ImapRequestBody, "imap_username" | "imap_password">
		>,
		res: Response,
	) {
		return imapAuthService.loginUser(req, res);
	}

	@PublicRoute()
	async validateNewUser(req: Request<{}, {}, ImapRequestBody>, res: Response) {
		return imapAuthService.validateNewUser(req, res);
	}

	@PublicRoute()
	async setupStream(req: Request<{}, {}, ImapRequestBody>, res: Response) {
		return imapAuthService.setupStream(req, res);
	}

	@PublicRoute()
	async autodiscover(req: Request, res: Response): Promise<void> {
		return imapAuthService.autodiscover(req, res);
	}

	async reLogin(req: Request, res: Response) {
		return imapAuthService.reLogin(req, res);
	}

	@PublicRoute()
	async userLogout(req: Request, res: Response) {
		return imapAuthService.userLogout(req, res);
	}

	async userProfile(req: Request, res: Response) {
		return imapAuthService.userProfile(req, res);
	}

	async listAccounts(req: Request, res: Response) {
		return imapAuthService.listAccounts(req, res);
	}

	// ── Mailbox & Folders ──

	async loadMailboxes(req: Request, res: Response) {
		return imapMailboxService.loadMailboxes(req, res);
	}

	async mailboxTree(req: Request, res: Response) {
		return imapMailboxService.mailboxTree(req, res);
	}

	async syncOnlySingleFolder(req: Request, res: Response) {
		return imapMailboxService.syncOnlySingleFolder(req, res);
	}

	async syncCompleteMailbox(req: Request, res: Response) {
		return imapMailboxService.syncCompleteMailbox(req, res);
	}

	async handleMailboxOperations(req: Request, res: Response) {
		return imapMailboxService.handleMailboxOperations(req, res);
	}

	async emptyFolder(req: Request, res: Response) {
		return imapMailboxService.emptyFolder(req, res);
	}

	async getQuota(req: Request, res: Response) {
		return imapMailboxService.getQuota(req, res);
	}

	// ── Email Query & Sync ──

	async loadEmails(
		req: Request<
			{},
			{},
			{},
			{
				folder?: string;
				folderId?: string;
				page?: number;
				offset?: number;
				limit?: number;
			}
		>,
		res: Response,
	) {
		return imapEmailService.loadEmails(req, res);
	}

	async loadEmailBody(req: Request, res: Response) {
		return imapEmailService.loadEmailBody(req, res);
	}

	async loadUnseenEmails(req: Request, res: Response) {
		return imapEmailService.loadUnseenEmails(req, res);
	}

	async syncOnlyEmails(req: Request, res: Response) {
		return imapEmailService.syncEmails(req, res);
	}

	async syncOnlyFolderEmails(req: Request, res: Response) {
		return imapEmailService.syncEmails(req, res);
	}

	async searchEmails(req: Request, res: Response) {
		return imapEmailService.searchEmails(req, res);
	}

	async fetchHeaders(req: Request, res: Response) {
		return imapEmailService.fetchHeaders(req, res);
	}

	async downloadAttachment(req: Request, res: Response) {
		return imapEmailService.downloadAttachment(req, res);
	}

	// ── Email Mutations ──

	async appendMessage(req: Request, res: Response) {
		return imapEmailService.appendMessage(req, res);
	}

	async moveToTrash(req: Request, res: Response) {
		return imapEmailService.moveToTrash(req, res);
	}

	async handleFlagsOnMessages(req: Request, res: Response) {
		return imapEmailService.handleFlagsOnMessages(req, res);
	}

	async handleCustomFlags(req: Request, res: Response) {
		return imapEmailService.handleCustomFlags(req, res);
	}

	async moveToFolder(req: Request, res: Response) {
		return imapEmailService.moveToFolder(req, res);
	}

	async copyToAnotherFolder(req: Request, res: Response) {
		return imapEmailService.copyToAnotherFolder(req, res);
	}

	// ── Outbound Email ──

	async sendEmail(req: Request, res: Response) {
		return imapSendService.sendEmail(req, res);
	}

	// ── Real-Time IDLE Streaming ──

	async streamEvents(req: Request, res: Response) {
		return imapStreamService.streamEvents(req, res);
	}

	// ── Diagnostics & Capabilities ──

	async connectionStatus(req: Request, res: Response) {
		return imapDiagnosticsService.connectionStatus(req, res);
	}

	async getServerCapabilities(req: Request, res: Response) {
		return imapDiagnosticsService.getServerCapabilities(req, res);
	}

	async checkCapability(req: Request, res: Response) {
		return imapDiagnosticsService.checkCapability(req, res);
	}

	async refreshCapabilities(req: Request, res: Response) {
		return imapDiagnosticsService.refreshCapabilities(req, res);
	}

	async dispatchJob(req: Request, res: Response) {
		return imapDiagnosticsService.dispatchJob(req, res);
	}

	async getJobStatus(req: Request, res: Response) {
		return imapDiagnosticsService.getJobStatus(req, res);
	}

	async listJobs(req: Request, res: Response) {
		return imapDiagnosticsService.listJobs(req, res);
	}

	async test(req: Request, res: Response) {
		return imapDiagnosticsService.test(req, res);
	}

	async onFirstLoad(req: Request, res: Response) {
		return imapDiagnosticsService.onFirstLoad(req, res);
	}

	// ── Automatic Replies / Vacation Responder ──

	async getAutomaticReplies(req: Request, res: Response) {
		try {
			const userEmail = ((req as any).user?.email ||
				req.query?.accountEmail ||
				req.params?.accountId) as string;
			if (!userEmail) throw new Error("Account email or login required");
			const settings = await vacationSenderService.getSettings(userEmail);
			return sendSuccess(
				res,
				settings || {
					account_email: userEmail,
					is_enabled: false,
					only_during_period: false,
					time_zone: "UTC",
					only_contacts: false,
					reply_outside_org: true,
					message_text: "",
					rate_limit_days: 1,
				},
			);
		} catch (error) {
			return sendError(res, error);
		}
	}

	async updateAutomaticReplies(req: Request, res: Response) {
		try {
			const userEmail = ((req as any).user?.email ||
				req.body?.accountEmail ||
				req.params?.accountId) as string;
			if (!userEmail) throw new Error("Account email or login required");
			const updated = await vacationSenderService.updateSettings(
				userEmail,
				req.body,
			);
			return sendSuccess(res, updated, "Automatic replies updated");
		} catch (error) {
			return sendError(res, error);
		}
	}
}

export default new ImapController();
