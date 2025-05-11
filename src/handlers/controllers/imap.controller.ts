import type { Request, Response } from "express";
import { ImapFactory } from "../factory/ImapFactory";



import { StalwartService } from "../services/starlwartService";
import imapBaseService from "../services/imapBaseService";



import { InjectRepository } from "@/factory/typeorm";
import { Cache } from "@/utils/services/redis/cacheService";
import { ImapUsersEmailConnectionEntity } from "@/factory/entities/imap.entity";
import { Security } from "@/utils/helpers/security";
import utils from "@/utils";
import { __CONFIG__ } from "@/app/config";
import { MiscellaneousHelper } from "@/utils/helpers/misc";
import { REDIS_KEY_NAME } from "@/utils/interfaces/redisName.interface";
import { ImapRequestBody } from "@/utils/interfaces/imap.interface";


// import { AuthService } from "@/handlers/services/AuthService";


// import { ResponseDto } from "@/handlers/dto/response.dto";

const imapUser = InjectRepository(ImapUsersEmailConnectionEntity);
const securityService = new Security();


class ImapController {
    /**
     * Logs in user and check if the user is already present in database, if not
     * then it creates a new entry in the database and updates the first time setup status
     * @param req - Request object
     * @param res - Response object
     * @returns Response object
     */
    // @PublicRoute()
    async loginUser(req: Request<{}, {}, Pick<ImapRequestBody, "imap_username" | "imap_password">>, res: Response) {
        try {
            // check user domain is hosted on our server if yes then dont use imap use direct api calls
            const domain = MiscellaneousHelper.getOnlyDomainFromEmail(req.body.imap_username);

            if ((await Cache.cache.sIsMember(REDIS_KEY_NAME.ALL_DOMAINS, domain))) {
                throw new Error("This Domain is not configured to use IMAP. Please Contact Admin");
            }
            const isUser = await imapBaseService.getUserEmail(req.body.imap_username);
            if (!isUser) {
                res.status(200)
                    .json({ message: "Not Authencticated", result: req.body, success: false })
                    .end();
                return;
            }

            const config = imapBaseService.configDTO(isUser) as ImapRequestBody
            // decrypt password
            config.imap_password = securityService.EncryptDecryptData(config.imap_password, __CONFIG__.SECRETS.APP_SECRET).DecryptFromString();
            config.smtp_password = securityService.EncryptDecryptData(config.smtp_password, __CONFIG__.SECRETS.APP_SECRET).DecryptFromString();
            const userMailboxes = await imapBaseService.setupUser(config);
            // const tokenBody = AuthService.createJwtPayLoad(isUser.id, req.body.imap_username, MiscellaneousHelper.getOnlyDomainFromEmail(req.body.imap_username), req.body.imap_username, req.body.imap_username.split("@")[0], AppRoles.USER)

            // const signJWT = utils.signJWT(tokenBody, isUser.id)
            // res.cookie("access_token", signJWT, { httpOnly: true, secure: __CONFIG__.APP.APP_ENV === "PROD", sameSite: "none", maxAge: 30 * 60 })

            res
                .json({ message: "Authencticated", result: userMailboxes, success: true })
                .end();
            return;
        } catch (error) {
            if (error instanceof Error) {
                res
                    .json({ message: error.message, result: null, success: false })
                    .end();

                return;
            }
            res
                .json({ message: "Something went wrong", result: null, success: false })
                .end();
            return;
        }

    }
    // @PublicRoute()
    async validateNewUser(req: Request<{}, {}, ImapRequestBody>, res: Response) {
        try {

            const isUser = await imapBaseService.getUserEmail(req.body.imap_username);
            if (isUser) {
                res.status(200)
                    .json({ message: "Invalid Operation , Please Do Login", result: null, success: false })
                    .end();
                return;
            }

            const user = req.body.uses_same_credentials
                ? req.body.imap_username
                : req.body.smtp_username;
            const pass = req.body.uses_same_credentials
                ? req.body.imap_password
                : req.body.smtp_password;
            const config: ImapRequestBody = {
                ...req.body,
                smtp_password: pass,
                smtp_username: user
            }

            config.imap_password = securityService.EncryptDecryptData(config.imap_password, __CONFIG__.SECRETS.APP_SECRET).DecryptFromString();
            config.smtp_password = securityService.EncryptDecryptData(config.smtp_password, __CONFIG__.SECRETS.APP_SECRET).DecryptFromString();

            const userMailboxes = await imapBaseService.setupUser(config);
            const createdUser = await imapBaseService.insertIntoDb(config);
            // const tokenBody = AuthService.createJwtPayLoad(createdUser.id, req.body.imap_username, MiscellaneousHelper.getOnlyDomainFromEmail(req.body.imap_username), req.body.imap_username, req.body.imap_username.split("@")[0], AppRoles.USER)
            // const signJWT = utils.signJWT(tokenBody, createdUser.id, "6m")
            // res.cookie("access_token", signJWT, { httpOnly: true, secure: __CONFIG__.APP.APP_ENV === "PROD", sameSite: "none", maxAge: 30 * 60 })
            res
                .json({ message: "Authencticated", result: userMailboxes, success: true })
                .end();
            return;
        } catch (error) {
            if (error instanceof Error) {
                res
                    .json({ message: error.message, result: null, success: false })
                    .end();

                return;
            }
            res
                .json({ message: "Something went wrong", result: null, success: false })
                .end();
            return;
        }

    }

    /**
     * Logs in the user using the provided imap_username and imap_password.
     * If the user is already logged in, it will relogin the user.
     * @param req - Request object
     * @param res - Response object
     * @returns Response object
     */
    async reLogin(req: Request, res: Response) {
        try {
            const isUser = await imapBaseService.getUserEmail(req.user?.email as string);

            const config = imapBaseService.configDTO(isUser)
            ImapFactory.getOrCreate(req.user?.email as string, config)

            res.json({ message: "OK", result: null, success: true }).end();
            return;
        } catch (error) {
            if (error instanceof Error) {
                res
                    .json({ message: error.message, result: null, success: false })
                    .end();

                return;
            }
            res
                .json({ message: "Something went wrong", result: null, success: false })
                .end();
            return;
        }
    }
    /**
     * Retrieves the envelope of the first unseen email in the given mailbox.
     * Used for rendering the first email in the mailbox when the user first logs in.
     * @param req - Request object
     * @param res - Response object
     * @returns Response object
     */
    async onFirstLoad(req: Request, res: Response) {
        try {
            const isUser = await imapBaseService.getUserEmail(req.user?.email as string);


            const config = imapBaseService.configDTO(isUser)
            const envelope = await ImapFactory.firstTimeSetup(config);

            res.json({ message: "OK", result: envelope, success: true }).end();
            return;
        } catch (error) {
            if (error instanceof Error) {
                res
                    .json({ message: error.message, result: null, success: false })
                    .end();

                return;
            }
            res
                .json({ message: "Something went wrong", result: null, success: false })
                .end();
            return;
        }
    }
    /**
     * Retrieves all mailboxes from the IMAP server
     * @param req - Request object
     * @param res - Response object
     * @returns Response object
     */
    async loadMailboxes(req: Request, res: Response) {
        try {
            const imapService = ImapFactory.getInstance(req.user?.email as string);
            if (!imapService) {
                throw new Error("Login required");
            }

            const mailboxes = await imapService.syncFolders();
            res.json({ message: "OK", result: mailboxes, success: true }).end();
            return;
        } catch (error) {
            if (error instanceof Error) {
                res
                    .json({ message: error.message, result: null, success: false })
                    .end();

                return;
            }
            res
                .json({ message: "Something went wrong", result: null, success: false })
                .end();
            return;
        }
    }
    /**
     * Retrieves emails from the IMAP server, given the selected mailbox and page information
     * @param req - Request object
     * @param res - Response object
     * @returns Response object
     */
    async loadEmails(
        req: Request<
            {},
            {},
            {},
            { folder: string; page: number; limit: number }
        >,
        res: Response
    ) {
        try {
            const query = req.query;
            if (!query.page || !query.limit) {
                query.page = 1;
                query.limit = 50;
            }
            const offset = (query.page - 1 === 0 ? 1 : query.page - 1) * query.limit;
            const selectedMailbox = (req.query?.folder as string) || "INBOX";
            const imapService = ImapFactory.getInstance(req.user?.email as string);
            if (!imapService) {
                throw new Error("Login required");
            }
            const emails = await imapService.selectMailbox(decodeURIComponent(selectedMailbox), offset);
            const cleanObject = JSON.parse(
                JSON.stringify(emails, (_, value) =>
                    typeof value === "bigint" ? value.toString() : value
                )
            );

            res.json({ message: "OK", result: cleanObject, success: true }).end();
            return;
        } catch (error) {
            console.log(error)
            if (error instanceof Error) {
                res
                    .json({ message: error.message, result: null, success: false })
                    .end();

                return;
            }
            res
                .json({ message: "Something went wrong", result: null, success: false })
                .end();
            return;
        }
    }
    /**
     * Retrieves the body of an email from the IMAP server, given the selected mailbox, uid and email body type
     * @param req - Request object
     * @param res - Response object
     * @returns Response object
     */
    async loadEmailBody(req: Request, res: Response) {
        try {
            const selectedMailbox = (req.query?.folder as string) || "INBOX";
            const uid = ((req.query?.uid as string))
            const imapService = ImapFactory.getInstance(req.user?.email as string);
            if (!imapService) {
                throw new Error("Login required");
            }
            const emailBody = await imapService.fetchMessageBody(decodeURIComponent(selectedMailbox), uid);
            res.json({ message: "OK", result: "ResponseDto.createMailResponse(emailBody)", success: true }).end();
            return;
        } catch (error) {
            if (error instanceof Error) {
                res
                    .json({ message: error.message, result: null, success: false })
                    .end();

                return;
            }
            res
                .json({ message: "Something went wrong", result: null, success: false })
                .end();
            return;
        }
    }
    /**
     * Retrieves unseen emails from the IMAP server
     * @param req - Request object
     * @param res - Response object
     * @returns Response object
     */
    async loadUnseenEmails(req: Request, res: Response) {
        try {
            const imapService = ImapFactory.getInstance(req.user?.email as string);
            if (!imapService) {
                throw new Error("Login required");
            }
            const emails = await imapService.listUnseenOnly();
            res.json({ message: "OK", result: emails, success: true }).end();
            return;
        } catch (error) {
            if (error instanceof Error) {
                res
                    .json({ message: error.message, result: null, success: false })
                    .end();

                return;
            }
            res
                .json({ message: "Something went wrong", result: null, success: false })
                .end();
            return;
        }
    }
    /**
     * Syncs the mailbox for the current user
     * @param req - Request object
     * @param res - Response object
     * @returns Response object
     */
    async syncCompleteMailbox(req: Request, res: Response) {
        try {
            const imapService = ImapFactory.getInstance(req.user?.email as string);
            if (!imapService) {
                throw new Error("Login required");
            }
            const emails = await imapService.globalSync(req.user?.email as string);
            res.json({ message: "OK", result: emails, success: true }).end();
            return;
        } catch (error) {
            if (error instanceof Error) {
                res
                    .json({ message: error.message, result: null, success: false })
                    .end();

                return;
            }
            res
                .json({ message: "Something went wrong", result: null, success: false })
                .end();
            return;
        }
    }
    /**
     * Syncs only the folder list for the current user
     * @param req - Request object
     * @param res - Response object
     * @returns Response object
     */
    async syncOnlyEmails(req: Request, res: Response) {
        try {
            const imapService = ImapFactory.getInstance(req.user?.email as string);
            if (!imapService) {
                throw new Error("Login required");
            }
            const query = (req.query?.folder as string) || "INBOX";
            const emails = await imapService.syncEmailsInMailbox(decodeURIComponent(query));
            res.json({ message: "OK", result: emails, success: true }).end();
            return;
        } catch (error) {
            if (error instanceof Error) {
                res
                    .json({ message: error.message, result: null, success: false })
                    .end();

                return;
            }
            res
                .json({ message: "Something went wrong", result: null, success: false })
                .end();
            return;
        }
    }
    /**
     * Syncs only the folder list for the current user, without syncing the email bodies.
     * @param req - Request object
     * @param res - Response object
     * @returns Response object containing the list of synced folders or an error message.
     */
    async syncOnlySingleFolder(req: Request, res: Response) {
        try {
            const imapService = ImapFactory.getInstance(req.user?.email as string);
            if (!imapService) {
                throw new Error("Login required");
            }
            const folder = (req.query?.folder as string) || "INBOX";

            const result = await imapService.synceSingleFolder(decodeURIComponent(folder));

            res.json({ message: "OK", result, success: true }).end();
            return;
        } catch (error) {
            if (error instanceof Error) {
                res
                    .json({ message: error.message, result: null, success: false })
                    .end();

                return;
            }
            res
                .json({ message: "Something went wrong", result: null, success: false })
                .end();
            return;
        }
    }
    /**
     * Syncs emails from a specified folder in the user's mailbox.
     * If no folder is specified, defaults to the "INBOX".
     * @param req - Request object containing the user's email and optional folder query parameter.
     * @param res - Response object used to return the result of the email sync operation.
     * @returns Response object containing the list of synced emails or an error message.
     */

    async syncOnlyFolderEmails(req: Request, res: Response) {
        try {
            const imapService = ImapFactory.getInstance(req.user?.email as string);
            if (!imapService) {
                throw new Error("Login required");
            }
            const query = (req.query?.folder as string) || "INBOX";
            const emails = await imapService.syncEmailsInMailbox(decodeURIComponent(query));
            res.json({ message: "OK", result: emails, success: true }).end();
            return;
        } catch (error) {
            if (error instanceof Error) {
                res
                    .json({ message: error.message, result: null, success: false })
                    .end();
                return;
            }
            res
                .json({ message: "Something went wrong", result: null, success: false })
                .end();
            return;
        }
    }

    /**
     * Deletes emails from the IMAP server
     * @param req - Request object
     * @param res - Response object
     * @returns Response object
     * @example
     * POST /api/imap/move-to-trash
     * Body: {uids: [1, 2, 3]}
     *
     * POST /api/imap/move-to-trash?all=true&folder=INBOX
     */
    async moveToTrash(req: Request, res: Response) {
        try {
            const imapService = ImapFactory.getInstance(req.user?.email as string);
            if (!imapService) {
                throw new Error("Login required");
            }
            const uids = ((req.body?.uids as string[]) || [])
                .map((uid) => Number(uid))
                .filter((n) => !isNaN(n));
            if (req.query?.all === "true" && req.query?.folder) {
                await imapService.deleteAllMessages(req.query?.folder as string);
            } else {
                await imapService.deleteMessages(uids);
            }
            res.json({ message: "OK", result: [], success: true }).end();
            return;
        } catch (error) {
            if (error instanceof Error) {
                res
                    .json({ message: error.message, result: null, success: false })
                    .end();

                return;
            }
            res
                .json({ message: "Something went wrong", result: null, success: false })
                .end();
            return;
        }
    }

    /**
     * Handles marking messages as read or unread, or marking all messages in a folder as read or unread.
     * @param req - Request object containing the user's email, and optional uids, folder, and flag query parameters.
     * @param res - Response object used to return the result of the flag operation.
     * @returns Response object containing the result of the flag operation, or an error message.
     * @example
     * POST /api/imap/handle-flags
     * Body: {uids: [1, 2, 3], flag: "mark_as_read"}
     *
     * POST /api/imap/handle-flags?folder=INBOX&flag=mark_all_as_read
     */
    async handleFlagsOnMessages(req: Request, res: Response) {
        try {
            const imapService = ImapFactory.getInstance(req.user?.email as string);
            if (!imapService) {
                throw new Error("Login required");
            }
            const uids = ((req.body?.uids as string[]) || [])
                .map((uid) => Number(uid))
                .filter((n) => !isNaN(n));
            const folder = (req.query?.folder as string) || undefined;
            switch (req.query?.flag) {
                case "mark_as_read":
                    await imapService.markAsRead(uids);
                    break;
                case "mark_as_unread":
                    await imapService.markAsUnread(uids);
                    break;
                case "mark_all_as_read":
                    if (!folder) {
                        throw new Error("Folder is required");
                    }
                    await imapService.markAllAsRead(folder);
                    break;
                case "mark_all_as_unread":
                    if (!folder) {
                        throw new Error("Folder is required");
                    }
                    await imapService.markAllAsUnread(folder);
                    break;
                default:
                    throw new Error("Invalid Flag");
            }

            res.json({ message: "OK", result: [], success: true }).end();
            return;
        } catch (error) {
            if (error instanceof Error) {
                res
                    .json({ message: error.message, result: null, success: false })
                    .end();

                return;
            }
            res
                .json({ message: "Something went wrong", result: null, success: false })
                .end();
            return;
        }
    }
    /**
     * Moves emails from one folder to another on the IMAP server.
     * If 'move_all' query parameter is provided, all emails from the current folder are moved to the target folder.
     * Otherwise, only emails with specified UIDs are moved.
     *
     * @param req - Request object containing the current and target folder names, and optionally UIDs of emails to move.
     * @param res - Response object.
     * @returns Response object indicating success or failure of the operation.
     */
    async moveToFolder(req: Request, res: Response) {
        try {
            const imapService = ImapFactory.getInstance(req.user?.email as string);
            if (!imapService) {
                throw new Error("Login required");
            }
            const moveAll = (req.query?.move_all as string) || undefined;
            const body = req.body as {
                uid: string[] | undefined;
                current: string;
                target: string;
            };
            if (moveAll && !body.uid) {
                await imapService.moveAllMessages(body.current, body.target);
            } else {
                const uids = ((req.body?.uids as string[]) || [])
                    .map((uid) => Number(uid))
                    .filter((n) => !isNaN(n));
                await imapService.moveMessage(uids, body.current, body.target);
            }
            res.json({ message: "OK", result: [], success: true }).end();
            return;
        } catch (error) {
            if (error instanceof Error) {
                res
                    .json({ message: error.message, result: null, success: false })
                    .end();

                return;
            }
            res
                .json({ message: "Something went wrong", result: null, success: false })
                .end();
            return;
        }
    }
    async copyToAnotherFolder(req: Request, res: Response) {
        try {
            const imapService = ImapFactory.getInstance(req.user?.email as string);
            if (!imapService) {
                throw new Error("Login required");
            }
            const moveAll = (req.query?.copy_all as string) || undefined;
            const body = req.body as {
                uid: string[] | undefined;
                current: string;
                target: string;
            };
            if (moveAll && !body.uid) {
                await imapService.moveAllMessages(body.current, body.target);
            } else {
                const uids = ((req.body?.uids as string[]) || [])
                    .map((uid) => Number(uid))
                    .filter((n) => !isNaN(n));
                await imapService.moveMessage(uids, body.current, body.target);
            }
            res.json({ message: "OK", result: [], success: true }).end();
            return;
        } catch (error) {
            if (error instanceof Error) {
                res
                    .json({ message: error.message, result: null, success: false })
                    .end();

                return;
            }
            res
                .json({ message: "Something went wrong", result: null, success: false })
                .end();
            return;
        }
    }
    /**
     * Handles operations on mailboxes on the IMAP server.
     * Possible operations are:
     * - create: create a new mailbox
     * - rename: rename an existing mailbox
     * - delete: delete an existing mailbox
     * - subscribe: subscribe to a mailbox
     * - unsubscribe: unsubscribe from a mailbox
     * - status: retrieve the mailbox status (number of messages, recent, etc.)
     * - quota: retrieve the quota information for a mailbox
     * @param req - Request object containing the type of operation to be performed and the mailbox name.
     * @param res - Response object.
     * @returns Response object indicating success or failure of the operation.
     */
    async handleMailboxOperations(req: Request, res: Response) {
        try {
            const imapService = ImapFactory.getInstance(req.user?.email as string);
            if (!imapService) {
                throw new Error("Login required");
            }

            const type = req.query?.type as
                | "create"
                | "rename"
                | "delete"
                | "subscribe"
                | "unsubscribe"
                | "status"
                | "quota";
            const body = req.body as {
                mailbox: string;
                targetMailbox: string | undefined;
            };
            let result = null;
            switch (type) {

                case "create":
                    await imapService.createMailbox(body.mailbox);
                    break;
                case "rename":
                    if (!body.targetMailbox) {
                        throw new Error("Folder is required");
                    }
                    result = await imapService.renameMailbox(body.mailbox, body.targetMailbox);
                    break;
                case "delete":
                    result = await imapService.deleteMailbox(body.mailbox);
                    break;
                case "subscribe":
                    result = await imapService.subscribeMailbox(body.mailbox);
                    break;
                case "unsubscribe":
                    result = await imapService.unsubscribeMailbox(body.mailbox);
                    break;
                case "status":
                    result = await imapService.getMailboxStatus(body.mailbox);
                    break;
                case "quota":
                    result = await imapService.getQuota(body.mailbox);
                    break;
                default:
                    throw new Error("Invalid Flag");
            }

            res.json({ message: "OK", result, success: true }).end();
            return;
        } catch (error) {
            if (error instanceof Error) {
                res
                    .json({ message: error.message, result: null, success: false })
                    .end();

                return;
            }
            res
                .json({ message: "Something went wrong", result: null, success: false })
                .end();
            return;
        }
    }
    // @PublicRoute()
    async test(req: Request, res: Response) {
        try {
            // const imapService = new StalwartService("http://185.193.19.118:8080");
            // await imapService.auth()
            // await imapService.addDomain("airsend.in")
            // await imapService.handleUser("mullayam06@airsend.in")
            // const t = await imapService.getUserAccount()
            res
                .json({
                    message: "OK",
                    result: "Please Select any operation",
                    success: true,
                })
                .end();
            return;
        } catch (error) {
            if (error instanceof Error) {
                res
                    .json({ message: error.message, result: null, success: false })
                    .end();

                return;
            }
            res
                .json({ message: "Something went wrong", result: null, success: false })
                .end();
            return;
        }
    }
}

export default new ImapController();
