import { Router } from "express";

import ImapController from "@/handlers/controllers/imap.controller";
import { Validator } from "@/middlewares/validator.middleware";
import { validateMailboxOperation } from "@/utils/validators/Request.validator";

const router = Router();

router.post("/authenticate", ImapController.loginUser);
router.post("/validate", ImapController.validateNewUser);
router.get("/autodiscover", ImapController.autodiscover);
router.post("/autodiscover", ImapController.autodiscover);
router.get("/first-load", ImapController.onFirstLoad);
router.get("/relogin", ImapController.reLogin);
router.get("/user-profile", ImapController.userProfile);
router.post("/logout", ImapController.userLogout);
router.post("/test", ImapController.test);

router.get("/fetch-mailboxes", ImapController.loadMailboxes);
router.get("/fetch-emails", ImapController.loadEmails);
router.get("/fetch-email-body", ImapController.loadEmailBody);
router.get("/fetch-mailbox", ImapController.syncOnlySingleFolder);
router.get("/fetch-unseen", ImapController.loadUnseenEmails);

router.delete("/delete-email", ImapController.moveToTrash);

router.patch("/handle-flags", ImapController.handleFlagsOnMessages);
// router.delete('/delete-mailbox', ImapController.deleteMailbox)
// router.post('/create-mailbox', ImapController.createMailbox)
router.patch("/move-email", ImapController.moveToFolder);
router.patch("/copy-email", ImapController.copyToAnotherFolder);

router.patch(
	"/handle-mailbox-events",
	Validator.forFeature(validateMailboxOperation),
	ImapController.handleMailboxOperations,
);
router.get("/sync-all", ImapController.syncCompleteMailbox);

// ── New IMAP function endpoints ──
router.post("/search-emails", ImapController.searchEmails);
router.get("/fetch-headers", ImapController.fetchHeaders);
router.get("/download-attachment", ImapController.downloadAttachment);
router.get("/mailbox-tree", ImapController.mailboxTree);
router.post("/append-message", ImapController.appendMessage);
router.patch("/custom-flags", ImapController.handleCustomFlags);
router.get("/connection-status", ImapController.connectionStatus);

// ── Background Job endpoints ──
router.post("/dispatch-job", ImapController.dispatchJob);
router.get("/job-status", ImapController.getJobStatus);
router.get("/job-list", ImapController.listJobs);

// ── Capability Endpoints ──
router.get("/server-capabilities", ImapController.getServerCapabilities);
router.post("/check-capability", ImapController.checkCapability);
router.post("/refresh-capabilities", ImapController.refreshCapabilities);

// ── RESTful Aliases & Modern Spec Endpoints ──
router.get("/me", ImapController.userProfile);
router.get("/accounts", ImapController.listAccounts);
router.get("/mailboxes", ImapController.loadMailboxes);
router.get("/folders", ImapController.loadMailboxes);
router.post("/folders/:id/empty", ImapController.emptyFolder);
router.get("/emails", ImapController.loadEmails);
router.get("/emails/:uid/body", ImapController.loadEmailBody);
router.delete("/emails", ImapController.moveToTrash);
router.delete("/emails/:uid", ImapController.moveToTrash);
router.post("/send-email", ImapController.sendEmail);
router.get("/quota", ImapController.getQuota);
router.get("/stream", ImapController.streamEvents);

export default router;
