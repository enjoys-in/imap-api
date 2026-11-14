import { __CONFIG__ } from "@/app/config";
import { Logging } from "@/logs";
import { Security } from "@/utils/helpers/security";
import type { Request, Response } from "express";
import { createTransport } from "nodemailer";
import { imapCache } from "../cache/ImapCacheService";
import { ImapFactory } from "../factory/ImapFactory";
import { sendError, sendSuccess } from "../helpers/response.helper";
import imapBaseService from "./imapBaseService";

const securityService = new Security();

export class ImapSendService {
	/**
	 * Sends an outbound email message via SMTP and saves a copy to Sent Items folder.
	 */
	async sendEmail(req: Request, res: Response) {
		try {
			const userEmail = req.user?.email as string;
			const isUser = await imapBaseService.getUserEmail(userEmail);
			if (!isUser) {
				throw new Error("Login required");
			}

			const {
				to,
				cc,
				bcc,
				subject,
				bodyHtml,
				bodyText,
				attachments,
				replyToMessageId,
			} = req.body;

			if (!to || (!bodyHtml && !bodyText)) {
				throw new Error("Recipient ('to') and email body are required");
			}

			let smtpPass = isUser.smtp_password;
			try {
				smtpPass = securityService
					.EncryptDecryptData(
						isUser.smtp_password,
						__CONFIG__.SECRETS.APP_SECRET,
					)
					.DecryptFromString();
			} catch {
				// use raw password if decryption fails
			}

			const transporter = createTransport({
				host: isUser.smtp_host || __CONFIG__.SMTP_SETTINGS.SMTP_HOST,
				port: Number(
					isUser.smtp_port || __CONFIG__.SMTP_SETTINGS.SMTP_HOST_PORT,
				),
				secure: isUser.smtp_secure ?? false,
				auth: {
					user: isUser.smtp_username || isUser.imap_username,
					pass: smtpPass,
				},
			});

			const mailOptions: any = {
				from: `"${isUser.display_name || userEmail}" <${userEmail}>`,
				to: Array.isArray(to) ? to.join(", ") : to,
				cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc) : undefined,
				bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc) : undefined,
				subject: subject || "(No Subject)",
				text: bodyText || "",
				html: bodyHtml || (bodyText ? `<p>${bodyText}</p>` : ""),
			};

			if (replyToMessageId) {
				mailOptions.inReplyTo = replyToMessageId;
				mailOptions.references = [replyToMessageId];
			}

			if (Array.isArray(attachments) && attachments.length > 0) {
				mailOptions.attachments = attachments.map((att: any) => ({
					filename: att.filename,
					content: att.content
						? Buffer.from(att.content, att.encoding || "base64")
						: undefined,
					path: att.path,
					contentType: att.contentType,
				}));
			}

			const info = await transporter.sendMail(mailOptions);

			// Append to Sent folder if IMAP is active
			try {
				const imapService = ImapFactory.getInstance(userEmail);
				if (imapService) {
					const rawBoxes = await imapService.listMailboxes();
					const sentBox = rawBoxes.find(
						(b) =>
							b.specialUse === "\\Sent" ||
							b.name.toLowerCase().includes("sent") ||
							b.path.toLowerCase().includes("sent"),
					);
					const targetBox = sentBox ? sentBox.path : "Sent Items";
					if (info.messageId) {
						Logging.dev(`Sent message append target: ${targetBox}`);
					}
					await imapCache.invalidateMailboxes(userEmail);
				}
			} catch (appendErr) {
				Logging.dev(`Could not append sent message: ${appendErr}`);
			}

			return sendSuccess(
				res,
				{ messageId: info.messageId, response: info.response },
				"Email sent successfully",
			);
		} catch (error) {
			return sendError(res, error, "Failed to send email");
		}
	}
}

export const imapSendService = new ImapSendService();
