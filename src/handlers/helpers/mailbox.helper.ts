import type { IUser } from "@/utils/interfaces/user.interface";
import type { Request } from "express";
import type { ImapService } from "../services/ImapService";
import { mailboxStorageService } from "../services/MailboxStorageService";
import {
	type MutationChange,
	type MutationResult,
	messageMutationService,
} from "../services/MessageMutationService";
import { parseUids } from "./email.helper";
import {
	type ResolvedMailbox,
	pickMailbox,
	readText,
} from "./mailbox.resolver";
import { getAuthenticatedImapService } from "./session.helper";

export interface RequestIdentity {
	email: string;
	connectionId: number;
}

export interface MessageScope extends RequestIdentity {
	imap: ImapService;
	mailbox: ResolvedMailbox;
	uids: number[];
}

interface MessageRequestBody {
	uids?: unknown;
	uid?: unknown;
	folder?: unknown;
	current?: unknown;
}

export async function resolveMailbox(
	connectionId: number,
	requested: unknown,
): Promise<ResolvedMailbox> {
	const mailboxes = await mailboxStorageService.getMailboxes(connectionId);
	return pickMailbox(readText(requested), mailboxes);
}

export async function resolveTarget(
	connectionId: number,
	requested: unknown,
): Promise<ResolvedMailbox> {
	if (!readText(requested)) {
		throw new Error("target mailbox is required");
	}
	return resolveMailbox(connectionId, requested);
}

export function requireFolderParam(req: Request): string {
	const folder = readText(readFolderParam(req));
	if (!folder) {
		throw new Error("Folder is required");
	}
	return folder;
}

export function settleMutation(
	scope: Pick<MessageScope, "imap" | "email" | "connectionId">,
	change: MutationChange,
): Promise<MutationResult> {
	return messageMutationService.settle(
		{
			imap: scope.imap,
			userEmail: scope.email,
			connectionId: scope.connectionId,
		},
		change,
	);
}

export function requireIdentity(req: Request): RequestIdentity {
	const user = req.user as (IUser & { mid?: number | string }) | undefined;
	const connectionId = Number(user?.uid ?? user?.mid);
	if (!user?.email || !Number.isInteger(connectionId) || connectionId <= 0) {
		throw new Error("Login required");
	}
	return { email: user.email, connectionId };
}

export function readFolderParam(req: Request): unknown {
	const body = (req.body ?? {}) as MessageRequestBody;
	return (
		req.params?.id ??
		req.query?.folder ??
		req.query?.folderId ??
		body.folder ??
		body.current
	);
}

export function readUidsParam(req: Request): number[] {
	const body = (req.body ?? {}) as MessageRequestBody;
	return parseUids(
		body.uids ??
			body.uid ??
			req.query?.uids ??
			req.query?.uid ??
			req.params?.uid,
	);
}

export async function resolveMessageScope(
	req: Request,
	options: { requireUids?: boolean } = {},
): Promise<MessageScope> {
	const identity = requireIdentity(req);
	const uids = readUidsParam(req);
	if (options.requireUids !== false && uids.length === 0) {
		throw new Error("uids array is required");
	}
	const [imap, mailbox] = await Promise.all([
		getAuthenticatedImapService(identity.email, identity.connectionId),
		resolveMailbox(identity.connectionId, readFolderParam(req)),
	]);
	return { ...identity, imap, mailbox, uids };
}
