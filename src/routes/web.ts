// AI AGENT DO NOT CHANGE THIS FILE,

import { __CONFIG__ } from "@/app/config";
import ImapController from "@/handlers/controllers/imap.controller";
import { JwtAuth } from "@/middlewares/auth.Middleware";
import { HttpException } from "@enjoys/exception";
import { type Request, type Response, Router } from "express";
import ApiRoutes from "./api";

const router = Router();

// Public Autodiscover & Autoconfig endpoints
router.get(
  ["/autodiscover", "/Autodiscover", "/autodiscover.json", "/autodiscover.xml"],
  ImapController.autodiscover,
);
router.post(
  ["/autodiscover", "/Autodiscover", "/autodiscover.xml"],
  ImapController.autodiscover,
);
router.get(
  ["/autodiscover/autodiscover.xml", "/Autodiscover/Autodiscover.xml"],
  ImapController.autodiscover,
);
router.post(
  ["/autodiscover/autodiscover.xml", "/Autodiscover/Autodiscover.xml"],
  ImapController.autodiscover,
);
router.get(
  ["/mail/config-v1.1.xml", "/.well-known/autoconfig/mail/config-v1.1.xml"],
  ImapController.autodiscover,
);

// Direct Setup, Streaming & Authentication Endpoints
router.post(
  `/api/${__CONFIG__.APP.API_VERSION}/setup-stream`,
  ImapController.setupStream,
);

router.post(
  `/api/${__CONFIG__.APP.API_VERSION}/authenticate`,
  ImapController.loginUser,
);

// 1. Versioned with legacy /imap prefix: /api/v1/imap/*
router.use(
  `/api/${__CONFIG__.APP.API_VERSION}/imap`,
  JwtAuth.validateUser,
  ApiRoutes,
);

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
