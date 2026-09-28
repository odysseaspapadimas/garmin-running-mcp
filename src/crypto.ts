import type { GarminTokens } from "@dofek/garmin-connect/types";

function keyBytes(base64: string): Uint8Array<ArrayBuffer> {
  const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error("GARMIN_TOKEN_KEY must be 32 random bytes encoded as base64");
  return raw;
}
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

export async function encryptTokens(tokens: GarminTokens, keyBase64: string) {
  const key = await crypto.subtle.importKey("raw", keyBytes(keyBase64), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(tokens)));
  return { iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
}
export async function decryptTokens(ciphertext: string, iv: string, keyBase64: string): Promise<GarminTokens> {
  const key = await crypto.subtle.importKey("raw", keyBytes(keyBase64), "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(iv) }, key, decode(ciphertext));
  const tokens = JSON.parse(new TextDecoder().decode(plaintext)) as GarminTokens;
  if (!tokens.oauth1?.oauth_token || !tokens.oauth1?.oauth_token_secret || !tokens.oauth2?.access_token) throw new Error("Malformed Garmin token payload");
  return tokens;
}
