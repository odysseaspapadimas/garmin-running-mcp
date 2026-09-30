# Garmin Running MCP

Self-hosted Garmin Connect → ChatGPT/AI-agent integration for a personal running account. No Strava, subscription sync service, or public activity files. Built with a Cloudflare Worker, D1, private R2 and [Alchemy](https://alchemy.run). **Garmin Connect's consumer API is unofficial and may change.** This is an independent project, not affiliated with Garmin.

## What it does

- Cloudflare Access Managed OAuth limits the `/mcp` endpoint to **one exact email address**. The Worker verifies the signed Access assertion as well. No anonymous data tools or Garmin write actions.
- Every six hours, the Worker incrementally caches running activities, laps, HR zones and available recovery metrics in D1; original activity downloads go to a private R2 bucket. Historical pagination is bounded (four activities per pass). Activity changes outside the most recent window are not automatically rescanned.
- `refresh_latest_run` is an **explicit, rate-limited** Garmin read: it checks up to five recent activities, caches the newest run's summary **and per-lap splits** when Garmin has them, and returns the safe lap metrics immediately. It is not a full history sync: chart, HR zones and originals arrive on the scheduled sync. The tool has a one-minute cooldown and shares a single-flight lease with cron; do not use it for automated polling. Garmin may take time to process a new activity or its splits.
- All other MCP tools are cache-only: `latest_run`, `list_runs`, `run_details`, `run_chart`, `compare_runs`, `running_trends`, `recovery`, `training_context`, `sync_status`. No agent can modify the Garmin account.
- Garmin login is interactive on your machine. Password and MFA are **not stored**. Renewable OAuth tokens are AES-256-GCM encrypted in D1, with the key stored separately as a Worker secret. A revoked session requires repeating the interactive login.

> **Privacy:** The D1 cache includes original Garmin JSON, and private R2 files can contain precise GPS tracks. Protect Cloudflare account access and the encryption key. The MCP tools do not expose the private R2 files or raw chart responses; `run_chart` exposes only a bounded allowlist of non-coordinate metrics. Activity names and timestamps may still be identifying.

## Requirements

- Node 22+, pnpm 10.17.0, a Cloudflare account with Workers, D1, R2 and Zero Trust Access. R2 may require a billing method. A ChatGPT plan/UI that supports private custom MCP apps and OAuth (or another compatible MCP client).
- An Alchemy `default` Cloudflare OAuth profile with access to your account (`pnpm exec alchemy profile show`). For one-time Garmin-session upload, Wrangler must separately have D1 access (`pnpm exec wrangler login`). Use the **same Cloudflare account** in both.
- Your exact Cloudflare Access login email. If you don't have a Zero Trust organization, choose an available `*.cloudflareaccess.com` team domain; otherwise Alchemy discovers the existing domain without changing the organization.

## Deploy

```sh
pnpm install
cp .env.example .env.prod
chmod 600 .env.prod
# Edit .env.prod with your CLOUDFLARE_ACCOUNT_ID, ACCESS_EMAIL and
# GARMIN_TOKEN_KEY (generate it with: openssl rand -base64 32).
# Set NEW_ACCESS_TEAM_DOMAIN only if there is no existing Zero Trust organization.
pnpm check && pnpm test
pnpm run plan
pnpm run deploy
```

Review the plan before deployment: the Access application must have **Managed OAuth enabled**, one exact-email allow rule, and your Worker as its destination. Do not connect an unauthenticated Worker to ChatGPT. Deployment prints the `/mcp` URL. Alchemy creates the Access app/policy, Worker, D1 schema, private R2 bucket and schedule. Keep the encryption key backed up securely; losing it prevents decrypting the Garmin session.

On a machine with an interactive terminal and Wrangler authenticated to the same account:

```sh
pnpm garmin:connect
```

Enter your Garmin email, hidden password and MFA code if requested. The bootstrap forces an OAuth1→OAuth2 refresh through the Worker-side client and reads one activity **before** uploading only encrypted tokens and IV to remote D1. Do not paste credentials, tokens or FIT/GPX data into a GitHub issue or commit them. `.env.prod`, Alchemy state, Wrangler state and `.private/` are gitignored.

### Optional unattended Cloudflare API token

Local deployments can use Alchemy's OAuth profile; no Cloudflare API token is needed. For unattended CI, provision an account-scoped token (or use an Alchemy admin profile to mint one) with only the permissions needed for Zero Trust Access organization/IdP and app/policy management, Workers Scripts (including Alchemy state-store bootstrap), D1, R2 and Secrets Store. Minting API tokens requires an additional **API Tokens — Write** bootstrap credential; do not grant it to routine deployments. Follow the [Cloudflare permissions reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) and [Alchemy CI guide](https://alchemy.run/environments/ci/).

## Connect and verify

1. In ChatGPT, enable developer mode and create a **private** custom MCP app using the deployed `https://…workers.dev/mcp` URL with OAuth authentication. Approve the Access email PIN for your allowlisted email. If the client uses a different OAuth callback, add only its exact callback URL to `dynamicClientRegistration.allowedUris` in `alchemy.run.ts` and redeploy; do **not** remove authentication.
2. Ask for `sync_status` (`status: ok` after cron), `latest_run` and `run_details`. Compare distance, time, laps and HR against Garmin Connect. Test `list_runs`, `running_trends` and `recovery` where available. After a new run appears on Garmin, explicitly call `refresh_latest_run`; `updated`, `no_new_run`, `cooldown` and `busy` describe what happened. Try again after its retry interval if Garmin is still processing the activity.
3. An unauthenticated request to `/mcp` must receive **401**. No tool should offer Garmin modification. `run_chart` is opt-in and paginates up to 100 samples from the first 500 cached chart points; it never returns GPS coordinates or the original ZIP/FIT.

The first scheduled sync runs at minute 17 every six hours (UTC). `sync_status.backfill_offset` advances only after a successful page; `complete` means the current archive was paginated. If you later import older runs into Garmin, verify their **activity type is Running** (GPX uploads can default to Other), verify they appear in Garmin's activity list, then intentionally reset `backfill_offset` to `0` in D1 so the next scheduled sync rescans history. Do not reset blindly or repeatedly; use a temporary bounded schedule only when supervised, then restore the six-hour cron. Garmin's API and manual imports can lag.

## Tool semantics and limits

- Dates on runs are Garmin-local dates. Recovery queries currently use UTC calendar dates and device-dependent metrics may be missing (`null`, not zero).
- Pace = moving seconds × 1000 / distance in meters; elapsed time is preserved separately. Cadence uses Garmin's steps-per-minute summary or a moving-time-weighted lap average. `compare_runs` returns newest-minus-older numeric deltas (negative pace is faster). Different distances/intensities may limit comparisons.
- At most 100 runs per range, 10 comparison IDs, 365 trend days, 100 samples per `run_chart` call. `run_details` excludes the chart; `details_pending` means per-lap splits are unavailable, while `full_details_pending` means the scheduled sync has not fetched chart/HR-zone detail yet.
- `refresh_latest_run` is **not** marked MCP read-only: it reads Garmin and mutates the local cache, never the Garmin account. It makes at most one short activity-list request and (when laps are missing) one split request spaced by five seconds; it won't perform history pagination, recovery calls or original activity downloads. If cron is already running, it returns `busy` instead of racing token updates. `sync_status` separately tracks cron status and manual refresh status; after a manual failure, `refresh_latest_error_stage` contains only a fixed checkpoint and HTTP status (never an exception body), and is cleared on success.
- `training_context` gives a starting goal of sub-30-minute 5K (6:00/km) and eventual 10K. Suggestions are for the runner to review, not medical advice or automatic workout writes.

## Failure modes

`needs_initial_login` / `needs_reauthentication`: run the interactive bootstrap again and investigate revoked or expired Garmin tokens. `rate_limited`: wait rather than retrying rapidly. `upstream_error`: Garmin might be unavailable or its undocumented API may have changed. Do not log third-party exception bodies: they can contain credentials or OAuth tokens. The adapter is isolated in `src/garmin.ts` and the bootstrap in `scripts/connect-garmin.ts` for repair or replacement. Back up D1 and R2; keep the key separately.

Local checks: `pnpm check && pnpm test`; Worker bundle: `pnpm exec wrangler deploy src/worker.ts --dry-run --outdir /tmp/garmin-build --compatibility-date 2026-09-20 --compatibility-flags nodejs_compat`. Tests and dry-runs cannot prove production Access OAuth or Garmin token renewal; validate against your own account.
