import { Router } from "express";
import { skillsDiscoveryAgent } from "../agents/skillsDiscoveryAgent";
import { inclusiveMatchingAgent } from "../agents/inclusiveMatchingAgent";
import { biasAuditAgent } from "../agents/biasAuditAgent";
import { jouleCareerAgent } from "../agents/jouleCareerAgent";
import { sendInternalError } from "../lib/http";
import { rateLimit } from "../middlewares/rateLimit";
import { requireAuth, requireRecruiter } from "../middlewares/requireAuth";

export const agentsRouter = Router();

agentsRouter.use(requireAuth);
agentsRouter.use(rateLimit({ max: 30, windowMs: 15 * 60 * 1000 }));

function textInput(value: unknown, maxLength = 60_000): string | null {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    return null;
  }
  return value.trim();
}

// 1. Skills Discovery Agent Endpoint
agentsRouter.post("/extract-skills", async (req, res) => {
  try {
    const text = textInput(req.body.text);
    if (!text) return res.status(400).json({ success: false, error: "text must be a non-empty string up to 60,000 characters." });
    const apiKey = process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY;
    const result = await skillsDiscoveryAgent.extractSkills(text, apiKey);
    return res.json({ success: true, data: result, framework: "SAP Talent Intelligence Hub Agent" });
  } catch (error) {
    return sendInternalError(res, error, "Skills extraction failed");
  }
});

// 2. Inclusive Matching Agent Endpoint
agentsRouter.post("/match", async (req, res) => {
  try {
    const jobId = Number(req.body.jobId);
    if (!Number.isInteger(jobId) || jobId < 1) {
      return res.status(400).json({ success: false, error: "jobId must be a positive integer." });
    }
    const result = await inclusiveMatchingAgent.calculateMatch(res.locals.userId, jobId);
    return res.json({ success: true, data: result, framework: "SAP Inclusive Matching Agent" });
  } catch (error) {
    return sendInternalError(res, error, "Candidate matching failed");
  }
});

// 3. Bias Audit Agent Endpoint
agentsRouter.get("/bias-audit", requireRecruiter, async (_req, res) => {
  try {
    const result = await biasAuditAgent.runAudit();
    return res.json({ success: true, data: result, framework: "SAP Bias Audit & Governance Agent" });
  } catch (error) {
    return sendInternalError(res, error, "Bias audit failed");
  }
});

// 4. Joule Conversational AI Coach Endpoint
agentsRouter.post("/chat", async (req, res) => {
  try {
    const message = textInput(req.body.message, 12_000);
    if (!message) return res.status(400).json({ success: false, error: "message must be a non-empty string up to 12,000 characters." });
    const { history, profile } = req.body;
    const apiKey = process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY;
    const reply = await jouleCareerAgent.chat(message, Array.isArray(history) ? history.slice(-10) : [], profile, apiKey);
    return res.json({ success: true, reply, agent: "SAP Joule Career Assistant" });
  } catch (error) {
    return sendInternalError(res, error, "Career assistant request failed");
  }
});
