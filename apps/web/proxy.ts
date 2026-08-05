import { NextResponse, type NextRequest } from "next/server";
import {
  ACCESS_HEADERS,
  getAccessConfiguration,
  getAccessMode,
  verifyCloudflareAccessJwt,
  type AccessState,
} from "./lib/cloudflare-access";
import {
  DISCORD_PUBLIC_ROUTE_HEADER,
  DISCORD_SESSION_COOKIE,
  getDiscordAuthMode,
  type DiscordAuthMode,
} from "./lib/discord-auth";

const PUBLIC_DISCORD_PATHS = new Set([
  "/login",
  "/api/auth/discord/start",
  "/api/auth/discord/callback",
  "/api/auth/logout",
]);

function isDiscordPublicRoute(pathname: string): boolean {
  return PUBLIC_DISCORD_PATHS.has(pathname);
}

function cleanRequestHeaders(request: NextRequest): Headers {
  const headers = new Headers(request.headers);
  for (const header of Object.values(ACCESS_HEADERS)) {
    headers.delete(header);
  }
  headers.delete(DISCORD_PUBLIC_ROUTE_HEADER);
  return headers;
}

function continueRequest(
  headers: Headers,
  mode: "disabled" | "report" | "enforce",
  state: AccessState,
): NextResponse {
  headers.set(ACCESS_HEADERS.mode, mode);
  headers.set(ACCESS_HEADERS.state, state);
  return NextResponse.next({ request: { headers } });
}

function accessError(
  request: NextRequest,
  status: 403 | 503,
  code: "access_denied" | "access_not_configured",
): NextResponse {
  const headers = {
    "Cache-Control": "private, no-store, max-age=0",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    "X-Content-Type-Options": "nosniff",
  };
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: code }, { status, headers });
  }
  const title = status === 503 ? "認証設定を確認してください" : "アクセスできません";
  const message =
    status === 503
      ? "管理コンソールの認証設定が完了していません。"
      : "Cloudflare Accessによる認証を確認できませんでした。";
  return new NextResponse(
    `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="margin:0;background:#07111f;color:#e8eef7;font-family:system-ui,sans-serif;display:grid;min-height:100vh;place-items:center"><main style="max-width:560px;padding:32px"><p style="letter-spacing:.12em;color:#8ba4c7">IVRM CONSOLE</p><h1>${title}</h1><p style="line-height:1.8;color:#b8c7dc">${message}</p></main></body></html>`,
    { status, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } },
  );
}

function discordAuthenticationRequired(request: NextRequest): NextResponse {
  const headers = {
    "Cache-Control": "private, no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
  };
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "discord_authentication_required" },
      { status: 401, headers },
    );
  }

  const returnTo = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("returnTo", returnTo);
  return NextResponse.redirect(loginUrl, { headers });
}

function discordModeOrError(): DiscordAuthMode | null {
  try {
    return getDiscordAuthMode();
  } catch {
    return null;
  }
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const requestHeaders = cleanRequestHeaders(request);
  const publicRoute = isDiscordPublicRoute(request.nextUrl.pathname);
  if (publicRoute) {
    requestHeaders.set(DISCORD_PUBLIC_ROUTE_HEADER, "1");
  }

  const discordMode = discordModeOrError();
  if (!discordMode) {
    if (publicRoute) {
      return continueRequest(requestHeaders, "disabled", "disabled");
    }
    return accessError(request, 503, "access_not_configured");
  }

  if (discordMode !== "disabled") {
    if (publicRoute) {
      return continueRequest(requestHeaders, "disabled", "disabled");
    }

    const hasSessionCookie = Boolean(
      request.cookies.get(DISCORD_SESSION_COOKIE)?.value,
    );
    if (hasSessionCookie) {
      return continueRequest(requestHeaders, "disabled", "disabled");
    }
    if (discordMode === "enforce") {
      return discordAuthenticationRequired(request);
    }
  }

  let mode: "disabled" | "report" | "enforce";
  try {
    mode = getAccessMode();
  } catch {
    return accessError(request, 503, "access_not_configured");
  }

  if (mode === "disabled") {
    return continueRequest(requestHeaders, mode, "disabled");
  }

  let configuration;
  try {
    configuration = getAccessConfiguration();
  } catch {
    if (mode === "enforce") {
      return accessError(request, 503, "access_not_configured");
    }
    return continueRequest(requestHeaders, mode, "config_missing");
  }
  if (!configuration) {
    if (mode === "enforce") {
      return accessError(request, 503, "access_not_configured");
    }
    return continueRequest(requestHeaders, mode, "config_missing");
  }

  const token = request.headers.get("cf-access-jwt-assertion")?.trim();
  if (!token) {
    if (mode === "enforce") {
      return accessError(request, 403, "access_denied");
    }
    return continueRequest(requestHeaders, mode, "missing");
  }

  try {
    const identity = await verifyCloudflareAccessJwt(token, configuration);
    requestHeaders.set(ACCESS_HEADERS.subject, identity.subject);
    requestHeaders.set(ACCESS_HEADERS.email, identity.email);
    return continueRequest(requestHeaders, mode, "verified");
  } catch {
    if (mode === "enforce") {
      return accessError(request, 403, "access_denied");
    }
    return continueRequest(requestHeaders, mode, "invalid");
  }
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|cdn-cgi/|api/health|api/agent/heartbeat).*)",
  ],
};
