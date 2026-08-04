import { NextResponse } from "next/server";
import {
  canReadConsoleDuringRollout,
  getConsoleSession,
} from "../../../../lib/console-auth";
import { getMinecraftOverview } from "../../../../lib/minecraft";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getConsoleSession();
  if (!canReadConsoleDuringRollout(session)) {
    return NextResponse.json(
      { error: "access_denied" },
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
    const overview = await getMinecraftOverview();
    return NextResponse.json(overview, {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
      },
    });
  } catch (error) {
    console.error("Minecraft総合状態の取得に失敗しました", error);
    return NextResponse.json(
      { error: "minecraft_overview_unavailable" },
      {
        status: 503,
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
        },
      },
    );
  }
}
