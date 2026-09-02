import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import path from "path";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

/**
 * CORS allowlist.
 * On SAP BTP: set via `cf set-env returnpath-ai ALLOWED_ORIGINS https://your-app.cfapps.ap21.hana.ondemand.com`
 * Multiple origins: comma-separated  →  "https://a.com,https://b.com"
 * Local dev default: localhost ports 5000 and 5173 (Vite)
 */
const allowedOrigins: Set<string> = new Set(
  (process.env.ALLOWED_ORIGINS ?? "http://localhost:5000,http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
);

app.use(
  cors({
    credentials: true,
    origin: (origin, callback) => {
      // Allow requests with no origin (server-to-server, curl, mobile)
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) return callback(null, true);
      callback(new Error(`CORS: origin '${origin}' is not allowed.`));
    },
  })
);
// Resume uploads are sent as JSON with an optional base64 payload. Keep the
// limit large enough for normal PDF/DOCX files without accepting unbounded data.
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

// 1. API routes
app.use("/api", router);

// 2. Serve static frontend in production
const frontendDist = path.resolve(__dirname, "../../returnpath-ai/dist/public");
app.use(express.static(frontendDist));

// 3. Fallback to index.html for client-side routing (Express 5 compatible)
app.use((req, res, next) => {
  if (req.method === "GET" && !req.path.startsWith("/api")) {
    return res.sendFile(path.join(frontendDist, "index.html"));
  }
  next();
});

export default app;
