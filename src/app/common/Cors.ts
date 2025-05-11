import cors, { type CorsOptions } from "cors";
export class Cors {

	/**
	 * Returns the options for the function.
	 *
	 * @return {CorsOptions} The options object containing the origin, optionsSuccessStatus, and credentials properties.
	 */
	static options(origin: string|string[]=["*"]): CorsOptions {
		return {
			origin,
			optionsSuccessStatus: 200,
			methods: ["GET", "POST", "PUT", "DELETE","PATCH"],
			 
			credentials: true,
		};
	}
}
