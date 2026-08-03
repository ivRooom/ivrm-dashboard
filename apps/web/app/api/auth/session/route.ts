import { NextResponse } from "next/server";
import { getConsoleSession } from "../../../../lib/console-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getConsoleSession();
  return NextResponse.json(
    {
      mode: session.mode,
      accessState: session.accessState,
      status: session.status,
      email: session.email,
      displayName: session.displayName,
      role: session.role,
    },
    {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
