import { Buffer } from "node:buffer";

export type AccessMode = "disabled" | "report" | "enforce";

export type AccessIdentity = {
  subject: string;
  email: string;
  issuedAt: number;
  expiresAt: number;
};

export const ACCESS_HEADERS = {
  mode: "x-ivrm-access-mode",
  state: "x-ivrm-access-state",
  subject: "x-ivrm-access-subject",
  email: "x-ivrm-access-email",
} as const;

export type AccessState =
  | "disabled"
  | "config_missing"
  | "missing"
  | "invalid"
  | "verified";

type AccessConfiguration = {
  teamDomain: string;
  audience: string;
};

type JwtHeader = {
  alg: string;
  kid: string;
};

type JwtPayload = {
  aud: string | string[];
  email: string;
  exp: number;
  iat: number;
  nbf?: number;
  iss: string;
  sub: string;
  type?: string;
};

type AccessJwk = JsonWebKey & {
  kid?: string;
  use?: string;
};

type JwksResponse = {
  keys: AccessJwk[];
};

type JwksCache = {
  teamDomain: string;
  expiresAt: number;
  keys: AccessJwk[];
};

const CLOCK_SKEW_SECONDS = 60;
const JWKS_CACHE_MILLISECONDS = 5 * 60 * 1_000;
let jwksCache: JwksCache | null = null;

export function getAccessMode(): AccessMode {
  const raw = process.env.IVRM_ACCESS_MODE?.trim().toLowerCase() || "disabled";
  if (raw === "disabled" || raw === "report" || raw === "enforce") {
    return raw;
  }
  throw new Error("IVRM_ACCESS_MODEが不正です");
}

function normalizeTeamDomain(raw: string): string {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    !url.hostname.endsWith(".cloudflareaccess.com")
  ) {
    throw new Error("CF_ACCESS_TEAM_DOMAINが不正です");
  }
  return `https://${url.hostname}`;
}

export function getAccessConfiguration(): AccessConfiguration | null {
  const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN?.trim();
  const audience = process.env.CF_ACCESS_AUD?.trim();
  if (!teamDomain || !audience) {
    return null;
  }
  if (audience.length > 256 || /\s/.test(audience)) {
    throw new Error("CF_ACCESS_AUDが不正です");
  }
  return {
    teamDomain: normalizeTeamDomain(teamDomain),
    audience,
  };
}

function decodeJsonSegment(segment: string): unknown {
  if (!segment || segment.length > 16_384) {
    throw new Error("JWTセグメントが不正です");
  }
  const decoded = Buffer.from(segment, "base64url").toString("utf8");
  return JSON.parse(decoded) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHeader(value: unknown): JwtHeader {
  if (!isRecord(value) || value.alg !== "RS256" || typeof value.kid !== "string") {
    throw new Error("JWTヘッダーが不正です");
  }
  if (!value.kid || value.kid.length > 256) {
    throw new Error("JWT kidが不正です");
  }
  return { alg: value.alg, kid: value.kid };
}

function parsePayload(value: unknown): JwtPayload {
  if (!isRecord(value)) {
    throw new Error("JWTペイロードが不正です");
  }
  const audience = value.aud;
  const audienceIsValid =
    typeof audience === "string" ||
    (Array.isArray(audience) && audience.every((item) => typeof item === "string"));
  if (
    !audienceIsValid ||
    typeof value.email !== "string" ||
    typeof value.exp !== "number" ||
    typeof value.iat !== "number" ||
    (value.nbf !== undefined && typeof value.nbf !== "number") ||
    typeof value.iss !== "string" ||
    typeof value.sub !== "string" ||
    (value.type !== undefined && typeof value.type !== "string")
  ) {
    throw new Error("JWTクレームが不正です");
  }
  return {
    aud: audience,
    email: value.email,
    exp: value.exp,
    iat: value.iat,
    nbf: value.nbf,
    iss: value.iss,
    sub: value.sub,
    type: value.type,
  };
}

async function getSigningKeys(
  teamDomain: string,
  forceRefresh = false,
): Promise<AccessJwk[]> {
  const now = Date.now();
  if (
    !forceRefresh &&
    jwksCache &&
    jwksCache.teamDomain === teamDomain &&
    jwksCache.expiresAt > now
  ) {
    return jwksCache.keys;
  }

  const response = await fetch(`${teamDomain}/cdn-cgi/access/certs`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error("Cloudflare Access署名鍵を取得できません");
  }
  const body = (await response.json()) as unknown;
  if (!isRecord(body) || !Array.isArray(body.keys)) {
    throw new Error("Cloudflare Access署名鍵の形式が不正です");
  }
  const keys = (body as JwksResponse).keys.filter(
    (key) =>
      key.kty === "RSA" &&
      typeof key.kid === "string" &&
      key.kid.length > 0 &&
      (!key.use || key.use === "sig"),
  );
  if (keys.length === 0 || keys.length > 20) {
    throw new Error("Cloudflare Access署名鍵が不正です");
  }
  jwksCache = {
    teamDomain,
    expiresAt: now + JWKS_CACHE_MILLISECONDS,
    keys,
  };
  return keys;
}

function audienceMatches(audience: string | string[], expected: string): boolean {
  return Array.isArray(audience)
    ? audience.includes(expected)
    : audience === expected;
}

function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (
    email.length < 3 ||
    email.length > 320 ||
    !email.includes("@") ||
    /[\u0000-\u001f\u007f]/.test(email)
  ) {
    throw new Error("Accessメールアドレスが不正です");
  }
  return email;
}

export async function verifyCloudflareAccessJwt(
  token: string,
  configuration: AccessConfiguration,
): Promise<AccessIdentity> {
  if (!token || token.length > 16_384) {
    throw new Error("Access JWTが不正です");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Access JWTが不正です");
  }

  const header = parseHeader(decodeJsonSegment(parts[0]));
  const payload = parsePayload(decodeJsonSegment(parts[1]));
  const signature = Buffer.from(parts[2], "base64url");
  if (signature.length === 0 || signature.length > 1_024) {
    throw new Error("Access JWT署名が不正です");
  }

  let keys = await getSigningKeys(configuration.teamDomain);
  let signingKey = keys.find((key) => key.kid === header.kid);
  if (!signingKey) {
    keys = await getSigningKeys(configuration.teamDomain, true);
    signingKey = keys.find((key) => key.kid === header.kid);
  }
  if (!signingKey) {
    throw new Error("Access JWT署名鍵が見つかりません");
  }
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    signingKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, "utf8");
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    signature,
    signingInput,
  );
  if (!verified) {
    throw new Error("Access JWT署名が一致しません");
  }

  const nowSeconds = Math.floor(Date.now() / 1_000);
  if (
    payload.iss !== configuration.teamDomain ||
    !audienceMatches(payload.aud, configuration.audience) ||
    !Number.isInteger(payload.exp) ||
    !Number.isInteger(payload.iat) ||
    payload.exp <= nowSeconds - CLOCK_SKEW_SECONDS ||
    payload.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
    (payload.nbf !== undefined &&
      (!Number.isInteger(payload.nbf) ||
        payload.nbf > nowSeconds + CLOCK_SKEW_SECONDS)) ||
    (payload.type !== undefined && payload.type !== "app")
  ) {
    throw new Error("Access JWTクレームを検証できません");
  }

  const subject = payload.sub.trim();
  if (!subject || subject.length > 255 || /[\u0000-\u001f\u007f]/.test(subject)) {
    throw new Error("Access subjectが不正です");
  }

  return {
    subject,
    email: normalizeEmail(payload.email),
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
}
