import type { Response } from "express";
import { logger } from "./logger";

export function sendInternalError(res: Response, error: unknown, message: string): Response {
  logger.error({ err: error }, message);
  const detail = error instanceof Error ? error.message : (typeof error === "string" ? error : message);
  return res.status(500).json({ success: false, error: detail || message });
}
