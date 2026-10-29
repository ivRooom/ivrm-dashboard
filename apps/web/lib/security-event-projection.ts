import type { DiscordAuthAuditRow } from "./discord-security-admin";

// Read-only adapter over existing, server-authorized audit rows. This is not the
// still-unratified operational-telemetry/v1 producer or an intrusion verdict.
export type ConsoleSecurityEvent = {
  eventId: string;
  occurredAt: string;
  service: "ivrm-dashboard";
  source: "discord-auth-audit";
  requestId: string;
  actor: { role: DiscordAuthAuditRow["actorRole"] };
  action: DiscordAuthAuditRow["action"];
  target: { kind: "discord-user" | "discord-session" };
  result: DiscordAuthAuditRow["result"];
  severity: "info" | "low" | "medium";
  ruleId: "console-audit-activity/v0";
  confidence: "observed-event-only";
  evidence: { source: "discord-auth-audit"; auditId: number };
};

export function projectDiscordAuthAuditEvent(row: DiscordAuthAuditRow): ConsoleSecurityEvent {
  const isSession = row.action.startsWith("DISCORD_SESSION_");
  const severity: ConsoleSecurityEvent["severity"] =
    row.action === "DISCORD_LOGIN_DENIED"
      ? "medium"
      : row.action === "DISCORD_SESSION_ADMIN_REVOKED"
        ? "low"
        : "info";

  // Deliberately omit usernames, Discord IDs, raw IPs, session/cookie values,
  // provider error fields and arbitrary metadata from this response.
  return {
    eventId: "discord-auth-audit:" + row.auditId,
    occurredAt: row.occurredAt,
    service: "ivrm-dashboard",
    source: "discord-auth-audit",
    requestId: row.requestId,
    actor: { role: row.actorRole },
    action: row.action,
    target: { kind: isSession ? "discord-session" : "discord-user" },
    result: row.result,
    severity,
    ruleId: "console-audit-activity/v0",
    confidence: "observed-event-only",
    evidence: { source: "discord-auth-audit", auditId: row.auditId },
  };
}
