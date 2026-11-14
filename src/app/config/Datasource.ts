import { DataSource } from "typeorm";
import { PostgresQueryRunner } from "typeorm/driver/postgres/PostgresQueryRunner";
import { __CONFIG__ } from ".";
import {
	AutomaticReplyEntity,
	ImapUsersEmailConnectionEntity,
	MailboxEntity,
	MailboxQuotaEntity,
} from "@/factory/entities";

// Patch TypeORM PostgresQueryRunner to sequence concurrent queries on the same connection,
// resolving pg@8.14+ / pg@9 DeprecationWarning: "Calling client.query() when the client is already executing a query"
interface QueryRunnerWithQueue extends PostgresQueryRunner {
	_queryQueue?: Promise<unknown>;
}

const originalPostgresQuery = PostgresQueryRunner.prototype.query;
PostgresQueryRunner.prototype.query = function (
	this: QueryRunnerWithQueue,
	...args: Parameters<typeof originalPostgresQuery>
) {
	const next = (this._queryQueue || Promise.resolve())
		.catch(() => {})
		.then(() => Reflect.apply(originalPostgresQuery, this, args));
	this._queryQueue = next;
	return next as ReturnType<typeof originalPostgresQuery>;
};

const DB_OPTIONS = {
	host: __CONFIG__.DATABASE.DB_HOST || "localhost",
	port: +__CONFIG__.DATABASE.DB_PORT,
	username: __CONFIG__.DATABASE.DB_USER,
	password: __CONFIG__.DATABASE.DB_PASS,
	database: __CONFIG__.DATABASE.DB_NAME,
};
const DB = __CONFIG__.DATABASE.DATABASE_URL
	? { url: __CONFIG__.DATABASE.DATABASE_URL }
	: DB_OPTIONS;

const isLocalDb =
	DB_OPTIONS.host === "localhost" || DB_OPTIONS.host === "127.0.0.1";

export const AppDataSource = new DataSource({
	...DB,
	type: "postgres",
	synchronize: __CONFIG__.APP.APP_ENV === "DEV",
	logging: false,
	entities: [
		AutomaticReplyEntity,
		ImapUsersEmailConnectionEntity,
		MailboxEntity,
		MailboxQuotaEntity,
		"build/factory/entities/**/*.entity.js",
	],
	subscribers: [],
	migrationsRun: __CONFIG__.APP.APP_ENV === "DEV",
	migrations: ["build/factory/migrations/**/*.js"],
	migrationsTableName: "migration_table",
	ssl: false,
	extra: isLocalDb
		? {}
		: {
				ssl: {
					rejectUnauthorized: false,
				},
			},
});
