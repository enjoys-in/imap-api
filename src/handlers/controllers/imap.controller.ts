import { PublicRoute } from "@/utils/decorators";
import type { ImapRequestBody } from "@/utils/interfaces/imap.interface";
import type { Request, Response } from "express";
import { imapAuthService } from "../services/ImapAuthService";
import { imapDiagnosticsService } from "../services/ImapDiagnosticsService";
import { imapEmailService } from "../services/ImapEmailService";
import { imapMailboxService } from "../services/ImapMailboxService";
import { imapSendService } from "../services/ImapSendService";
import { imapStreamService } from "../services/ImapStreamService";

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
}

export default new ImapController();
