import { promises as dns } from "node:dns";
import { Logging } from "@/logs";

export interface AutodiscoverResult {
	success: boolean;
	source:
		| "preset"
		| "ispdb"
		| "thunderbird"
		| "outlook"
		| "srv"
		| "mx"
		| "heuristic";
	domain: string;
	email: string;
	displayName?: string;
	imap?: {
		host: string;
		port: number;
		secure: boolean;
		username: string;
	};
	smtp?: {
		host: string;
		port: number;
		secure: boolean;
		username: string;
	};
	message?: string;
}

const KNOWN_PRESETS: Record<
	string,
	{
		imapHost: string;
		imapPort: number;
		imapSecure: boolean;
		smtpHost: string;
		smtpPort: number;
		smtpSecure: boolean;
	}
> = {
	"airsend.in": {
		imapHost: "mail.enjoys.in",
		imapPort: 993,
		imapSecure: true,
		smtpHost: "mail.airsend.in",
		smtpPort: 587,
		smtpSecure: false,
	},
	"enjoys.in": {
		imapHost: "mail.enjoys.in",
		imapPort: 993,
		imapSecure: true,
		smtpHost: "mail.enjoys.in",
		smtpPort: 587,
		smtpSecure: false,
	},
	"gmail.com": {
		imapHost: "imap.gmail.com",
		imapPort: 993,
		imapSecure: true,
		smtpHost: "smtp.gmail.com",
		smtpPort: 587,
		smtpSecure: false,
	},
	"googlemail.com": {
		imapHost: "imap.gmail.com",
		imapPort: 993,
		imapSecure: true,
		smtpHost: "smtp.gmail.com",
		smtpPort: 587,
		smtpSecure: false,
	},
	"outlook.com": {
		imapHost: "outlook.office365.com",
		imapPort: 993,
		imapSecure: true,
		smtpHost: "smtp.office365.com",
		smtpPort: 587,
		smtpSecure: false,
	},
	"hotmail.com": {
		imapHost: "outlook.office365.com",
		imapPort: 993,
		imapSecure: true,
		smtpHost: "smtp.office365.com",
		smtpPort: 587,
		smtpSecure: false,
	},
	"live.com": {
		imapHost: "outlook.office365.com",
		imapPort: 993,
		imapSecure: true,
		smtpHost: "smtp.office365.com",
		smtpPort: 587,
		smtpSecure: false,
	},
	"office365.com": {
		imapHost: "outlook.office365.com",
		imapPort: 993,
		imapSecure: true,
		smtpHost: "smtp.office365.com",
		smtpPort: 587,
		smtpSecure: false,
	},
	"yahoo.com": {
		imapHost: "imap.mail.yahoo.com",
		imapPort: 993,
		imapSecure: true,
		smtpHost: "smtp.mail.yahoo.com",
		smtpPort: 587,
		smtpSecure: false,
	},
	"icloud.com": {
		imapHost: "imap.mail.me.com",
		imapPort: 993,
		imapSecure: true,
		smtpHost: "smtp.mail.me.com",
		smtpPort: 587,
		smtpSecure: false,
	},
	"zoho.com": {
		imapHost: "imap.zoho.com",
		imapPort: 993,
		imapSecure: true,
		smtpHost: "smtp.zoho.com",
		smtpPort: 587,
		smtpSecure: false,
	},
	"zoho.in": {
		imapHost: "imap.zoho.in",
		imapPort: 993,
		imapSecure: true,
		smtpHost: "smtp.zoho.in",
		smtpPort: 587,
		smtpSecure: false,
	},
	"fastmail.com": {
		imapHost: "imap.fastmail.com",
		imapPort: 993,
		imapSecure: true,
		smtpHost: "smtp.fastmail.com",
		smtpPort: 587,
		smtpSecure: false,
	},
	"yandex.com": {
		imapHost: "imap.yandex.com",
		imapPort: 993,
		imapSecure: true,
		smtpHost: "smtp.yandex.com",
		smtpPort: 465,
		smtpSecure: true,
	},
	"yandex.ru": {
		imapHost: "imap.yandex.ru",
		imapPort: 993,
		imapSecure: true,
		smtpHost: "smtp.yandex.ru",
		smtpPort: 465,
		smtpSecure: true,
	},
};

/**
 * Checks if a hostname resolves in DNS
 */
async function hostExists(hostname: string): Promise<boolean> {
	if (!hostname) return false;
	try {
		await dns.lookup(hostname);
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolves an RFC 6186 DNS SRV record
 */
async function resolveSrvRecord(
	service: string,
	domain: string,
): Promise<{ host: string; port: number } | null> {
	try {
		const records = await dns.resolveSrv(`_${service}._tcp.${domain}`);
		if (records && records.length > 0) {
			records.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
			const target = records[0].name.replace(/\.$/, "").trim();
			if (target && target !== ".") {
				return { host: target, port: records[0].port };
			}
		}
	} catch {
		// SRV record not found
	}
	return null;
}

/**
 * Resolves placeholder usernames in autoconfig XML
 */
function resolveUsername(template: string | undefined, email: string): string {
	if (!template || template.includes("%EMAILADDRESS%")) {
		return email;
	}
	if (template.includes("%EMAILLOCALPART%")) {
		return email.split("@")[0] || email;
	}
	return template.trim() || email;
}

/**
 * Parses Mozilla Thunderbird autoconfig XML (config-v1.1.xml)
 */
function parseThunderbirdXml(
	xml: string,
	email: string,
	domain: string,
	source: "ispdb" | "thunderbird" = "thunderbird",
): AutodiscoverResult | null {
	try {
		const imapMatch = xml.match(
			/<incomingServer[^>]*type=["']imap["'][^>]*>([\s\S]*?)<\/incomingServer>/i,
		);
		const smtpMatch = xml.match(
			/<outgoingServer[^>]*type=["']smtp["'][^>]*>([\s\S]*?)<\/outgoingServer>/i,
		);

		if (!imapMatch && !smtpMatch) return null;

		const imapXml = imapMatch ? imapMatch[1] : "";
		const smtpXml = smtpMatch ? smtpMatch[1] : "";

		const imapHost =
			imapXml.match(/<hostname>([^<]+)<\/hostname>/i)?.[1]?.trim() ||
			`imap.${domain}`;
		const imapPort = Number(
			imapXml.match(/<port>([^<]+)<\/port>/i)?.[1]?.trim() || 993,
		);
		const imapSocket = imapXml
			.match(/<socketType>([^<]+)<\/socketType>/i)?.[1]
			?.toUpperCase();
		const imapSecure = imapSocket === "SSL" || imapPort === 993;
		const imapUserTpl = imapXml.match(/<username>([^<]+)<\/username>/i)?.[1];

		const smtpHost =
			smtpXml.match(/<hostname>([^<]+)<\/hostname>/i)?.[1]?.trim() ||
			`smtp.${domain}`;
		const smtpPort = Number(
			smtpXml.match(/<port>([^<]+)<\/port>/i)?.[1]?.trim() || 587,
		);
		const smtpSocket = smtpXml
			.match(/<socketType>([^<]+)<\/socketType>/i)?.[1]
			?.toUpperCase();
		const smtpSecure = smtpSocket === "SSL" || smtpPort === 465;
		const smtpUserTpl = smtpXml.match(/<username>([^<]+)<\/username>/i)?.[1];

		const displayName = xml.match(/<displayName>([^<]+)<\/displayName>/i)?.[1];

		return {
			success: true,
			source,
			domain,
			email,
			displayName,
			imap: {
				host: imapHost,
				port: imapPort,
				secure: imapSecure,
				username: resolveUsername(imapUserTpl, email),
			},
			smtp: {
				host: smtpHost,
				port: smtpPort,
				secure: smtpSecure,
				username: resolveUsername(smtpUserTpl, email),
			},
		};
	} catch (e) {
		Logging.dev(`Failed to parse Thunderbird XML: ${e}`);
		return null;
	}
}

/**
 * Parses Microsoft Outlook autodiscover XML
 */
function parseOutlookXml(
	xml: string,
	email: string,
	domain: string,
): AutodiscoverResult | null {
	try {
		const protocols = xml.match(/<Protocol>([\s\S]*?)<\/Protocol>/gi);
		if (!protocols || protocols.length === 0) return null;

		let imapHost = "";
		let imapPort = 993;
		let imapSecure = true;
		let imapUser = email;

		let smtpHost = "";
		let smtpPort = 587;
		let smtpSecure = false;
		let smtpUser = email;

		for (const proto of protocols) {
			const type = proto
				.match(/<Type>([^<]+)<\/Type>/i)?.[1]
				?.toUpperCase()
				?.trim();
			const server = proto.match(/<Server>([^<]+)<\/Server>/i)?.[1]?.trim();
			const port = Number(proto.match(/<Port>([^<]+)<\/Port>/i)?.[1]?.trim());
			const loginName = proto
				.match(/<LoginName>([^<]+)<\/LoginName>/i)?.[1]
				?.trim();
			const ssl = proto
				.match(/<SSL>([^<]+)<\/SSL>/i)?.[1]
				?.toLowerCase()
				?.trim();
			const isSsl = ssl === "on" || ssl === "yes" || ssl === "1";

			if (type === "IMAP" && server) {
				imapHost = server;
				imapPort = port || 993;
				imapSecure = isSsl || imapPort === 993;
				if (loginName) imapUser = loginName;
			} else if (type === "SMTP" && server) {
				smtpHost = server;
				smtpPort = port || 587;
				smtpSecure = isSsl || smtpPort === 465;
				if (loginName) smtpUser = loginName;
			}
		}

		if (!imapHost && !smtpHost) return null;

		return {
			success: true,
			source: "outlook",
			domain,
			email,
			imap: {
				host: imapHost || `imap.${domain}`,
				port: imapPort,
				secure: imapSecure,
				username: imapUser,
			},
			smtp: {
				host: smtpHost || `smtp.${domain}`,
				port: smtpPort,
				secure: smtpSecure,
				username: smtpUser,
			},
		};
	} catch (e) {
		Logging.dev(`Failed to parse Outlook XML: ${e}`);
		return null;
	}
}

/**
 * Searches email configuration for any given domain across all industry-standard mechanisms:
 * 1. Known Presets (fast path)
 * 2. Mozilla Central ISPDB Database
 * 3. Thunderbird Autoconfig XML
 * 4. Microsoft Outlook Autodiscover XML
 * 5. RFC 6186 DNS SRV Records
 * 6. DNS MX Provider Recognition
 * 7. Active DNS Hostname Verification (imap.*, smtp.*, mail.*)
 *
 * If found -> returns { success: true, imap, smtp, ... }
 * If not found -> returns { success: false, ... } gracefully without throwing.
 */
export async function autodiscoverConfig(
	email: string,
): Promise<AutodiscoverResult> {
	const cleanEmail = email.trim();
	const domain = cleanEmail.includes("@")
		? cleanEmail.split("@")[1]?.toLowerCase().trim()
		: cleanEmail.toLowerCase().trim();

	if (!domain || !domain.includes(".")) {
		throw new Error("Invalid email domain");
	}

	// ── 1. Check Known Presets ──
	if (KNOWN_PRESETS[domain]) {
		const preset = KNOWN_PRESETS[domain];
		return {
			success: true,
			source: "preset",
			domain,
			email: cleanEmail,
			imap: {
				host: preset.imapHost,
				port: preset.imapPort,
				secure: preset.imapSecure,
				username: cleanEmail,
			},
			smtp: {
				host: preset.smtpHost,
				port: preset.smtpPort,
				secure: preset.smtpSecure,
				username: cleanEmail,
			},
		};
	}

	// ── 2. Query Central Mozilla Thunderbird ISPDB Database ──
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 2500);
		const ispdbRes = await fetch(
			`https://autoconfig.thunderbird.net/v1.1/${domain}`,
			{ signal: controller.signal },
		);
		clearTimeout(timeout);
		if (ispdbRes.ok) {
			const text = await ispdbRes.text();
			const result = parseThunderbirdXml(text, cleanEmail, domain, "ispdb");
			if (result) return result;
		}
	} catch {
		// continue to domain autoconfig
	}

	// ── 3. Query Domain's Thunderbird Autoconfig Endpoints ──
	const thunderbirdUrls = [
		`https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(cleanEmail)}`,
		`https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`,
		`http://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(cleanEmail)}`,
	];

	for (const url of thunderbirdUrls) {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 2000);
			const res = await fetch(url, { signal: controller.signal });
			clearTimeout(timeout);

			if (res.ok) {
				const text = await res.text();
				const result = parseThunderbirdXml(
					text,
					cleanEmail,
					domain,
					"thunderbird",
				);
				if (result) return result;
			}
		} catch {
			// continue
		}
	}

	// ── 4. Query Microsoft Outlook Autodiscover XML ──
	const outlookUrls = [
		`https://autodiscover.${domain}/autodiscover/autodiscover.xml`,
		`https://${domain}/autodiscover/autodiscover.xml`,
	];

	const outlookPayload = `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006">
  <Request>
    <EMailAddress>${cleanEmail}</EMailAddress>
    <AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema>
  </Request>
</Autodiscover>`;

	for (const url of outlookUrls) {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 2000);
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "text/xml; charset=utf-8" },
				body: outlookPayload,
				signal: controller.signal,
			});
			clearTimeout(timeout);

			if (res.ok) {
				const text = await res.text();
				const result = parseOutlookXml(text, cleanEmail, domain);
				if (result) return result;
			}
		} catch {
			// continue
		}
	}

	// ── 5. Query RFC 6186 DNS SRV Records ──
	try {
		const [imapsSrv, imapSrv, submissionSrv, smtpsSrv] = await Promise.all([
			resolveSrvRecord("imaps", domain),
			resolveSrvRecord("imap", domain),
			resolveSrvRecord("submission", domain),
			resolveSrvRecord("smtps", domain),
		]);

		const imapTarget = imapsSrv || imapSrv;
		const smtpTarget = submissionSrv || smtpsSrv;

		if (imapTarget && smtpTarget) {
			return {
				success: true,
				source: "srv",
				domain,
				email: cleanEmail,
				imap: {
					host: imapTarget.host,
					port: imapTarget.port,
					secure: imapsSrv !== null || imapTarget.port === 993,
					username: cleanEmail,
				},
				smtp: {
					host: smtpTarget.host,
					port: smtpTarget.port,
					secure: smtpsSrv !== null || smtpTarget.port === 465,
					username: cleanEmail,
				},
			};
		}
	} catch {
		// continue to MX inspection
	}

	// ── 6. DNS MX Record Inspection ──
	let primaryMx = "";
	try {
		const mxRecords = await dns.resolveMx(domain);
		if (mxRecords && mxRecords.length > 0) {
			mxRecords.sort((a, b) => a.priority - b.priority);
			primaryMx = mxRecords[0].exchange.toLowerCase().replace(/\.$/, "");

			// Google Workspace / Gmail
			if (primaryMx.includes("google") || primaryMx.includes("aspmx")) {
				return {
					success: true,
					source: "mx",
					domain,
					email: cleanEmail,
					imap: {
						host: "imap.gmail.com",
						port: 993,
						secure: true,
						username: cleanEmail,
					},
					smtp: {
						host: "smtp.gmail.com",
						port: 587,
						secure: false,
						username: cleanEmail,
					},
				};
			}

			// Microsoft 365 / Office 365 / Exchange Online
			if (
				primaryMx.includes("outlook") ||
				primaryMx.includes("protection.outlook") ||
				primaryMx.includes("office365")
			) {
				return {
					success: true,
					source: "mx",
					domain,
					email: cleanEmail,
					imap: {
						host: "outlook.office365.com",
						port: 993,
						secure: true,
						username: cleanEmail,
					},
					smtp: {
						host: "smtp.office365.com",
						port: 587,
						secure: false,
						username: cleanEmail,
					},
				};
			}

			// Zoho Mail
			if (primaryMx.includes("zoho")) {
				const isIndia = primaryMx.includes(".in");
				const isEu = primaryMx.includes(".eu");
				const tld = isIndia ? "in" : isEu ? "eu" : "com";
				return {
					success: true,
					source: "mx",
					domain,
					email: cleanEmail,
					imap: {
						host: `imap.zoho.${tld}`,
						port: 993,
						secure: true,
						username: cleanEmail,
					},
					smtp: {
						host: `smtp.zoho.${tld}`,
						port: 587,
						secure: false,
						username: cleanEmail,
					},
				};
			}

			// Fastmail
			if (
				primaryMx.includes("messagingengine.com") ||
				primaryMx.includes("fastmail")
			) {
				return {
					success: true,
					source: "mx",
					domain,
					email: cleanEmail,
					imap: {
						host: "imap.fastmail.com",
						port: 993,
						secure: true,
						username: cleanEmail,
					},
					smtp: {
						host: "smtp.fastmail.com",
						port: 587,
						secure: false,
						username: cleanEmail,
					},
				};
			}

			// Yandex Mail
			if (primaryMx.includes("yandex")) {
				return {
					success: true,
					source: "mx",
					domain,
					email: cleanEmail,
					imap: {
						host: "imap.yandex.com",
						port: 993,
						secure: true,
						username: cleanEmail,
					},
					smtp: {
						host: "smtp.yandex.com",
						port: 465,
						secure: true,
						username: cleanEmail,
					},
				};
			}

			// Namecheap Private Email
			if (primaryMx.includes("privateemail.com")) {
				return {
					success: true,
					source: "mx",
					domain,
					email: cleanEmail,
					imap: {
						host: "mail.privateemail.com",
						port: 993,
						secure: true,
						username: cleanEmail,
					},
					smtp: {
						host: "mail.privateemail.com",
						port: 587,
						secure: false,
						username: cleanEmail,
					},
				};
			}

			// Hostinger / Titan Mail
			if (
				primaryMx.includes("hostinger.com") ||
				primaryMx.includes("titan.email")
			) {
				return {
					success: true,
					source: "mx",
					domain,
					email: cleanEmail,
					imap: {
						host: "imap.hostinger.com",
						port: 993,
						secure: true,
						username: cleanEmail,
					},
					smtp: {
						host: "smtp.hostinger.com",
						port: 465,
						secure: true,
						username: cleanEmail,
					},
				};
			}

			// GoDaddy
			if (primaryMx.includes("secureserver.net")) {
				return {
					success: true,
					source: "mx",
					domain,
					email: cleanEmail,
					imap: {
						host: "imap.secureserver.net",
						port: 993,
						secure: true,
						username: cleanEmail,
					},
					smtp: {
						host: "smtpout.secureserver.net",
						port: 465,
						secure: true,
						username: cleanEmail,
					},
				};
			}

			// OVH
			if (primaryMx.includes("ovh.net")) {
				return {
					success: true,
					source: "mx",
					domain,
					email: cleanEmail,
					imap: {
						host: "ssl0.ovh.net",
						port: 993,
						secure: true,
						username: cleanEmail,
					},
					smtp: {
						host: "ssl0.ovh.net",
						port: 465,
						secure: true,
						username: cleanEmail,
					},
				};
			}

			// Rackspace
			if (primaryMx.includes("emailsrvr.com")) {
				return {
					success: true,
					source: "mx",
					domain,
					email: cleanEmail,
					imap: {
						host: "secure.emailsrvr.com",
						port: 993,
						secure: true,
						username: cleanEmail,
					},
					smtp: {
						host: "secure.emailsrvr.com",
						port: 465,
						secure: true,
						username: cleanEmail,
					},
				};
			}
		}
	} catch {
		// continue to active DNS verification
	}

	// ── 7. Active DNS Hostname Verification ──
	const imapCandidates = [`imap.${domain}`, `mail.${domain}`];
	const smtpCandidates = [`smtp.${domain}`, `mail.${domain}`];

	if (primaryMx) {
		imapCandidates.push(primaryMx);
		smtpCandidates.push(primaryMx);
	}

	let verifiedImap = "";
	let verifiedSmtp = "";

	for (const candidate of imapCandidates) {
		if (await hostExists(candidate)) {
			verifiedImap = candidate;
			break;
		}
	}

	for (const candidate of smtpCandidates) {
		if (await hostExists(candidate)) {
			verifiedSmtp = candidate;
			break;
		}
	}

	if (verifiedImap && verifiedSmtp) {
		return {
			success: true,
			source: "heuristic",
			domain,
			email: cleanEmail,
			imap: {
				host: verifiedImap,
				port: 993,
				secure: true,
				username: cleanEmail,
			},
			smtp: {
				host: verifiedSmtp,
				port: 587,
				secure: false,
				username: cleanEmail,
			},
		};
	}

	// ── 8. No Configuration Found (Graceful Fallback) ──
	return {
		success: false,
		source: "heuristic",
		domain,
		email: cleanEmail,
		message: `No email server configuration could be automatically discovered for domain "${domain}"`,
	};
}
