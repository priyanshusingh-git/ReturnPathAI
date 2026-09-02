import fs from "node:fs";
import path from "node:path";

// Auto-load .env file from root or working directory if present
const possibleEnvPaths = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "../../.env"),
  path.resolve(process.cwd(), "../.env")
];
for (const envPath of possibleEnvPaths) {
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    } catch {}
  }
}

import app from "./app";
import { logger } from "./lib/logger";
import { hanaDb } from "./db/hana";

const rawPort = process.env["PORT"] || "5000";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function startServer() {
  // ── 1. Connect to SAP HANA Cloud (or fall back to in-memory) ──────────────
  const connected = await hanaDb.connect();

  if (connected) {
    // ── 2. Bootstrap schema — idempotent, safe to run on every deploy ────────
    await hanaDb.bootstrapSchema();
    logger.info("Database mode: HANA_CONNECTED — data persisted to SAP HANA Cloud.");
  } else {
    logger.warn(
      "Database mode: IN_MEMORY — data will be lost on restart. " +
      "Bind a HANA Cloud service instance on BTP or set HANA_HOST/USER/PASSWORD to enable persistence."
    );
  }

  // ── 3. Start HTTP server ───────────────────────────────────────────────────
  app.listen(port, (err?: any) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info({ port }, `Server listening — status: ${hanaDb.getStatus().mode}`);
  });
}

startServer().catch((err) => {
  logger.error({ err }, "Fatal startup error");
  process.exit(1);
});

