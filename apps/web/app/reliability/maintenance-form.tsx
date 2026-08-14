"use client";

import { useMemo, useState } from "react";
import type {
  ReliabilityMaintenanceScopeType,
  ReliabilityMaintenanceTargetCatalog,
  ReliabilityRange,
} from "../../lib/reliability";
import styles from "./reliability.module.css";

type Props = {
  catalog: ReliabilityMaintenanceTargetCatalog;
  range: ReliabilityRange;
  defaultStartsAt: string;
  defaultEndsAt: string;
};

type TargetOption = {
  value: string;
  label: string;
};

const SCOPE_OPTIONS: Array<{
  value: ReliabilityMaintenanceScopeType;
  label: string;
}> = [
  { value: "container", label: "Container" },
  { value: "backup", label: "Backup Target" },
  { value: "host", label: "Host（配下サービスを含む）" },
  { value: "service", label: "Service（全体スコープ）" },
];

const SERVICE_TARGETS: TargetOption[] = [
  { value: "container", label: "Container Runtime" },
  { value: "backup", label: "Backup Protection" },
  { value: "host", label: "Host Platform" },
  { value: "overall", label: "Overall Reliability（全SLO対象）" },
];

function optionsFor(
  scopeType: ReliabilityMaintenanceScopeType,
  catalog: ReliabilityMaintenanceTargetCatalog,
): TargetOption[] {
  switch (scopeType) {
    case "service":
      return SERVICE_TARGETS;
    case "host":
      return catalog.hosts.map((host) => ({
        value: host.hostId,
        label: `${host.displayName} / ${host.serverId}`,
      }));
    case "container":
      return catalog.containers.map((container) => ({
        value: `${container.hostId}/${container.containerName}`,
        label: `${container.hostDisplayName} / ${container.containerName}`,
      }));
    case "backup":
      return catalog.backups.map((backup) => ({
        value: `${backup.hostId}/${backup.backupTarget}/${backup.gameMode}/${backup.backupType}`,
        label: `${backup.hostDisplayName} / ${backup.backupTarget} / ${backup.gameMode} / ${backup.backupType}`,
      }));
  }
}

function initialScope(catalog: ReliabilityMaintenanceTargetCatalog): ReliabilityMaintenanceScopeType {
  if (catalog.containers.length > 0) return "container";
  if (catalog.backups.length > 0) return "backup";
  if (catalog.hosts.length > 0) return "host";
  return "service";
}

export function ReliabilityMaintenanceForm({
  catalog,
  range,
  defaultStartsAt,
  defaultEndsAt,
}: Props) {
  const [scopeType, setScopeType] = useState<ReliabilityMaintenanceScopeType>(() =>
    initialScope(catalog),
  );
  const targetOptions = useMemo(
    () => optionsFor(scopeType, catalog),
    [catalog, scopeType],
  );
  const [targetKey, setTargetKey] = useState(() =>
    optionsFor(initialScope(catalog), catalog)[0]?.value ?? "",
  );

  function changeScope(next: ReliabilityMaintenanceScopeType) {
    const nextOptions = optionsFor(next, catalog);
    setScopeType(next);
    setTargetKey(nextOptions[0]?.value ?? "");
  }

  const broadScope =
    scopeType === "host" ||
    (scopeType === "service" && (targetKey === "overall" || targetKey === "host"));

  return (
    <form action="/api/reliability/maintenance" className={styles.maintenanceForm} method="post">
      <input name="action" type="hidden" value="create" />
      <input name="range" type="hidden" value={range} />

      <div className={styles.maintenanceFormGrid}>
        <label>
          <span>Scope</span>
          <select
            name="scopeType"
            onChange={(event) =>
              changeScope(event.target.value as ReliabilityMaintenanceScopeType)
            }
            value={scopeType}
          >
            {SCOPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Target</span>
          <select
            disabled={targetOptions.length === 0}
            name="targetKey"
            onChange={(event) => setTargetKey(event.target.value)}
            required
            value={targetKey}
          >
            {targetOptions.length === 0 ? (
              <option value="">利用可能な対象がありません</option>
            ) : null}
            {targetOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>開始（JST）</span>
          <input defaultValue={defaultStartsAt} name="startsAt" required type="datetime-local" />
        </label>

        <label>
          <span>終了（JST）</span>
          <input defaultValue={defaultEndsAt} name="endsAt" required type="datetime-local" />
        </label>
      </div>

      <label>
        <span>理由</span>
        <textarea
          maxLength={200}
          name="reason"
          placeholder="例: Minecraftバックエンドの計画更新"
          required
          rows={3}
        />
      </label>

      {broadScope ? (
        <div className={styles.maintenanceWarning} role="status">
          このScopeは複数のIncidentへ適用されます。対象外の実障害まで除外しないよう、より狭いContainer / Backup Target Scopeを優先してください。
        </div>
      ) : null}

      <label className={styles.maintenanceAcknowledge}>
        <input name="acknowledged" required type="checkbox" />
        <span>
          この期間を<strong>SLO計算からのみ</strong>計画停止として除外し、Raw Incident / Raw Downtimeは変更しないことを確認しました。
        </span>
      </label>

      <div className={styles.maintenanceSubmit}>
        <small>過去5分より前を開始時刻にした後付けWindowは登録できません。最大7日です。</small>
        <button disabled={targetOptions.length === 0} type="submit">
          Maintenance Windowを登録
        </button>
      </div>
    </form>
  );
}
