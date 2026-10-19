import type { ConsoleLogEntry } from "./logs";

export type LogExportFormat = "txt" | "jsonl";

// Only the fields already available in the authorized log viewer are exported.
export function serializeLogEntries(entries: readonly ConsoleLogEntry[], format: LogExportFormat): string {
  return entries.map((entry) => format === "jsonl"
    ? JSON.stringify({
      id: entry.id, observedAt: entry.observedAt, receivedAt: entry.receivedAt,
      serverId: entry.serverId, sourceType: entry.sourceType, sourceName: entry.sourceName,
      level: entry.level, message: entry.message,
    })
    : `${entry.observedAt} [${entry.serverId}/${entry.sourceName}] [${entry.level}] ${entry.message}`,
  ).join("\n") + (entries.length ? "\n" : "");
}
