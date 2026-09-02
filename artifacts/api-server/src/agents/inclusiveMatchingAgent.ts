import { JobMatchResponse } from "./types";
import { hanaDb } from "../db/hana";

function normalizedSkills(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((skill): skill is string => typeof skill === "string")
    .map((skill) => skill.trim().toLowerCase())
    .filter(Boolean);
}

function candidateSkills(candidate: Record<string, unknown>): string[] {
  const direct = normalizedSkills(candidate.skills);
  if (direct.length > 0) return direct;

  if (!Array.isArray(candidate.extractedSkills)) return [];
  return candidate.extractedSkills
    .map((skill) => (typeof skill === "object" && skill ? (skill as { name?: unknown }).name : undefined))
    .filter((skill): skill is string => typeof skill === "string")
    .map((skill) => skill.trim().toLowerCase())
    .filter(Boolean);
}

function score(candidate: Record<string, unknown>, job: Record<string, unknown>): JobMatchResponse {
  const requiredSkills = normalizedSkills(job.skills);
  const availableSkills = candidateSkills(candidate);
  const available = new Set(availableSkills);
  const matching = requiredSkills.filter((skill) => available.has(skill));
  const gaps = requiredSkills.filter((skill) => !available.has(skill));
  const skillAlignmentScore = requiredSkills.length === 0
    ? 0
    : Math.round((matching.length / requiredSkills.length) * 100);
  const evidenceCount = [candidate.projects, candidate.experience, candidate.education]
    .filter(Array.isArray)
    .reduce((count, value) => count + value.length, 0);
  const evidenceScore = Math.min(100, evidenceCount * 20);
  const overallFitScore = Math.round(skillAlignmentScore * 0.8 + evidenceScore * 0.2);

  return {
    jobId: Number(job.id),
    jobTitle: typeof job.title === "string" ? job.title : "Untitled role",
    company: typeof job.company === "string" ? job.company : "Unknown employer",
    overallFitScore,
    skillAlignmentScore,
    matchingStrengths: matching.length > 0
      ? matching.map((skill) => `Verified alignment in ${skill}`)
      : ["No direct required-skill match found yet."],
    skillGaps: gaps.length > 0 ? gaps : ["No required skill gaps identified."],
    threeWeekBoostProjected: Math.min(100, overallFitScore + Math.min(20, gaps.length * 7)),
    sapLearningHubModules: gaps.slice(0, 3).map((gap, index) => ({
      week: index + 1,
      title: `Build competency in ${gap}`,
      courseUrl: "https://learning.sap.com",
      competencyGained: gap,
      hoursRequired: 6,
    })),
  };
}

export class InclusiveMatchingAgent {
  /**
   * SAP Inclusive Matching Agent
   * Matches candidate capability to enterprise job requirements based on verified skills and evidence.
   */
  async calculateMatch(candidateId: string, jobId: number): Promise<JobMatchResponse> {
    const [candidate, job] = await Promise.all([
      hanaDb.getCandidateProfile(candidateId),
      hanaDb.getJob(jobId),
    ]);

    if (!candidate) throw new Error("Candidate profile was not found.");
    if (!job) throw new Error("Job was not found.");

    return score(candidate, job);
  }
}

export const inclusiveMatchingAgent = new InclusiveMatchingAgent();
