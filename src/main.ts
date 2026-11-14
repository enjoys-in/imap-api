import "dotenv/config";
import "reflect-metadata";
import { register } from "tsconfig-paths";
import tsConfig from "../tsconfig.json";
register({ baseUrl: __dirname, paths: tsConfig.compilerOptions.paths });

// Filter out upstream pg/TypeORM concurrent query deprecation warning
process.on("warning", (warning) => {
	if (
		warning.name === "DeprecationWarning" &&
		warning.message.includes("Calling client.query()")
	) {
		return;
	}
	console.warn(warning.name, warning.message);
});

import { bootstrap } from "./application";
function main() {
	bootstrap.AppServer.InitializeApplication();
}

main();
