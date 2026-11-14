export interface ImapConfig {
	imap_host: string;
	imap_port: number;
	imap_secure: boolean;
	imap_username: string;
	imap_password: string;
}
export interface SmtpConfig {
	smtp_host: string;
	smtp_port: number;
	smtp_secure: boolean;
}
export interface SharedCredentials {
	uses_same_credentials: true;
	smtp_username?: string; // Will reuse IMAP creds if not provided
	smtp_password?: string;
}

export interface SeparateCredentials {
	uses_same_credentials: false;
	smtp_username: string;
	smtp_password: string;
}
export type ImapRequestBody = ImapConfig &
	SmtpConfig &
	(SharedCredentials | SeparateCredentials) & {
		display_name?: string;
	};
