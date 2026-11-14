import { ImapFactory } from "../factory/ImapFactory";
import type { ImapService } from "../services/ImapService";
import imapBaseService from "../services/imapBaseService";

export type UserIdentifier =
	| string
	| number
	| { email?: string; mid?: number | string; uid?: string };

/**
 * Retrieves an active, authenticated ImapService for the given user email or mid.
 * Automatically recovers connection from database credentials if the in-memory
 * connection timed out or the server was restarted, avoiding "Can not re-use ImapFlow instance".
 */
export async function getAuthenticatedImapService(
	userParam?: UserIdentifier,
	midParam?: number | string,
): Promise<ImapService> {
	let userEmail: string | undefined;
	let mid: number | string | undefined = midParam;

	if (typeof userParam === "object" && userParam !== null) {
		userEmail = userParam.email;
		mid = userParam.mid ?? userParam.uid ?? midParam;
	} else if (typeof userParam === "number") {
		mid = userParam;
	} else if (typeof userParam === "string") {
		if (/^\d+$/.test(userParam)) {
			mid = Number(userParam);
		} else {
			userEmail = userParam;
		}
	}

	if (!userEmail && !mid) {
		throw new Error("Login required");
	}

	// 1. Try in-memory instance by mid or email
	let service: ImapService | undefined;
	if (mid) {
		service = ImapFactory.getInstance(mid);
	}
	if (!service && userEmail) {
		service = ImapFactory.getInstance(userEmail);
	}

	// 2. If live and authenticated, reuse immediately without reconnecting
	if (service && service.isConnected()) {
		service.touch();
		return service;
	}

	// 3. Connection absent or disconnected: recover from DB credentials
	let dbUser = null;
	if (mid) {
		dbUser = await imapBaseService.getUserById(mid);
	}
	if (!dbUser && userEmail) {
		dbUser = await imapBaseService.getUserEmail(userEmail);
	}

	if (!dbUser) {
		throw new Error("Login required");
	}

	const resolvedEmail = dbUser.imap_username;
	const resolvedMid = dbUser.id;
	const config = imapBaseService.configDTO(dbUser);

	service = ImapFactory.getOrCreate(resolvedEmail, config, resolvedMid);

	if (!service.isConnected()) {
		await service.authenticate();
	}

	return service;
}
