import { createHash } from "node:crypto";
import { constantTimeEqual } from "./discord-auth";

const OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const STATE_COOKIE_PREFIX = "__Host-ivrm_discord_oauth_state_";
const RETURN_COOKIE_PREFIX = "__Host-ivrm_discord_oauth_return_";

export type DiscordOAuthCookieNames = {
  state: string;
  returnTo: string;
};

export function getDiscordOAuthCookieNames(
  state: string | null,
): DiscordOAuthCookieNames | null {
  if (!state || !OAUTH_STATE_PATTERN.test(state)) {
    return null;
  }

  const fingerprint = createHash("sha256")
    .update(state, "utf8")
    .digest("hex")
    .slice(0, 32);

  return {
    state: `${STATE_COOKIE_PREFIX}${fingerprint}`,
    returnTo: `${RETURN_COOKIE_PREFIX}${fingerprint}`,
  };
}

export function matchesDiscordOAuthStateCookie(
  returnedState: string | null,
  cookieValue: string | null,
): boolean {
  if (!returnedState || !cookieValue || !OAUTH_STATE_PATTERN.test(returnedState)) {
    return false;
  }

  return constantTimeEqual(returnedState, cookieValue);
}
