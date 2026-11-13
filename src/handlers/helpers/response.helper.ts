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
	res
		.status(statusCode)
		.json({
			message,
			result,
			...extra,
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
