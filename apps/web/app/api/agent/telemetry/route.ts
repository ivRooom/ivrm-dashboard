import pin from "../../../../../../contracts/ivrm/operational-telemetry.v1.pin.json";
import { parseTelemetrySecrets } from "../../../../lib/telemetry-core";
import { handleTelemetryRequest, persistTelemetry } from "../../../../lib/telemetry-ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // Candidate preparation cannot be activated using environment settings alone.
  // Repin a reviewed merged Contract before any separately approved rollout.
  return handleTelemetryRequest(request, {
    enabled: String(pin.releaseState) === "merged" && process.env.IVRM_TELEMETRY_INGEST_ENABLED === "true",
    secrets: () => parseTelemetrySecrets(process.env.IVRM_TELEMETRY_PRODUCER_SECRETS_JSON),
    persist: persistTelemetry,
  });
}
