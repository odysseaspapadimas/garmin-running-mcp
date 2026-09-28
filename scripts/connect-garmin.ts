import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import type { GarminConnect as GarminConnectType } from "@flow-js/garmin-connect";
const { stdin, stdout } = process;
// This dependency is CommonJS; Node's ESM loader does not expose its named export.
const { GarminConnect } = createRequire(import.meta.url)("@flow-js/garmin-connect") as { GarminConnect: typeof GarminConnectType };
import { GarminConnectClient } from "@dofek/garmin-connect";
import { encryptTokens } from "../src/crypto.js";

async function hiddenPrompt(message: string): Promise<string> {
  if (!stdin.isTTY || !stdin.setRawMode) throw new Error("Run in an interactive terminal; passwords must not be passed as CLI arguments");
  stdout.write(message);
  stdin.setRawMode(true);
  stdin.resume();
  let answer = "";
  try {
    // Keep stdin open when the password prompt returns; MFA may need it again.
    for await (const data of stdin.iterator({ destroyOnReturn: false })) {
      for (const char of String(data)) {
        if (char === "\r" || char === "\n") { stdout.write("\n"); return answer; }
        if (char === "\u0003") throw new Error("Cancelled");
        if (char === "\u007f") answer = answer.slice(0, -1);
        else answer += char;
      }
    }
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
  throw new Error("Input closed");
}

async function main() {
  const key = process.env.GARMIN_TOKEN_KEY;
  if (!key) throw new Error("Set GARMIN_TOKEN_KEY in a private environment file before running this command");
  const rl = createInterface({ input: stdin, output: stdout });
  const email = (await rl.question("Garmin email: ")).trim();
  rl.close();
  const password = await hiddenPrompt("Garmin password (not echoed): ");
  const client = new GarminConnect({ username: email, password });
  const oldLog = console.log;
  const oldError = console.error;
  // The unofficial login dependency logs full Axios errors on some failures;
  // those can include request configuration and password. Suppress its logs.
  console.log = () => {};
  console.error = () => {};
  try {
    await client.login(undefined, undefined, { mfaHandler: () => hiddenPrompt("Garmin MFA code (not echoed): ") });
    const exported = client.exportToken();
    // Cross-client compatibility must be proven against this real session before saving it.
    // Force a fresh OAuth1 → OAuth2 exchange: a working access token alone is
    // not proof that the Worker will still sync after the bearer token expires.
    const probe = await GarminConnectClient.fromTokens({ oauth1: exported.oauth1, oauth2: { ...exported.oauth2, expires_at: 0 } });
    const runs = await probe.getActivities(0, 1);
    stdout.write(`Garmin authenticated; read-only probe returned ${runs.length} activity.\n`);
    const tokens = probe.getTokens();
    if (!tokens) throw new Error("Garmin token probe failed");
    const { ciphertext, iv } = await encryptTokens(tokens, key);
    const db = "garmin-running-prod";
    const sql = `INSERT INTO garmin_session(id,ciphertext,iv,updated_at) VALUES(1,'${ciphertext}','${iv}',datetime('now')) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext,iv=excluded.iv,updated_at=excluded.updated_at`;
    const result = spawnSync("pnpm", ["exec", "wrangler", "d1", "execute", db, "--remote", "--command", sql], { stdio: "inherit" });
    if (result.status !== 0) throw new Error("Encrypted token upload failed; no plaintext token was stored in D1");
    stdout.write("Encrypted Garmin session imported to D1. Wait for the scheduled sync, then inspect sync_status in ChatGPT.\n");
  } finally {
    console.log = oldLog;
    console.error = oldError;
  }
}
main().catch(() => { console.error("Garmin onboarding failed. Verify auth, MFA, Worker compatibility and Cloudflare credentials; no token details are logged."); process.exitCode = 1; });
