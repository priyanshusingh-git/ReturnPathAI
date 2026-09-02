import { createRequire } from "module";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HanaConfig {
  serverNode: string;
  uid: string;
  pwd: string;
  encrypt: boolean;
  sslValidateCertificate: boolean;
  /** Optional PEM certificate injected by BTP via VCAP_SERVICES */
  sslCryptoProvider?: string;
  sslTrustStore?: string;
}

type ConnectionMode = "HANA_CONNECTED" | "HANA_DISCONNECTED" | "IN_MEMORY";

// ─── Credential Resolution ───────────────────────────────────────────────────

/**
 * Priority order:
 *   1. VCAP_SERVICES (SAP BTP Cloud Foundry — set automatically when a HANA
 *      service instance is bound via `cf bind-service`)
 *   2. Individual HANA_* env vars (local development / manual BTP env vars)
 *   3. null → in-memory fallback
 */
export function resolveHanaConfig(): HanaConfig | null {
  // ── 1. Try VCAP_SERVICES (BTP Cloud Foundry) ──────────────────────────────
  const vcap = process.env.VCAP_SERVICES;
  if (vcap) {
    try {
      const services = JSON.parse(vcap) as Record<string, any[]>;

      // BTP HANA Cloud can appear under several service type keys
      const hanaEntry =
        services["hana"]?.[0] ??
        services["hanatrial"]?.[0] ??
        services["hana-cloud"]?.[0] ??
        services["hana-db"]?.[0];

      const creds = hanaEntry?.credentials;

      if (creds?.host) {
        // hana-cloud free plan uses OAuth (UAA) — no direct user/password in VCAP.
        // Direct @sap/hana-client connections require a DB-level user+password.
        // These are supplied via HANA_USER / HANA_PASSWORD env vars (cf set-env).
        if (creds.user && creds.password) {
          // Full credential shape (non-free plans) — use directly.
          const config: HanaConfig = {
            serverNode: `${creds.host}:${creds.port ?? 443}`,
            uid: creds.user,
            pwd: creds.password,
            encrypt: true,
            sslValidateCertificate: true,
          };
          if (creds.certificate) {
            config.sslCryptoProvider = "openssl";
            config.sslTrustStore = creds.certificate;
          }
          console.log("🔑 HANA credentials resolved from VCAP_SERVICES (BTP service binding).");
          return config;
        }

        // hana-free / OAuth plan: host is available but credentials use UAA.
        // Use HANA_USER + HANA_PASSWORD env vars for the DB-level user,
        // paired with the host from VCAP so we don't hardcode the host.
        const user = process.env.HANA_USER;
        const password = process.env.HANA_PASSWORD;
        if (user && password) {
          console.log(
            "🔑 HANA host resolved from VCAP_SERVICES, credentials from HANA_USER/HANA_PASSWORD env vars."
          );
          return {
            serverNode: `${creds.host}:${creds.port ?? 443}`,
            uid: user,
            pwd: password,
            encrypt: true,
            sslValidateCertificate: true,
          };
        }

        console.warn(
          "⚠️  HANA host found in VCAP_SERVICES but HANA_USER / HANA_PASSWORD are not set.\n" +
          "    Run: cf set-env returnpath-ai HANA_USER DBADMIN\n" +
          "         cf set-env returnpath-ai HANA_PASSWORD <your-password>\n" +
          "         cf restart returnpath-ai"
        );
        return null;
      }
    } catch (e: any) {
      console.warn("⚠️  Failed to parse VCAP_SERVICES:", e.message);
    }
  }

  // ── 2. Try individual env vars (local dev / manual cf set-env) ────────────
  const host = process.env.HANA_HOST;
  const user = process.env.HANA_USER;
  const password = process.env.HANA_PASSWORD;

  if (host && user && password) {
    console.log("🔑 HANA credentials resolved from HANA_HOST / HANA_USER / HANA_PASSWORD env vars.");
    return {
      serverNode: `${host}:${process.env.HANA_PORT ?? 443}`,
      uid: user,
      pwd: password,
      encrypt: true,
      sslValidateCertificate: true,
    };
  }

  // ── 3. No credentials found ───────────────────────────────────────────────
  console.warn(
    "⚠️  No HANA credentials found (VCAP_SERVICES or HANA_HOST/USER/PASSWORD).\n" +
    "    Running in IN_MEMORY mode — data will be lost on restart.\n" +
    "    For BTP: run `cf bind-service returnpath-ai <your-hana-instance>`\n" +
    "    For local: set HANA_HOST, HANA_USER, HANA_PASSWORD in your .env file."
  );
  return null;
}


// ─── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA_TABLES = [
  // Candidates table — profile stored as NCLOB JSON for flexibility
  {
    name: "RETURNPATH_CANDIDATES",
    sql: `CREATE TABLE RETURNPATH_CANDIDATES (
    ID          NVARCHAR(128)  NOT NULL,
    USER_ID     NVARCHAR(128)  NOT NULL,
    PROFILE_JSON NCLOB         NOT NULL,
    UPDATED_AT  SECONDDATE     DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ID)
  )`,
  },
  // Jobs table
  {
    name: "RETURNPATH_JOBS",
    sql: `CREATE TABLE RETURNPATH_JOBS (
    ID          INTEGER        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    TITLE       NVARCHAR(256)  NOT NULL,
    COMPANY     NVARCHAR(256),
    JOB_JSON    NCLOB          NOT NULL,
    CREATED_AT  SECONDDATE     DEFAULT CURRENT_TIMESTAMP
  )`,
  },
  // Applications table (for future use)
  {
    name: "RETURNPATH_APPLICATIONS",
    sql: `CREATE TABLE RETURNPATH_APPLICATIONS (
    ID            NVARCHAR(128)  NOT NULL,
    CANDIDATE_ID  NVARCHAR(128)  NOT NULL,
    JOB_ID        INTEGER        NOT NULL,
    STATUS        NVARCHAR(64)   DEFAULT 'APPLIED',
    APPLIED_AT    SECONDDATE     DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ID)
  )`,
  },
  {
    name: "RETURNPATH_RECRUITER_ACCESS",
    sql: `CREATE TABLE RETURNPATH_RECRUITER_ACCESS (
    USER_ID     NVARCHAR(128) NOT NULL,
    CREATED_AT  SECONDDATE    DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (USER_ID)
  )`,
  },
];

// ─── Database Class ──────────────────────────────────────────────────────────

class HanaDatabase {
  private client: any = null;
  private mode: ConnectionMode = "IN_MEMORY";
  /** Fallback store — used when no HANA credentials are configured */
  private memoryStore: Map<string, any[]> = new Map();

  constructor() {
    // Seed in-memory jobs so the UI is never empty in local/demo mode
    this.memoryStore.set("RETURNPATH_JOBS", [
      {
        id: 1,
        title: "Product Operations Lead",
        company: "SAP Labs India",
        location: "Bangalore (Hybrid)",
        mode: "Hybrid",
        salary: "₹28L – ₹36L",
        skills: ["Product Strategy", "Cross-Functional Alignment", "SQL Analytics", "Agile Execution"],
        description: "Scale core enterprise cloud solutions, aligning 5 product teams across Bangalore & Walldorf.",
      },
      {
        id: 2,
        title: "Senior Systems Specialist",
        company: "Northstar Health",
        location: "Remote",
        mode: "Remote",
        salary: "₹22L – ₹30L",
        skills: ["HealthTech", "HL7/FHIR", "System Architecture"],
        description: "Lead patient record integration with human-centered care.",
      },
    ]);
    this.memoryStore.set("RETURNPATH_CANDIDATES", []);
    this.memoryStore.set("RETURNPATH_RECRUITER_ACCESS", []);
  }

  // ── Connection ─────────────────────────────────────────────────────────────

  async connect(): Promise<boolean> {
    const config = resolveHanaConfig();
    if (!config) {
      this.mode = "IN_MEMORY";
      return false;
    }

    try {
      const require = createRequire(import.meta.url);
      const hana = require("@sap/hana-client");

      if (!hana || typeof hana.createConnection !== "function") {
        console.error("❌ @sap/hana-client module not available.");
        this.mode = "IN_MEMORY";
        return false;
      }

      this.client = hana.createConnection();

      return new Promise((resolve) => {
        this.client.connect(config, (err: any) => {
          if (err) {
            console.error("❌ SAP HANA Cloud connection failed:", err.message);
            this.mode = "HANA_DISCONNECTED";
            this.client = null;
            resolve(false);
          } else {
            console.log("✅ Connected to SAP HANA Cloud successfully.");
            this.mode = "HANA_CONNECTED";
            resolve(true);
          }
        });
      });
    } catch (e: any) {
      console.error("❌ @sap/hana-client load error:", e.message);
      this.mode = "IN_MEMORY";
      return false;
    }
  }

  // ── Schema Bootstrap ───────────────────────────────────────────────────────

  /**
   * Creates missing tables using HANA catalog checks. HANA does not support
   * the CREATE TABLE IF NOT EXISTS syntax used by several other databases.
   */
  async bootstrapSchema(): Promise<void> {
    if (this.mode !== "HANA_CONNECTED" || !this.client) {
      console.log(`ℹ️  Schema bootstrap skipped (mode: ${this.mode}).`);
      return;
    }

    for (const table of SCHEMA_TABLES) {
      const existing = await this.query<{ TABLE_NAME: string }>(
        "SELECT TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = CURRENT_SCHEMA AND TABLE_NAME = ?",
        [table.name],
      );
      if (existing.length === 0) {
        await this.exec(table.sql);
      }
    }

    const index = await this.query<{ INDEX_NAME: string }>(
      "SELECT INDEX_NAME FROM SYS.INDEXES WHERE SCHEMA_NAME = CURRENT_SCHEMA AND INDEX_NAME = ?",
      ["IDX_CANDIDATES_USER_ID"],
    );
    if (index.length === 0) {
      await this.exec("CREATE INDEX IDX_CANDIDATES_USER_ID ON RETURNPATH_CANDIDATES (USER_ID)");
    }
    console.log("✅ HANA schema bootstrapped (tables ready).");
  }

  // ── SQL Helpers ────────────────────────────────────────────────────────────

  /** Promisified exec — for DDL statements */
  private exec(sql: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.exec(sql, (err: any) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Promisified exec with parameters — for DML (INSERT / UPDATE / SELECT) */
  private query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
      this.client.exec(sql, params, (err: any, rows: T[]) => {
        if (err) reject(err);
        else resolve(rows ?? []);
      });
    });
  }

  // ── Public API — automatically routes to HANA or in-memory ────────────────

  async getCandidateProfile(userId: string): Promise<any | null> {
    if (!userId) return null;

    if (this.mode === "HANA_CONNECTED") {
      try {
        const rows = await this.query<{ PROFILE_JSON: string }>(
          `SELECT PROFILE_JSON FROM RETURNPATH_CANDIDATES WHERE USER_ID = ? LIMIT 1`,
          [userId]
        );
        return rows.length > 0 ? JSON.parse(rows[0].PROFILE_JSON) : null;
      } catch (e: any) {
        console.error("HANA getCandidateProfile error:", e.message);
        return null;
      }
    }

    // In-memory fallback
    const candidates = this.memoryStore.get("RETURNPATH_CANDIDATES") ?? [];
    return candidates.find((c) => c.userId === userId || c.id === userId) ?? null;
  }

  async saveCandidateProfile(profile: any): Promise<any> {
    const record = {
      ...profile,
      name: profile.name || profile.candidateName || "",
      candidateName: profile.candidateName || profile.name || "",
      id: profile.id || `cand_${Date.now()}`,
      updatedAt: new Date().toISOString(),
    };

    if (this.mode === "HANA_CONNECTED") {
      try {
        const json = JSON.stringify(record);

        // UPSERT — update if exists, insert if not
        const existing = await this.query<{ ID: string }>(
          `SELECT ID FROM RETURNPATH_CANDIDATES WHERE USER_ID = ?`,
          [record.userId]
        );

        if (existing.length > 0) {
          await this.query(
            `UPDATE RETURNPATH_CANDIDATES
             SET PROFILE_JSON = ?, UPDATED_AT = CURRENT_TIMESTAMP
             WHERE USER_ID = ?`,
            [json, record.userId]
          );
        } else {
          await this.query(
            `INSERT INTO RETURNPATH_CANDIDATES (ID, USER_ID, PROFILE_JSON)
             VALUES (?, ?, ?)`,
            [record.id, record.userId, json]
          );
        }
        console.log(`💾 Profile saved to HANA for userId: ${record.userId}`);
        return record;
      } catch (e: any) {
        console.error("HANA saveCandidateProfile error:", e.message);
        throw e;
      }
    }

    // In-memory fallback
    const candidates = this.memoryStore.get("RETURNPATH_CANDIDATES") ?? [];
    const idx = candidates.findIndex(
      (c) => c.userId === record.userId || (record.id && c.id === record.id)
    );
    if (idx >= 0) candidates[idx] = { ...candidates[idx], ...record };
    else candidates.push(record);
    this.memoryStore.set("RETURNPATH_CANDIDATES", candidates);
    return record;
  }

  async getCandidates(): Promise<any[]> {
    if (this.mode === "HANA_CONNECTED") {
      try {
        const rows = await this.query<{ PROFILE_JSON: string }>(
          `SELECT PROFILE_JSON FROM RETURNPATH_CANDIDATES ORDER BY UPDATED_AT DESC`
        );
        return rows.map((r) => JSON.parse(r.PROFILE_JSON));
      } catch (e: any) {
        console.error("HANA getCandidates error:", e.message);
        return [];
      }
    }
    return this.memoryStore.get("RETURNPATH_CANDIDATES") ?? [];
  }

  async isRecruiter(userId: string): Promise<boolean> {
    if (!userId) return false;

    if (this.mode === "HANA_CONNECTED") {
      try {
        const rows = await this.query<{ USER_ID: string }>(
          `SELECT USER_ID FROM RETURNPATH_RECRUITER_ACCESS WHERE USER_ID = ?`,
          [userId],
        );
        return rows.length > 0;
      } catch (e: any) {
        console.error("HANA isRecruiter error:", e.message);
        return false;
      }
    }

    return (this.memoryStore.get("RETURNPATH_RECRUITER_ACCESS") ?? []).includes(userId);
  }

  async grantRecruiterAccess(userId: string): Promise<void> {
    if (!userId) throw new Error("A user ID is required to grant recruiter access.");

    if (this.mode === "HANA_CONNECTED") {
      const existing = await this.isRecruiter(userId);
      if (!existing) {
        await this.query(
          `INSERT INTO RETURNPATH_RECRUITER_ACCESS (USER_ID) VALUES (?)`,
          [userId],
        );
      }
      return;
    }

    const recruiters = this.memoryStore.get("RETURNPATH_RECRUITER_ACCESS") ?? [];
    if (!recruiters.includes(userId)) recruiters.push(userId);
    this.memoryStore.set("RETURNPATH_RECRUITER_ACCESS", recruiters);
  }

  async getJobs(): Promise<any[]> {
    if (this.mode === "HANA_CONNECTED") {
      try {
        const rows = await this.query<{ JOB_JSON: string }>(
          `SELECT JOB_JSON FROM RETURNPATH_JOBS ORDER BY ID ASC`
        );
        return rows.map((r) => JSON.parse(r.JOB_JSON));
      } catch (e: any) {
        console.error("HANA getJobs error:", e.message);
        return [];
      }
    }
    return this.memoryStore.get("RETURNPATH_JOBS") ?? [];
  }

  async getJob(jobId: number): Promise<any | null> {
    if (!Number.isInteger(jobId) || jobId < 1) return null;

    if (this.mode === "HANA_CONNECTED") {
      try {
        const rows = await this.query<{ JOB_JSON: string }>(
          `SELECT JOB_JSON FROM RETURNPATH_JOBS WHERE ID = ?`,
          [jobId],
        );
        if (rows.length > 0) return JSON.parse(rows[0].JOB_JSON);
        return (this.memoryStore.get("RETURNPATH_JOBS") ?? []).find((job) => job.id === jobId) ?? null;
      } catch (e: any) {
        console.error("HANA getJob error:", e.message);
        return null;
      }
    }

    const jobs = this.memoryStore.get("RETURNPATH_JOBS") ?? [];
    return jobs.find((job) => job.id === jobId) ?? null;
  }

  async createJob(job: any): Promise<any> {
    const newJob = { ...job, created_at: new Date().toISOString() };

    if (this.mode === "HANA_CONNECTED") {
      try {
        const json = JSON.stringify(newJob);
        await this.query(
          `INSERT INTO RETURNPATH_JOBS (TITLE, COMPANY, JOB_JSON) VALUES (?, ?, ?)`,
          [newJob.title ?? "", newJob.company ?? "", json]
        );
        return newJob;
      } catch (e: any) {
        console.error("HANA createJob error:", e.message);
        throw e;
      }
    }

    const jobs = this.memoryStore.get("RETURNPATH_JOBS") ?? [];
    newJob.id = jobs.length + 1;
    jobs.push(newJob);
    this.memoryStore.set("RETURNPATH_JOBS", jobs);
    return newJob;
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  getStatus() {
    const config = resolveHanaConfig();
    return {
      database: "SAP HANA Cloud",
      mode: this.mode,
      status: this.mode === "HANA_CONNECTED" ? "CONNECTED" : this.mode,
      host: config?.serverNode ?? "in-memory",
      tables: ["RETURNPATH_CANDIDATES", "RETURNPATH_JOBS", "RETURNPATH_APPLICATIONS", "RETURNPATH_RECRUITER_ACCESS"],
    };
  }
}

export const hanaDb = new HanaDatabase();
