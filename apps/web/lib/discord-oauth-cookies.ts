import { createHash } from "node:crypto";
import { constantTimeEqual } from "./discord-auth";

const OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const OAUTH_STATE_COOKIE_VALUE_PATTERN = /^([0-9]{10,13})\.([A-Za-z0-9_-]{32,256})$/;
const COOKIE_FINGERPRINT_PATTERN = /^[0-9a-f]{32}$/;
const STATE_COOKIE_PREFIX = "__Host-ivrm_discord_oauth_state_";
const RETURN_COOKIE_PREFIX = "__Host-ivrm_discord_oauth_return_";

export const MAX_DISCORD_OAUTH_ATTEMPTS = 3;

export type DiscordOAuthCookieNames = {
  state: string;
  returnTo: string;
};

type CookieLike = {
  name: string;
  value: string;
};

type ParsedStateCookie = {
  state: string;
  issuedAtSeconds: number;
};

function stateFingerprint(state: string): string {
  return createHash("sha256")
    .update(state, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function parseStateCookieValue(value: string | null): ParsedStateCookie | null {
  if (!value) {
    return null;
  }

  // Branch上で一時的に発行した旧形式Cookieも安全に消費・整理できるようにする。
  if (OAUTH_STATE_PATTERN.test(value)) {
    return { state: value, issuedAtSeconds: 0 };
  }

  const match = OAUTH_STATE_COOKIE_VALUE_PATTERN.exec(value);
  if (!match) {
    return null;
  }

  const issuedAtSeconds = Number(match[1]);
  if (!Number.isSafeInteger(issuedAtSeconds) || issuedAtSeconds < 0) {
    return null;
  }

  return {
    state: match[2],
    issuedAtSeconds,
  };
}

function isManagedCookieName(name: string, prefix: string): boolean {
  if (!name.startsWith(prefix)) {
    return false;
  }
  return COOKIE_FINGERPRINT_PATTERN.test(name.slice(prefix.length));
}

export function getDiscordOAuthCookieNames(
  state: string | null,
): DiscordOAuthCookieNames | null {
  if (!state || !OAUTH_STATE_PATTERN.test(state)) {
    return null;
  }

  const fingerprint = stateFingerprint(state);
  return {
    state: `${STATE_COOKIE_PREFIX}${fingerprint}`,
    returnTo: `${RETURN_COOKIE_PREFIX}${fingerprint}`,
  };
}

export function encodeDiscordOAuthStateCookie(
  state: string,
  issuedAtMilliseconds = Date.now(),
): string {
  if (!OAUTH_STATE_PATTERN.test(state)) {
    throw new Error("Discord OAuth stateが不正です");
  }
  if (!Number.isFinite(issuedAtMilliseconds) || issuedAtMilliseconds < 0) {
    throw new Error("Discord OAuth stateの発行時刻が不正です");
  }

  return `${Math.floor(issuedAtMilliseconds / 1000)}.${state}`;
}

export function getDiscordOAuthCookieNamesToPrune(
  cookies: readonly CookieLike[],
  maximumRetainedAttempts = MAX_DISCORD_OAUTH_ATTEMPTS - 1,
): string[] {
  if (
    !Number.isSafeInteger(maximumRetainedAttempts) ||
    maximumRetainedAttempts < 0 ||
    maximumRetainedAttempts > MAX_DISCORD_OAUTH_ATTEMPTS
  ) {
    throw new Error("Discord OAuth Cookie保持数が不正です");
  }

  const attempts = cookies
    .filter((cookie) => isManagedCookieName(cookie.name, STATE_COOKIE_PREFIX))
    .map((cookie) => {
      const parsed = parseStateCookieValue(cookie.value);
      const cookieNames = parsed ? getDiscordOAuthCookieNames(parsed.state) : null;
      if (!parsed || !cookieNames || cookieNames.state !== cookie.name) {
        return null;
      }
      return {
        ...cookieNames,
        issuedAtSeconds: parsed.issuedAtSeconds,
      };
    })
    .filter((attempt): attempt is DiscordOAuthCookieNames & { issuedAtSeconds: number } =>
      attempt !== null,
    )
    .sort((left, right) =>
      right.issuedAtSeconds - left.issuedAtSeconds || left.state.localeCompare(right.state),
    );

  const retainedNames = new Set<string>();
  for (const attempt of attempts.slice(0, maximumRetainedAttempts)) {
    retainedNames.add(attempt.state);
    retainedNames.add(attempt.returnTo);
  }

  const managedNames = new Set(
    cookies
      .map((cookie) => cookie.name)
      .filter(
        (name) =>
          isManagedCookieName(name, STATE_COOKIE_PREFIX) ||
          isManagedCookieName(name, RETURN_COOKIE_PREFIX),
      ),
  );

  return [...managedNames].filter((name) => !retainedNames.has(name));
}

export function matchesDiscordOAuthStateCookie(
  returnedState: string | null,
  cookieValue: string | null,
): boolean {
  if (!returnedState || !OAUTH_STATE_PATTERN.test(returnedState)) {
    return false;
  }

  const parsed = parseStateCookieValue(cookieValue);
  return parsed ? constantTimeEqual(returnedState, parsed.state) : false;
}
