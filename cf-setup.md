# SAP BTP Deployment Guide — ReturnPath AI

## Prerequisites

```bash
# Install CF CLI (if not already installed)
brew install cloudfoundry/tap/cf-cli@8

# Verify
cf --version
```

---

## Step 1 — Login to SAP BTP Cloud Foundry

```bash
# Get your API endpoint from BTP Cockpit → Cloud Foundry → Overview
cf login -a https://api.cf.ap21.hana.ondemand.com
# Enter your BTP email and password when prompted
```

---

## Step 2 — Create SAP HANA Cloud Service Instance (first time only)

```bash
# Check available HANA Cloud service plans in your subaccount
cf marketplace -e hana-cloud

# Create the service instance
# Name it exactly: hana-returnpath  (matches manifest.yml services:)
cf create-service hana-cloud hana hana-returnpath

# Wait for it to be ready (takes 3–5 minutes)
cf service hana-returnpath
# Status should show: create succeeded
```

> **Already have a HANA instance?**  
> Change the service name in `manifest.yml` under `services:` to match your existing instance name.

---

## Step 3 — Set Secrets via cf set-env

```bash
# Clerk Auth (get from clerk.com → Dashboard → API Keys)
cf set-env returnpath-ai CLERK_PUBLISHABLE_KEY  "pk_live_XXXX"
cf set-env returnpath-ai CLERK_SECRET_KEY       "sk_live_XXXX"

# Groq AI (get from console.groq.com → API Keys)
cf set-env returnpath-ai GROQ_API_KEY           "gsk_XXXX"

# Your BTP app URL (get after first cf push, then re-run this)
cf set-env returnpath-ai ALLOWED_ORIGINS        "https://returnpath-ai.cfapps.ap21.hana.ondemand.com"

```

> ✅ **HANA credentials are NOT needed here** — they are injected automatically via `VCAP_SERVICES` once the service is bound (Step 2 + the `services:` field in manifest.yml handles this). The database certificate must remain verifiable; do not disable TLS validation. Recruiters self-enroll through the recruiter sign-up flow; no manual user-ID allowlist is required.

---

## Step 4 — Build the Frontend

```bash
# From project root
cd artifacts/returnpath-ai
npm run build
cd ../..
```

---

## Step 5 — Push to SAP BTP

```bash
# From project root (where manifest.yml lives)
cf push
```

The first push will:
1. Upload your code
2. Run `npm install`
3. Start the server
4. Bind the HANA Cloud service → inject `VCAP_SERVICES`
5. App starts → connects to HANA → bootstraps schema tables

---

## Step 6 — Verify Deployment

```bash
# Check app status
cf app returnpath-ai

# View live logs
cf logs returnpath-ai --recent

# You should see:
# ✅ Connected to SAP HANA Cloud successfully.
# ✅ HANA schema bootstrapped (tables ready).
# Server listening — status: HANA_CONNECTED
```

---

## Step 7 — Update ALLOWED_ORIGINS with actual URL

After the first push you'll have a real URL. Update CORS:

```bash
# Get your app URL
cf app returnpath-ai | grep routes

# Set the CORS origin
cf set-env returnpath-ai ALLOWED_ORIGINS "https://returnpath-ai.cfapps.ap21.hana.ondemand.com"

# Restart to apply
cf restart returnpath-ai
```

---

## Updating After Code Changes

```bash
# Rebuild frontend
cd artifacts/returnpath-ai && npm run build && cd ../..

# Push updated code
cf push
```

No need to re-create the HANA instance or re-set env vars — they persist.

---

## Verify HANA Data Persistence

Use the BTP Database Explorer (SAP HANA Cloud cockpit → Database Explorer):

```sql
-- Check candidates are being saved
SELECT ID, USER_ID, UPDATED_AT FROM RETURNPATH_CANDIDATES;

-- View a profile
SELECT PROFILE_JSON FROM RETURNPATH_CANDIDATES WHERE USER_ID = 'user_xxxx';

-- Check jobs table
SELECT ID, TITLE, COMPANY FROM RETURNPATH_JOBS;
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `cf push` fails — no service found | Run Step 2 or update service name in `manifest.yml` |
| App starts with `IN_MEMORY` mode | Service not bound, or `VCAP_SERVICES` not injected — verify `cf services` shows the binding |
| CORS error in browser | Run Step 7 to set `ALLOWED_ORIGINS` to your actual BTP URL |
| Clerk auth not working | Verify `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` are set via `cf set-env` |
| `GROQ_API_KEY not set` in logs | Run `cf set-env returnpath-ai GROQ_API_KEY "gsk_..."` then `cf restart returnpath-ai` |

---

## Local Development (without BTP)

```bash
# Copy env template
cp .env.example .env
# Fill in your values in .env

# Run API server
cd artifacts/api-server && npm run dev

# Run frontend (separate terminal)
cd artifacts/returnpath-ai && npm run dev
```

In local mode, if HANA credentials are not set, the app runs in `IN_MEMORY` mode automatically — no errors, just data resets on restart.
