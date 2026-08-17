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

export const CONSOLE_LOG_RANGES = [
  { value: "5m", label: "5分", minutes: 5 },
  { value: "15m", label: "15分", minutes: 15 },
  { value: "1h", label: "1時間", minutes: 60 },
  { value: "6h", label: "6時間", minutes: 360 },
  { value: "24h", label: "24時間", minutes: 1440 },
] as const;

export const CONSOLE_LOG_INITIAL_LIMITS = [100, 300, 500] as const;

export type ConsoleLogSource = (typeof CONSOLE_LOG_SOURCES)[number];
export type ConsoleLogSourceType = ConsoleLogSource["type"];
export type ConsoleLogSourceName = ConsoleLogSource["name"];
export type ConsoleLogLevel = (typeof CONSOLE_LOG_LEVELS)[number];
export type ConsoleLogRange = (typeof CONSOLE_LOG_RANGES)[number]["value"];
export type ConsoleLogInitialLimit = (typeof CONSOLE_LOG_INITIAL_LIMITS)[number];

const sourceByName = new Map<ConsoleLogSourceName, ConsoleLogSource>(
  CONSOLE_LOG_SOURCES.map((source) => [source.name, source] as const),
);
const levels = new Set<string>(CONSOLE_LOG_LEVELS);
const rangeByValue = new Map<ConsoleLogRange, (typeof CONSOLE_LOG_RANGES)[number]>(
  CONSOLE_LOG_RANGES.map((range) => [range.value, range] as const),
);
const initialLimits = new Set<number>(CONSOLE_LOG_INITIAL_LIMITS);

export function isConsoleLogSourceName(value: string): value is ConsoleLogSourceName {
  return sourceByName.has(value as ConsoleLogSourceName);
}

export function getConsoleLogSource(value: string): ConsoleLogSource | null {
  return sourceByName.get(value as ConsoleLogSourceName) ?? null;
}

export function isConsoleLogLevel(value: string): value is ConsoleLogLevel {
  return levels.has(value);
}

export function isConsoleLogRange(value: string): value is ConsoleLogRange {
  return rangeByValue.has(value as ConsoleLogRange);
}

export function getConsoleLogRangeMinutes(value: ConsoleLogRange): number {
  return rangeByValue.get(value)?.minutes ?? 1440;
}

export function isConsoleLogInitialLimit(value: number): value is ConsoleLogInitialLimit {
  return initialLimits.has(value);
}
