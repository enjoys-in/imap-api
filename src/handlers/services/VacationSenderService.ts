import { createTransport } from "nodemailer";
import { AutomaticReplyEntity } from "@/factory/entities/auto_reply.entity";
import { InjectRepository } from "@/factory/typeorm";
import { Logging } from "@/logs";
import { imapCache } from "../cache/ImapCacheService";
import imapBaseService from "./imapBaseService";

export interface InboundEmailContext {
	fromAddress: string;
	toAddress?: string;
	subject: string;
	messageId?: string;
	headers?: Record<string, string | string[] | undefined>;
}

export interface AutoReplySettingsDto {
	isEnabled: boolean;
	onlyDuringPeriod: boolean;
	startTime?: string | Date | null;
	endTime?: string | Date | null;
	timeZone?: string;
	onlyContacts?: boolean;
	replyOutsideOrg?: boolean;
	messageText: string;
	messageHtml?: string | null;
	rateLimitDays?: number;
	blockCalendar?: boolean;
	declineNewInvitations?: boolean;
}

/**
 * Service for managing Vacation / Out of Office Automatic Replies.
 * Implements strict RFC 3834 & RFC 5230 anti-loop safeguards, time window
 * evaluation, and recipient deduplication across our multi-engine cache.
 */
export class VacationSenderService {
	private get repo() {
		return InjectRepository(AutomaticReplyEntity);
	}

	/**
	 * Retrieves current automatic reply configuration for an account.
	 */
	async getSettings(accountEmail: string): Promise<AutomaticReplyEntity | null> {
		try {
			return await this.repo.findOne({
				where: { account_email: accountEmail.toLowerCase() },
			});
		} catch (error: any) {
			Logging.dev(`[VacationSenderService] getSettings error: ${error?.message}`);
			return null;
		}
	}

	/**
	 * Updates or inserts automatic reply settings for an account.
	 */
	async updateSettings(
		accountEmail: string,
		dto: Partial<AutoReplySettingsDto>,
	): Promise<AutomaticReplyEntity> {
		const email = accountEmail.toLowerCase();
		let entity = await this.repo.findOne({ where: { account_email: email } });

		if (!entity) {
			entity = this.repo.create({
				account_email: email,
				is_enabled: false,
				only_during_period: false,
				time_zone: dto.timeZone || "UTC",
				only_contacts: false,
				reply_outside_org: true,
				message_text: "",
				rate_limit_days: 1,
			});
		}

		if (dto.isEnabled !== undefined) entity.is_enabled = Boolean(dto.isEnabled);
		if (dto.onlyDuringPeriod !== undefined)
			entity.only_during_period = Boolean(dto.onlyDuringPeriod);
		if (dto.startTime !== undefined)
			entity.start_time = dto.startTime ? new Date(dto.startTime) : null;
		if (dto.endTime !== undefined)
			entity.end_time = dto.endTime ? new Date(dto.endTime) : null;
		if (dto.timeZone !== undefined) entity.time_zone = dto.timeZone;
		if (dto.onlyContacts !== undefined)
			entity.only_contacts = Boolean(dto.onlyContacts);
		if (dto.replyOutsideOrg !== undefined)
			entity.reply_outside_org = Boolean(dto.replyOutsideOrg);
		if (dto.messageText !== undefined) entity.message_text = dto.messageText;
		if (dto.messageHtml !== undefined) entity.message_html = dto.messageHtml || null;
		if (dto.rateLimitDays !== undefined)
			entity.rate_limit_days = Number(dto.rateLimitDays) || 1;
		if (dto.blockCalendar !== undefined)
			entity.block_calendar = Boolean(dto.blockCalendar);
		if (dto.declineNewInvitations !== undefined)
			entity.decline_new_invitations = Boolean(dto.declineNewInvitations);

		return await this.repo.save(entity);
	}

	/**
	 * Evaluates whether an inbound message qualifies for an automatic vacation response,
	 * verifies anti-loop constraints (RFC 3834), checks deduplication rate limits,
	 * and dispatches the response via outbound SMTP.
	 */
	async evaluateAndSendVacationReply(
		accountEmail: string,
		inbound: InboundEmailContext,
	): Promise<boolean> {
		const email = accountEmail.toLowerCase();
		const settings = await this.getSettings(email);

		if (!settings || !settings.is_enabled) {
			return false;
		}

		// 1. Time Window Evaluation
		if (settings.only_during_period) {
			const now = Date.now();
			if (settings.start_time && now < new Date(settings.start_time).getTime()) {
				return false;
			}
			if (settings.end_time && now > new Date(settings.end_time).getTime()) {
				return false;
			}
		}

		// 2. Strict RFC 3834 Anti-Loop Safety Checks
		if (this.shouldSuppressVacationReply(inbound, email)) {
			return false;
		}

		// 3. Rate Limiting / Deduplication Check via Multi-Engine Cache
		const sender = inbound.fromAddress.trim().toLowerCase();
		const dedupeKey = `vacation_reply:${email}:${sender}`;
		const cacheEngine = imapCache.getEngine();

		const alreadySent = await cacheEngine.has(dedupeKey);
		if (alreadySent) {
			Logging.dev(
				`[VacationSenderService] Suppressed: Already replied to ${sender} within rate limit window`,
			);
			return false;
		}

		// 4. Retrieve Account SMTP Credentials
		const userRecord = await imapBaseService.getUserEmail(email);
		if (!userRecord) {
			Logging.dev(
				`[VacationSenderService] Cannot send vacation reply: Account ${email} not found`,
			);
			return false;
		}

		const userConfig = imapBaseService.configDTO(userRecord);

		// 5. Dispatch Vacation Response via Outbound SMTP
		await this.dispatchVacationEmail(settings, inbound, userConfig);

		// 6. Record Deduplication in Cache
		const ttlSeconds = (settings.rate_limit_days || 1) * 86400;
		await cacheEngine.set(dedupeKey, { sentAt: Date.now() }, ttlSeconds);

		Logging.dev(
			`[VacationSenderService] Dispatched automatic reply to ${sender} for "${inbound.subject}" (TTL: ${ttlSeconds}s)`,
		);
		return true;
	}

	/**
	 * Strict RFC 3834 & RFC 5230 Anti-Loop and Suppression Rules.
	 */
	shouldSuppressVacationReply(
		inbound: InboundEmailContext,
		accountEmail: string,
	): boolean {
		const from = (inbound.fromAddress || "").trim().toLowerCase();
		const headers = inbound.headers || {};

		// 1. Self-Sent Check: Don't reply to self or internal test syncs
		if (from === accountEmail.toLowerCase()) {
			return true;
		}

		// 2. Bounce / DSN / Postmaster Checks
		const returnPath = this.getHeader(headers, "return-path");
		if (
			returnPath === "<>" ||
			returnPath === "" ||
			from.includes("mailer-daemon") ||
			from.includes("postmaster")
		) {
			return true;
		}

		// 3. RFC 3834 Auto-Submitted Header: Stop bot-to-bot reply loops
		const autoSubmitted = this.getHeader(headers, "auto-submitted");
		if (autoSubmitted && autoSubmitted.toLowerCase() !== "no") {
			return true;
		}

		// 4. Mailing List Headers: Never broadcast vacation notices to lists
		if (
			this.getHeader(headers, "list-id") ||
			this.getHeader(headers, "list-unsubscribe") ||
			this.getHeader(headers, "x-mailing-list") ||
			this.getHeader(headers, "mailing-list")
		) {
			return true;
		}

		// 5. Precedence Checks: bulk, list, junk
		const precedence = this.getHeader(headers, "precedence");
		if (
			precedence &&
			["bulk", "list", "junk"].includes(precedence.toLowerCase())
		) {
			return true;
		}

		// 6. Microsoft Exchange Auto-Response Suppression
		const xAutoSuppress = this.getHeader(headers, "x-auto-response-suppress");
		if (
			xAutoSuppress &&
			(xAutoSuppress.includes("All") ||
				xAutoSuppress.includes("OOF") ||
				xAutoSuppress.includes("AutoReply"))
		) {
			return true;
		}

		// 7. Generic No-Reply Senders
		if (/^(no-?reply|donotreply|notifications?|support-alerts)@/i.test(from)) {
			return true;
		}

		// 8. Spam Flag
		const spamFlag = this.getHeader(headers, "x-spam-flag");
		if (spamFlag && spamFlag.toUpperCase() === "YES") {
			return true;
		}

		return false;
	}

	/**
	 * Dispatches RFC 3834 compliant automated message via SMTP.
	 */
	private async dispatchVacationEmail(
		settings: AutomaticReplyEntity,
		inbound: InboundEmailContext,
		userConfig: any,
	): Promise<void> {
		const transport = createTransport({
			host: userConfig.smtp_host,
			port: Number(userConfig.smtp_port) || 465,
			secure: Boolean(userConfig.smtp_secure),
			auth: {
				user: userConfig.smtp_username,
				pass: userConfig.smtp_password,
			},
		});

		const cleanSubject = inbound.subject.startsWith("Automatic reply:")
			? inbound.subject
			: `Automatic reply: ${inbound.subject}`;

		await transport.sendMail({
			from: `"${settings.account_email.split("@")[0]}" <${settings.account_email}>`,
			to: inbound.fromAddress,
			subject: cleanSubject,
			text: settings.message_text,
			html: settings.message_html || undefined,
			headers: {
				"Auto-Submitted": "auto-replied",
				Precedence: "bulk",
				"X-Auto-Response-Suppress": "All",
				...(inbound.messageId
					? {
							"In-Reply-To": inbound.messageId,
							References: inbound.messageId,
						}
					: {}),
			},
		});
	}

	private getHeader(
		headers: Record<string, string | string[] | undefined>,
		key: string,
	): string | null {
		const targetKey = key.toLowerCase();
		for (const [k, v] of Object.entries(headers)) {
			if (k.toLowerCase() === targetKey) {
				if (!v) return null;
				return Array.isArray(v) ? v[0] : String(v);
			}
		}
		return null;
	}
}

export const vacationSenderService = new VacationSenderService();
