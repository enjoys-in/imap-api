const APP_ENV = process.env.APP_ENV || "DEV";
const APP_PORT = Number(process.env.APP_PORT) || 7654;
const APP_DOMAIN = process.env.APP_DOMAIN || "localhost";
const __config = {
	APP: {
		APP_PORT,
		APP_ENV,
		API_VERSION: process.env.API_VERSION || "v1",
		APP_DOMAIN,
		APP_URL:
			APP_ENV === "DEV"
				? `http://localhost:${APP_PORT}`
				: `https://imap-api.${APP_DOMAIN}`,
		API_KEY: process.env.API_KEY || "",
		ALLOWED_PRIMARY_DOMAINS: process.env.ALLOWED_PRIMARY_DOMAINS || "",
		MAIL_TEMPLATE_PATH: process.env.MAIL_TEMPLATE_PATH || "",
	},
	SECRETS: {
		SALT: process.env.SALT || "",
		JWT_SECRET_TOKEN: process.env.JWT_SECRET_TOKEN || "default_jwt_secret",
		APP_SECRET: process.env.APP_SECRET || "",
		COOKIE_SECRET: process.env.COOKIE_SECRET || "",
		SESSION_SECRET: process.env.SESSION_SECRET || "",
	},
	DATABASE: {
		DB_DIALECT: process.env.DB_DIALECT || "postgres",
		DATABASE_URL: process.env.DATABASE_URL || "",
		DB_NAME: process.env.DB_NAME || "",
		DB_HOST: process.env.DB_HOST || "",
		DB_USER: process.env.DB_USER || "",
		DB_PASS: process.env.DB_PASS || "",
		DB_PORT: Number(process.env.DB_PORT) || 5432,
	},
	SMTP_SETTINGS: {
		SMTP_HOST: process.env.SMTP_HOST || "",
		SMTP_TYPE: process.env.SMTP_TYPE || "SSL",
		SMTP_HOST_PORT: Number(process.env.SMTP_HOST_PORT) || 465,
		SMTP_HOST_USER: process.env.SMTP_HOST_USER || "",
		SMTP_HOST_PASS: process.env.SMTP_HOST_PASS || "",
		SMTP_SENDER_NAME: process.env.SMTP_SENDER_NAME || "",
	},
	CACHE: {
		CACHE_HOST: process.env.CACHE_HOST || "",
		CACHE_PORT: Number(process.env.CACHE_PORT) || 6379,
	},
};
export const ConfigService = {
	/**
	 * A function that retrieves a value from the config based on the provided key.
	 *
	 * @param {keyof typeof __config} key - the key of the config to retrieve the value from
	 * @return {typeof __config[key]} the value associated with the key in the config
	 */
	get: (key: keyof typeof __config) => {
		const value = __config[key];
		if (!value) {
			throw new Error(`Missing config: ${key}`);
		}
		return value as (typeof __config)[typeof key];
	},
};

export const __CONFIG__ = Object.freeze(__config);
