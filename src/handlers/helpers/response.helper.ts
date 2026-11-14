import type { Response } from "express";

/**
 * Sends a standardized success JSON response.
 */
export function sendSuccess(
	res: Response,
	result: any,
	message = "OK",
	extra: Record<string, any> = {},
	statusCode = 200,
): void {
	// Every non-stream route answers `{ message, result, success }` with `result: any`.
	// Extra fields (e.g. the session `user`/`token`) are merged INTO `result`, but only
	// when it is an object or empty. Arrays and primitives are passed through untouched:
	// spreading `[a, b]` would turn it into `{ "0": a, "1": b }`. In that case the
	// extras stay as top-level siblings, exactly as before.
	const hasExtra = Object.keys(extra).length > 0;
	const isPlainObject =
		result !== null && typeof result === "object" && !Array.isArray(result);
	const mergeIntoResult = hasExtra && (isPlainObject || result == null);

	res
		.status(statusCode)
		.json({
			message,
			result: mergeIntoResult ? { ...result, ...extra } : result,
			...(hasExtra && !mergeIntoResult ? extra : {}),
			success: true,
		})
		.end();
}

/**
 * Sends a standardized error JSON response.
 */
export function sendError(
	res: Response,
	error: unknown,
	defaultMessage = "Something went wrong",
	statusCode = 200,
): void {
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: defaultMessage;

	res
		.status(statusCode)
		.json({
			message,
			result: null,
			success: false,
		})
		.end();
}

/**
 * Sends an HTTP 202 Accepted response for background jobs.
 */
export function sendAccepted(
	res: Response,
	message: string,
	result: any,
): void {
	res
		.status(202)
		.json({
			message,
			result,
			success: true,
		})
		.end();
}
