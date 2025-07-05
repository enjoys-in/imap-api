import { Router } from "express";


import { Validator } from "@/middlewares/validator.middleware";
import ImapController from "@/handlers/controllers/imap.controller";
import { validateMailboxOperation } from "@/utils/validators/Request.validator";

const router = Router();

router.post("/authenticate",ImapController.loginUser);
router.post("/validate", ImapController.validateNewUser);
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
router.patch('/move-email', ImapController.moveToFolder)
router.patch('/copy-email', ImapController.copyToAnotherFolder)


router.patch(
    "/handle-mailbox-events",
    Validator.forFeature(validateMailboxOperation),
    ImapController.handleMailboxOperations
);
router.get("/sync-all", ImapController.syncCompleteMailbox);

export default router;
