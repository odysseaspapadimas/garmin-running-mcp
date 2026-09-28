import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

const Infrastructure = Effect.gen(function* () {
  const selected = yield* Alchemy.Stage;
  const stage = selected === "placeholder" ? "prod" : selected;
  if (stage !== "prod" && stage !== "local") throw new Error(`Unsupported stage: ${stage}`);
  const email = yield* Config.String("ACCESS_EMAIL");
  if (!email.includes("@")) throw new Error("ACCESS_EMAIL must be your exact login email");
  const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
  // Inspect the singleton without adopting it: Alchemy's Organization resource
  // always PUTs its props, which would unnecessarily mutate an existing team.
  const org = yield* zeroTrust.listOrganizationsForAccount({ accountId }).pipe(
    Effect.catchTag("OrganizationNotFound", () => Effect.succeed(undefined)),
    Effect.mapError(() => new Error("Cannot discover Zero Trust organization: check the selected account and Access Organizations/Identity Providers/Groups API token permission")),
    Effect.orDie,
  );
  const existingDomain = org?.authDomain;
  const requestedDomain = yield* Config.String("NEW_ACCESS_TEAM_DOMAIN").pipe(Config.withDefault(""));
  if (existingDomain && requestedDomain && existingDomain !== requestedDomain) {
    throw new Error("NEW_ACCESS_TEAM_DOMAIN differs from the existing Zero Trust team domain; refusing to modify the organization");
  }
  const teamDomain = existingDomain || requestedDomain;
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain)) {
    throw new Error("No existing Zero Trust team found; set NEW_ACCESS_TEAM_DOMAIN to an available *.cloudflareaccess.com hostname");
  }
  if (!existingDomain) {
    yield* Cloudflare.Access.Organization("RunningOrg", { authDomain: teamDomain, name: "Garmin Running" });
  }

  const db = yield* Cloudflare.D1.Database("RunningData", {
    name: `garmin-running-${stage}`,
    migrations: "./migrations",
  });
  const originals = yield* Cloudflare.R2.Bucket("ActivityOriginals", {
    name: `garmin-running-originals-${stage}`,
    publicAccess: false,
    forceDestroy: false,
  });
  // A Zero Trust account may already have the built-in email-PIN provider.
  // Reuse it; never seize ownership of a shared account-level IdP.
  const pinList = yield* zeroTrust.listIdentityProvidersForAccount({ accountId }).pipe(
    Effect.mapError(() => new Error("Cannot inspect existing Access identity providers")),
    Effect.orDie,
  );
  const existingPinId = pinList.result?.find((idp) => idp.type === "onetimepin")?.id;
  const pinId = existingPinId ?? (yield* Cloudflare.Access.IdentityProvider("EmailPin", { type: "onetimepin" })).identityProviderId;
  const access = yield* Cloudflare.Access.Application("RunningMcpAccess", {
    type: "self_hosted",
    name: `Garmin Running MCP ${stage}`,
    allowedIdps: [pinId],
    autoRedirectToIdentity: true,
    policies: [{ decision: "allow", include: [{ email }] }],
    oauthConfiguration: {
      enabled: true,
      dynamicClientRegistration: {
        enabled: true,
        allowedUris: [
          "https://chatgpt.com/connector_platform_oauth_redirect",
          "https://chatgpt.com/connector/oauth/*",
        ],
      },
      grant: { accessTokenLifetime: "15m", sessionDuration: "168h" },
    },
  });
  const worker = yield* Cloudflare.Worker("RunningMcp", {
    name: `garmin-running-mcp-${stage}`,
    main: "./src/worker.ts",
    workersDev: true,
    compatibility: { date: "2026-09-20", flags: ["nodejs_compat"] },
    crons: ["17 */6 * * *"],
    access,
    env: {
      DB: db,
      ORIGINALS: originals,
      GARMIN_TOKEN_KEY: Config.Redacted("GARMIN_TOKEN_KEY"),
      ACCESS_EMAIL: email,
      ACCESS_TEAM_DOMAIN: teamDomain,
      ACCESS_AUD: access.aud,
    },
  });
  return { mcpUrl: Output.interpolate`${worker.url}/mcp`, accessTeamDomain: teamDomain, workerName: worker.workerName, database: db.databaseName, bucket: originals.bucketName };
});

export default Alchemy.Stack("GarminRunning", {
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
}, Infrastructure);
