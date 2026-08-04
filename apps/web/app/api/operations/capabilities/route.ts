import { NextResponse } from "next/server";
import {
  canReadConsoleDuringRollout,
  getConsoleSession,
} from "../../../../lib/console-auth";
import { getOperationCapabilities } from "../../../../lib/operation-catalog";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getConsoleSession();
  if (!canReadConsoleDuringRollout(session)) {
    return NextResponse.json(
      { error: "console_access_denied" },
      {
        status: 403,
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }

  return NextResponse.json(
    {
      mode: session.mode,
      status: session.status,
      role: session.role,
      executionEnabled: false,
      operations: getOperationCapabilities(session),
    },
    {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
