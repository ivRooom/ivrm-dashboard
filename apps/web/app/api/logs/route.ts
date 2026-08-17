import { NextResponse } from "next/server";
import {
  canReadConsoleDuringRollout,
  getConsoleSession,
} from "../../../lib/console-auth";
import {
  isConsoleLogLevel,
  isConsoleLogSourceName,
} from "../../../lib/console-log-types";
import { ConsoleLogsError, getConsoleLogs } from "../../../lib/logs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_SERVER_ID = "oci-minecraft-01";

function parseOptionalInteger(value: string | null): number | null {
  if (value === null || value === "") return null;
  if (!/^\d+$/.test(value)) throw new ConsoleLogsError("invalid_query");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ConsoleLogsError("invalid_query");
  return parsed;
}

export async function GET(request: Request) {
  const session = await getConsoleSession();
  if (!canReadConsoleDuringRollout(session)) {
    return NextResponse.json(
      { error: "forbidden" },
      {
        status: 403,
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }

  try {
    const url = new URL(request.url);
    const serverId = url.searchParams.get("server") || DEFAULT_SERVER_ID;
    const sourceValue = url.searchParams.get("source");
    const levelValue = url.searchParams.get("level");
    const query = url.searchParams.get("q")?.trim() || null;
    const afterId = parseOptionalInteger(url.searchParams.get("after"));
    const limitValue = parseOptionalInteger(url.searchParams.get("limit"));

    if (
      !/^[A-Za-z0-9._-]{1,64}$/.test(serverId) ||
      (sourceValue !== null && !isConsoleLogSourceName(sourceValue)) ||
      (levelValue !== null && !isConsoleLogLevel(levelValue)) ||
      (query !== null && query.length > 80) ||
      (limitValue !== null && (limitValue < 1 || limitValue > 200))
    ) {
      throw new ConsoleLogsError("invalid_query");
    }

    const entries = await getConsoleLogs({
      serverId,
      sourceName: sourceValue,
      level: levelValue,
      query,
      afterId,
      limit: limitValue ?? 200,
    });

    return NextResponse.json(
      {
        entries,
        lastId: entries.at(-1)?.id ?? afterId ?? 0,
        polledAt: new Date().toISOString(),
      },
      {
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch (error) {
    if (error instanceof ConsoleLogsError) {
      return NextResponse.json(
        { error: error.code },
        {
          status: error.code === "invalid_query" ? 400 : 503,
          headers: {
            "Cache-Control": "private, no-store, max-age=0",
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
    }

    console.error("Console Log Read APIで予期しないエラーが発生しました");
    return NextResponse.json(
      { error: "internal_error" },
      {
        status: 500,
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }
}
