import type {
  ReliabilityBackupType,
  ReliabilityMaintenanceScopeType,
  ReliabilitySloServiceId,
} from "./reliability-types";

export const RELIABILITY_SLO_SERVICE_IDS = [
  "overall",
  "host",
  "container",
  "backup",
] as const satisfies readonly ReliabilitySloServiceId[];

export const RELIABILITY_MAINTENANCE_SCOPE_TYPES = [
  "service",
  "host",
  "container",
  "backup",
] as const satisfies readonly ReliabilityMaintenanceScopeType[];

export const RELIABILITY_BACKUP_TYPES = [
  "world",
  "config",
  "permissions",
  "full",
] as const satisfies readonly ReliabilityBackupType[];

export const RELIABILITY_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const RELIABILITY_DISCORD_SNOWFLAKE_PATTERN = /^[0-9]{17,20}$/;
export const RELIABILITY_CONTAINER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const RELIABILITY_TARGET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function isReliabilitySloServiceId(value: unknown): value is ReliabilitySloServiceId {
  return (
    typeof value === "string" &&
    (RELIABILITY_SLO_SERVICE_IDS as readonly string[]).includes(value)
  );
}

export function isReliabilityMaintenanceScopeType(
  value: unknown,
): value is ReliabilityMaintenanceScopeType {
  return (
    typeof value === "string" &&
    (RELIABILITY_MAINTENANCE_SCOPE_TYPES as readonly string[]).includes(value)
  );
}

export function isReliabilityBackupType(value: unknown): value is ReliabilityBackupType {
  return (
    typeof value === "string" &&
    (RELIABILITY_BACKUP_TYPES as readonly string[]).includes(value)
  );
}
