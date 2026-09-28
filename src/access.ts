import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./storage.js";

// Cloudflare Access enforces the outer policy; we additionally verify its signed
// origin assertion rather than trusting a request-supplied header.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function assertAccess(request: Request, env: Env): Promise<void> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new Error("Missing Access assertion");
  const domain = env.ACCESS_TEAM_DOMAIN;
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain)) throw new Error("Invalid Access domain");
  let jwks = jwksCache.get(domain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${domain}/cdn-cgi/access/certs`));
    jwksCache.set(domain, jwks);
  }
  const { payload } = await jwtVerify(token, jwks, {
    issuer: `https://${domain}`,
    audience: env.ACCESS_AUD,
    algorithms: ["RS256", "ES256"],
  });
  if (payload.email !== env.ACCESS_EMAIL) throw new Error("Access identity mismatch");
}
