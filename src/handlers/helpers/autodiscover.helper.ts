import { promises as dns } from "node:dns";
import { Logging } from "@/logs";

export interface AutodiscoverResult {
	success: boolean;
	source: "preset" | "thunderbird" | "outlook" | "mx" | "heuristic";
	domain: string;
	email: string;
	displayName?: string;
	imap: {
		host: string;
		port: number;
		secure: boolean;
		username: string;
	};
	smtp: {
		host: string;
		port: number;
		secure: boolean;
		username: string;
	};
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
	"fastmail.com": {
		imapHost: "imap.fastmail.com",
		imapPort: 993,
		imapSecure: true,
		smtpHost: "smtp.fastmail.com",
		smtpPort: 587,
		smtpSecure: false,
	},
};

/**
 * Parses Mozilla Thunderbird autoconfig XML (config-v1.1.xml)
 */
function parseThunderbirdXml(
	xml: string,
	email: string,
	domain: string,
): AutodiscoverResult | null {
	try {
		// Extract incoming IMAP server
		const imapMatch = xml.match(
			/<incomingServer[^>]*type=["']imap["'][^>]*>([\s\S]*?)<\/incomingServer>/i,
		);
		// Extract outgoing SMTP server
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

		const displayName = xml.match(
			/<displayName>([^<]+)<\/displayName>/i,
		)?.[1];

		return {
			success: true,
			source: "thunderbird",
			domain,
			email,
			displayName,
			imap: {
				host: imapHost,
				port: imapPort,
				secure: imapSecure,
				username: email,
			},
			smtp: {
				host: smtpHost,
				port: smtpPort,
				secure: smtpSecure,
				username: email,
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

		let imapHost = `imap.${domain}`;
		let imapPort = 993;
		let imapSecure = true;

		let smtpHost = `smtp.${domain}`;
		let smtpPort = 587;
		let smtpSecure = false;

		for (const proto of protocols) {
			const type = proto
				.match(/<Type>([^<]+)<\/Type>/i)?.[1]
				?.toUpperCase()
				?.trim();
			const server = proto.match(/<Server>([^<]+)<\/Server>/i)?.[1]?.trim();
			const port = Number(proto.match(/<Port>([^<]+)<\/Port>/i)?.[1]?.trim());
			const ssl = proto
				.match(/<SSL>([^<]+)<\/SSL>/i)?.[1]
				?.toLowerCase()
				?.trim();
			const isSsl = ssl === "on" || ssl === "yes" || ssl === "1";

			if (type === "IMAP" && server) {
				imapHost = server;
				imapPort = port || 993;
				imapSecure = isSsl || imapPort === 993;
			} else if (type === "SMTP" && server) {
				smtpHost = server;
				smtpPort = port || 587;
				smtpSecure = isSsl || smtpPort === 465;
			}
		}

		return {
			success: true,
			source: "outlook",
			domain,
			email,
			imap: {
				host: imapHost,
				port: imapPort,
				secure: imapSecure,
				username: email,
			},
			smtp: {
				host: smtpHost,
				port: smtpPort,
				secure: smtpSecure,
				username: email,
			},
		};
	} catch (e) {
		Logging.dev(`Failed to parse Outlook XML: ${e}`);
		return null;
	}
}

/**
 * Discovers IMAP and SMTP server configuration using:
 * 1. Known Presets
 * 2. Thunderbird XML Autoconfig
 * 3. Outlook XML Autodiscover
 * 4. DNS MX record inspection
 * 5. Intelligent heuristics
 */
export async function autodiscoverConfig(
	email: string,
): Promise<AutodiscoverResult> {
	const cleanEmail = email.trim();
	const domain = cleanEmail.includes("@")
		? cleanEmail.split("@")[1]?.toLowerCase().trim()
		: "";

	if (!domain) {
		throw new Error("Invalid email address");
	}

	// 1. Check known presets
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

	// 2. Query Thunderbird Autoconfig XML
	const thunderbirdUrls = [
		`https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(cleanEmail)}`,
		`http://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(cleanEmail)}`,
		`https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`,
	];

	for (const url of thunderbirdUrls) {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 2500);
			const res = await fetch(url, { signal: controller.signal });
			clearTimeout(timeout);

			if (res.ok) {
				const text = await res.text();
				const result = parseThunderbirdXml(text, cleanEmail, domain);
				if (result) return result;
			}
		} catch {
			// continue to next discovery method
		}
	}

	// 3. Query Microsoft Outlook Autodiscover XML
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
			const timeout = setTimeout(() => controller.abort(), 2500);
			const res = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "text/xml; charset=utf-8",
				},
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

	// 4. DNS MX record inspection
	try {
		const mxRecords = await dns.resolveMx(domain);
		if (mxRecords && mxRecords.length > 0) {
			mxRecords.sort((a, b) => a.priority - b.priority);
			const primaryMx = mxRecords[0].exchange.toLowerCase();

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

			if (
				primaryMx.includes("outlook") ||
				primaryMx.includes("protection.outlook")
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

			if (primaryMx.includes("zoho")) {
				return {
					success: true,
					source: "mx",
					domain,
					email: cleanEmail,
					imap: {
						host: "imap.zoho.com",
						port: 993,
						secure: true,
						username: cleanEmail,
					},
					smtp: {
						host: "smtp.zoho.com",
						port: 587,
						secure: false,
						username: cleanEmail,
					},
				};
			}
		}
	} catch {
		// continue to heuristic fallback
	}

	// 5. Intelligent heuristics
	return {
		success: true,
		source: "heuristic",
		domain,
		email: cleanEmail,
		imap: {
			host: `mail.${domain}`,
			port: 993,
			secure: true,
			username: cleanEmail,
		},
		smtp: {
			host: `mail.${domain}`,
			port: 587,
			secure: false,
			username: cleanEmail,
		},
	};
}
