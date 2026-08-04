import { headers } from "next/headers";
import {
  ACCESS_HEADERS,
  getAccessMode,
  type AccessMode,
  type AccessState,
} from "./cloudflare-access";

export type ConsoleRole = "viewer" | "operator" | "administrator" | "owner";

export type ConsoleSessionStatus =
  | "disabled"
  | "unauthenticated"
  | "unregistered"
  | "inactive"
  | "identity_mismatch"
  | "authenticated"
  | "error";

export type ConsoleSession = {
  mode: AccessMode;
  accessState: AccessState;
  status: ConsoleSessionStatus;
  email: string | null;
  displayName: string | null;
  role: ConsoleRole | null;
};

type HeaderReader = {
  get(name: string): string | null;
};

type ConsoleUserRow = {
  id: string;
  access_subject: string;
  email: string;
  display_name: string | null;
  role: ConsoleRole;
  is_active: boolean;
};

const ROLE_RANK: Record<ConsoleRole, number> = {
  viewer: 0,
  operator: 1,
  administrator: 2,
  owner: 3,
};

const ACCESS_STATES: AccessState[] = [
  "disabled",
  "config_missing",
  "missing",
  "invalid",
  "verified",
];

function isAccessState(value: string | null): value is AccessState {
  return value !== null && ACCESS_STATES.includes(value as AccessState);
}

function isConsoleRole(value: unknown): value is ConsoleRole {
  return (
    value === "viewer" ||
    value === "operator" ||
    value === "administrator" ||
    value === "owner"
  );
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name}が設定されていません`);
  }
  return value;
}

function supabaseConfiguration(): { url: string; serviceRoleKey: string } {
  return {
    url: requireEnvironment("SUPABASE_URL").replace(/\/$/, ""),
    serviceRoleKey: requireEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

function parseConsoleUser(value: unknown): ConsoleUserRow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    typeof row.access_subject !== "string" ||
    typeof row.email !== "string" ||
    (row.display_name !== null && typeof row.display_name !== "string") ||
    !isConsoleRole(row.role) ||
    typeof row.is_active !== "boolean"
  ) {
    return null;
  }
  return {
    id: row.id,
    access_subject: row.access_subject,
    email: row.email,
    display_name: row.display_name as string | null,
    role: row.role,
    is_active: row.is_active,
  };
}

async function findConsoleUser(subject: string): Promise<ConsoleUserRow | null> {
  const { url, serviceRoleKey } = supabaseConfiguration();
  const path =
    "/rest/v1/console_users" +
    "?select=id,access_subject,email,display_name,role,is_active" +
    `&access_subject=eq.${encodeURIComponent(subject)}` +
    "&limit=1";
  const response = await fetch(`${url}${path}`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Accept: "application/json",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`Supabase Console User APIが${response.status}を返しました`);
  }
  const body = (await response.json()) as unknown;
  if (!Array.isArray(body) || body.length > 1) {
    throw new Error("Console Userレスポンスが不正です");
  }
  if (body.length === 0) {
    return null;
  }
  const user = parseConsoleUser(body[0]);
  if (!user) {
    throw new Error("Console Userデータが不正です");
  }
  return user;
}

export async function getConsoleSessionFromHeaders(
  headerReader: HeaderReader,
): Promise<ConsoleSession> {
  let mode: AccessMode;
  try {
    const headerMode = headerReader.get(ACCESS_HEADERS.mode);
    mode =
      headerMode === "disabled" || headerMode === "report" || headerMode === "enforce"
        ? headerMode
        : getAccessMode();
  } catch {
    return {
      mode: "enforce",
      accessState: "config_missing",
      status: "error",
      email: null,
      displayName: null,
      role: null,
    };
  }

  const rawAccessState = headerReader.get(ACCESS_HEADERS.state);
  const accessState = isAccessState(rawAccessState)
    ? rawAccessState
    : mode === "disabled"
      ? "disabled"
      : "missing";
  if (mode === "disabled") {
    return {
      mode,
      accessState,
      status: "disabled",
      email: null,
      displayName: null,
      role: null,
    };
  }

  const subject = headerReader.get(ACCESS_HEADERS.subject)?.trim() || null;
  const email = headerReader.get(ACCESS_HEADERS.email)?.trim().toLowerCase() || null;
  if (accessState !== "verified" || !subject || !email) {
    return {
      mode,
      accessState,
      status: "unauthenticated",
      email: null,
      displayName: null,
      role: null,
    };
  }

  try {
    const user = await findConsoleUser(subject);
    if (!user) {
      return {
        mode,
        accessState,
        status: "unregistered",
        email,
        displayName: null,
        role: null,
      };
    }
    if (user.email !== email || user.access_subject !== subject) {
      return {
        mode,
        accessState,
        status: "identity_mismatch",
        email,
        displayName: null,
        role: null,
      };
    }
    if (!user.is_active) {
      return {
        mode,
        accessState,
        status: "inactive",
        email,
        displayName: user.display_name,
        role: null,
      };
    }
    return {
      mode,
      accessState,
      status: "authenticated",
      email,
      displayName: user.display_name,
      role: user.role,
    };
  } catch {
    return {
      mode,
      accessState,
      status: "error",
      email,
      displayName: null,
      role: null,
    };
  }
}

export async function getConsoleSession(): Promise<ConsoleSession> {
  return getConsoleSessionFromHeaders(await headers());
}

export function hasConsoleRole(
  session: ConsoleSession,
  minimumRole: ConsoleRole,
): boolean {
  return (
    session.status === "authenticated" &&
    session.role !== null &&
    ROLE_RANK[session.role] >= ROLE_RANK[minimumRole]
  );
}

export function canReadConsoleDuringRollout(session: ConsoleSession): boolean {
  if (session.mode !== "enforce") {
    return true;
  }
  return hasConsoleRole(session, "viewer");
}

export function canPerformConsoleAction(
  session: ConsoleSession,
  minimumRole: ConsoleRole,
): boolean {
  return hasConsoleRole(session, minimumRole);
}
