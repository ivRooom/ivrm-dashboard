export const CONSOLE_LOG_SOURCES = [
  { type: "container", name: "mc-main", label: "Minecraft / mc-main" },
  { type: "container", name: "mc-block", label: "Minecraft / mc-block" },
  { type: "container", name: "ivrm-velocity", label: "Velocity" },
  { type: "container", name: "mc-resource", label: "Resource Server" },
  { type: "container", name: "mc-resource-router", label: "Resource Router" },
  { type: "systemd", name: "ivrm-agent", label: "IVRM Agent" },
] as const;

export const CONSOLE_LOG_LEVELS = [
  "debug",
  "info",
  "warning",
  "error",
  "critical",
] as const;

export type ConsoleLogSource = (typeof CONSOLE_LOG_SOURCES)[number];
export type ConsoleLogSourceType = ConsoleLogSource["type"];
export type ConsoleLogSourceName = ConsoleLogSource["name"];
export type ConsoleLogLevel = (typeof CONSOLE_LOG_LEVELS)[number];

const sourceByName = new Map<ConsoleLogSourceName, ConsoleLogSource>(
  CONSOLE_LOG_SOURCES.map((source) => [source.name, source] as const),
);
const levels = new Set<string>(CONSOLE_LOG_LEVELS);

export function isConsoleLogSourceName(value: string): value is ConsoleLogSourceName {
  return sourceByName.has(value as ConsoleLogSourceName);
}

export function getConsoleLogSource(value: string): ConsoleLogSource | null {
  return sourceByName.get(value as ConsoleLogSourceName) ?? null;
}

export function isConsoleLogLevel(value: string): value is ConsoleLogLevel {
  return levels.has(value);
}
