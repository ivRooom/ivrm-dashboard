import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sanitizeReturnPath } from "./discord-auth";

const OAUTH_STATE_VERSION = 1;
const OAUTH_STATE_CONTEXT = "ivrm-discord-oauth-state-v1\0";
const OAUTH_STATE_NONCE_BYTES = 24;
const OAUTH_STATE_SIGNATURE_BYTES = 32;
const OAUTH_STATE_HEADER_BYTES = 1 + 4 + OAUTH_STATE_NONCE_BYTES + 2;
const OAUTH_STATE_MAX_AGE_SECONDS = 600;
const OAUTH_STATE_FUTURE_SKEW_SECONDS = 30;
const OAUTH_RETURN_PATH_MAX_BYTES = 512;
const OAUTH_COOKIE_SLOT_COUNT = 32;
const OAUTH_SLOT_COOKIE_PREFIX = "__Host-ivrm_discord_oauth_slot_";
const OAUTH_STATE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{80,800}$/;
const OAUTH_COOKIE_FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type DiscordOAuthAttempt = {
  state: string;
  returnTo: string;
  cookieName: string;
  cookieValue: string;
};

function fingerprintState(state: string): Buffer {
  return createHash("sha256").update(state, "utf8").digest();
}

function oauthCookieNameFromFingerprint(fingerprint: Buffer): string {
  const slot = fingerprint.readUInt16BE(0) % OAUTH_COOKIE_SLOT_COUNT;
  return `${OAUTH_SLOT_COOKIE_PREFIX}${slot.toString(16).padStart(2, "0")}`;
}

function signPayload(payload: Buffer, clientSecret: string): Buffer {
  return createHmac("sha256", clientSecret)
    .update(OAUTH_STATE_CONTEXT, "utf8")
    .update(payload)
    .digest();
}

function safeReturnPath(value: string): string {
  const sanitized = sanitizeReturnPath(value);
  return Buffer.byteLength(sanitized, "utf8") <= OAUTH_RETURN_PATH_MAX_BYTES
    ? sanitized
    : "/";
}

export function createDiscordOAuthAttempt(
  returnPath: string,
  clientSecret: string,
  issuedAtMilliseconds = Date.now(),
): DiscordOAuthAttempt {
  if (!clientSecret) {
    throw new Error("Discord OAuth署名Secretがありません");
  }
  if (!Number.isFinite(issuedAtMilliseconds) || issuedAtMilliseconds < 0) {
    throw new Error("Discord OAuth stateの発行時刻が不正です");
  }

  const returnTo = safeReturnPath(returnPath);
  const returnBytes = Buffer.from(returnTo, "utf8");
  const issuedAtSeconds = Math.floor(issuedAtMilliseconds / 1000);
  if (issuedAtSeconds > 0xffffffff) {
    throw new Error("Discord OAuth stateの発行時刻が範囲外です");
  }

  const payload = Buffer.alloc(OAUTH_STATE_HEADER_BYTES + returnBytes.length);
  payload.writeUInt8(OAUTH_STATE_VERSION, 0);
  payload.writeUInt32BE(issuedAtSeconds, 1);
  randomBytes(OAUTH_STATE_NONCE_BYTES).copy(payload, 5);
  payload.writeUInt16BE(returnBytes.length, 5 + OAUTH_STATE_NONCE_BYTES);
  returnBytes.copy(payload, OAUTH_STATE_HEADER_BYTES);

  const state = Buffer.concat([payload, signPayload(payload, clientSecret)]).toString(
    "base64url",
  );
  const fingerprint = fingerprintState(state);

  return {
    state,
    returnTo,
    cookieName: oauthCookieNameFromFingerprint(fingerprint),
    cookieValue: fingerprint.toString("base64url"),
  };
}

export function getDiscordOAuthSlotCookieName(state: string | null): string | null {
  if (!state || !OAUTH_STATE_TOKEN_PATTERN.test(state)) {
    return null;
  }
  return oauthCookieNameFromFingerprint(fingerprintState(state));
}

export function verifyDiscordOAuthAttempt(
  returnedState: string | null,
  cookieValue: string | null,
  clientSecret: string,
  nowMilliseconds = Date.now(),
): { returnTo: string } | null {
  if (
    !returnedState ||
    !cookieValue ||
    !clientSecret ||
    !OAUTH_STATE_TOKEN_PATTERN.test(returnedState) ||
    !OAUTH_COOKIE_FINGERPRINT_PATTERN.test(cookieValue) ||
    !Number.isFinite(nowMilliseconds)
  ) {
    return null;
  }

  const encoded = Buffer.from(returnedState, "base64url");
  const minimumLength = OAUTH_STATE_HEADER_BYTES + 1 + OAUTH_STATE_SIGNATURE_BYTES;
  const maximumLength =
    OAUTH_STATE_HEADER_BYTES + OAUTH_RETURN_PATH_MAX_BYTES + OAUTH_STATE_SIGNATURE_BYTES;
  if (encoded.length < minimumLength || encoded.length > maximumLength) {
    return null;
  }

  const payload = encoded.subarray(0, encoded.length - OAUTH_STATE_SIGNATURE_BYTES);
  const signature = encoded.subarray(encoded.length - OAUTH_STATE_SIGNATURE_BYTES);
  const expectedSignature = signPayload(payload, clientSecret);
  if (
    signature.length !== expectedSignature.length ||
    !timingSafeEqual(signature, expectedSignature)
  ) {
    return null;
  }

  if (payload.readUInt8(0) !== OAUTH_STATE_VERSION) {
    return null;
  }

  const issuedAtSeconds = payload.readUInt32BE(1);
  const nowSeconds = Math.floor(nowMilliseconds / 1000);
  if (
    issuedAtSeconds > nowSeconds + OAUTH_STATE_FUTURE_SKEW_SECONDS ||
    nowSeconds - issuedAtSeconds > OAUTH_STATE_MAX_AGE_SECONDS
  ) {
    return null;
  }

  const returnLength = payload.readUInt16BE(5 + OAUTH_STATE_NONCE_BYTES);
  if (
    returnLength < 1 ||
    returnLength > OAUTH_RETURN_PATH_MAX_BYTES ||
    payload.length !== OAUTH_STATE_HEADER_BYTES + returnLength
  ) {
    return null;
  }

  const expectedFingerprint = fingerprintState(returnedState).toString("base64url");
  const expectedBuffer = Buffer.from(expectedFingerprint, "utf8");
  const actualBuffer = Buffer.from(cookieValue, "utf8");
  if (
    expectedBuffer.length !== actualBuffer.length ||
    !timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    return null;
  }

  const returnTo = safeReturnPath(
    payload.subarray(OAUTH_STATE_HEADER_BYTES).toString("utf8"),
  );
  return { returnTo };
}
