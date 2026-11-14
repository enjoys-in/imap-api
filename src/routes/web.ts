import { __CONFIG__ } from "@/app/config";
import ImapController from "@/handlers/controllers/imap.controller";
import { JwtAuth } from "@/middlewares/auth.Middleware";
import { HttpException } from "@enjoys/exception";
import { type Request, type Response, Router } from "express";
import ApiRoutes from "./api";

const router = Router();

// Public Autodiscover & Autoconfig endpoints
for (const path of [
	"/autodiscover",
	"/Autodiscover",
	"/autodiscover.json",
	"/autodiscover.xml",
	"/autodiscover/autodiscover.xml",
	"/Autodiscover/Autodiscover.xml",
]) {
	(router as any).get(path, ImapController.autodiscover);
	(router as any).post(path, ImapController.autodiscover);
}

for (const path of [
	"/mail/config-v1.1.xml",
	"/.well-known/autoconfig/mail/config-v1.1.xml",
]) {
	(router as any).get(path, ImapController.autodiscover);
}

// Direct Root Setup & Authentication Aliases (resilience for root callers)
router.post("/setup-stream", ImapController.setupStream);
router.post("/authenticate", ImapController.loginUser);

// 1. Versioned with legacy /imap prefix: /api/v1/imap/*
router.use(
	`/api/${__CONFIG__.APP.API_VERSION}/imap`,
	JwtAuth.validateUser,
	ApiRoutes,
);

// 2. Standard versioned API: /api/v1/*
router.use(
	`/api/${__CONFIG__.APP.API_VERSION}`,
	JwtAuth.validateUser,
	ApiRoutes,
);

// 3. Fallback unversioned API: /api/*
router.use("/api", JwtAuth.validateUser, ApiRoutes);

router.use("*", (req: Request, res: Response) => {
	throw new HttpException({
		name: "NOT_FOUND",
		message: "Route Not Found",
		stack: {
			info: "Forbidden Resource",
			path: req.baseUrl,
			method: req.method,
		},
	});
});

export default router;
