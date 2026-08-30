import { NextResponse } from "next/server";
import { getPublicStatusFeed } from "../../../../lib/status-public-feed";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  try {
    const feed = await getPublicStatusFeed();
    return NextResponse.json(feed, {
      headers: {
        "Cache-Control": "public, max-age=15, stale-while-revalidate=60",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (error) {
    console.error("Public Status Feed生成に失敗しました", error);
    return NextResponse.json(
      { error: "status_feed_unavailable" },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }
}
