import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "ivrm-dashboard-web",
    timestamp: new Date().toISOString(),
  });
}
