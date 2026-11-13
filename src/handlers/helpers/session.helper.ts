import { ImapFactory } from "../factory/ImapFactory";
import type { ImapService } from "../services/ImapService";
import imapBaseService from "../services/imapBaseService";

/**
 * Retrieves an active, authenticated ImapService for the given user email.
 * Automatically recovers connection from database credentials if the in-memory
 * connection timed out or the server was restarted.
 */
export async function getAuthenticatedImapService(
	userEmail?: string,
): Promise<ImapService> {
	if (!userEmail) {
		throw new Error("Login required");
	}

	let service = ImapFactory.getInstance(userEmail);
	if (service && service.getConnection().authenticated) {
		return service;
	}

	// Connection absent or unauthenticated: recover from DB credentials
	const dbUser = await imapBaseService.getUserEmail(userEmail);
	if (!dbUser) {
		throw new Error("Login required");
	}

	const config = imapBaseService.configDTO(dbUser);
	service = ImapFactory.getOrCreate(userEmail, config);

	if (!service.getConnection().authenticated) {
		await service.authenticate();
	}

	return service;
}
