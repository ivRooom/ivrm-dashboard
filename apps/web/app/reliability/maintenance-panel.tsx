import type {
  ReliabilityMaintenanceTargetCatalog,
  ReliabilityMaintenanceWindow,
  ReliabilityRange,
  ReliabilitySloServiceId,
} from "../../lib/reliability";
import { ReliabilityMaintenanceForm } from "./maintenance-form";
import styles from "./reliability.module.css";

type Props = {
  windows: ReliabilityMaintenanceWindow[];
  dataAvailable: boolean;
  canManage: boolean;
  targets: ReliabilityMaintenanceTargetCatalog | null;
  targetsDataAvailable: boolean;
  range: ReliabilityRange;
  outcome: string | null;
  generatedAt: string;
};

type WindowStatus = "active" | "upcoming" | "ended" | "cancelled";

const SERVICE_LABELS: Record<ReliabilitySloServiceId, string> = {
  overall: "Overall Reliability",
  host: "Host Platform",
  container: "Container Runtime",
  backup: "Backup Protection",
};

const OUTCOME_MESSAGES: Record<string, string> = {
  created: "Maintenance Windowを登録しました。",
  cancelled: "Maintenance Windowを取り消しました。取消時刻以降はSLO除外されません。",
  target_invalid: "Maintenance対象が不正です。最新の対象一覧から選択してください。",
  time_invalid: "開始・終了日時が不正です。過去5分より前の後付け登録や7日超のWindowは作成できません。",
  reason_invalid: "理由は1〜200文字で入力してください。",
  acknowledgement_required: "SLO計算だけから除外することへの確認が必要です。",
  window_invalid: "Maintenance Window IDが不正です。",
  mutation_failed: "Maintenance Windowの更新に失敗しました。DB接続または対象状態を確認してください。",
};

function dateTime(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Tokyo",
  }).format(new Date(value));
}

function localDateTimeInput(value: Date): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Tokyo",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function effectiveEnd(window: ReliabilityMaintenanceWindow): number {
  return Math.min(
    Date.parse(window.endsAt),
    window.cancelledAt ? Date.parse(window.cancelledAt) : Number.POSITIVE_INFINITY,
  );
}

function windowStatus(window: ReliabilityMaintenanceWindow, now: number): WindowStatus {
  if (window.cancelledAt) return "cancelled";
  const start = Date.parse(window.startsAt);
  const end = effectiveEnd(window);
  if (start <= now && now < end) return "active";
  if (now < start) return "upcoming";
  return "ended";
}

function statusLabel(status: WindowStatus): string {
  switch (status) {
    case "active": return "Active";
    case "upcoming": return "Upcoming";
    case "ended": return "Ended";
    case "cancelled": return "Cancelled";
  }
}

function targetLabel(window: ReliabilityMaintenanceWindow): string {
  switch (window.scopeType) {
    case "service":
      return window.serviceId ? SERVICE_LABELS[window.serviceId] : "Service";
    case "host":
      return `${window.hostDisplayName ?? window.serverId ?? "Host"}${window.serverId && window.hostDisplayName ? ` / ${window.serverId}` : ""}`;
    case "container":
      return `${window.hostDisplayName ?? window.serverId ?? "Host"} / ${window.containerName ?? "Container"}`;
    case "backup":
      return `${window.hostDisplayName ?? window.serverId ?? "Host"} / ${window.backupTarget ?? "Backup"} / ${window.gameMode ?? "-"} / ${window.backupType ?? "-"}`;
  }
}

function scopeDescription(window: ReliabilityMaintenanceWindow): string {
  switch (window.scopeType) {
    case "service":
      return window.serviceId === "overall"
        ? "全SLO対象Incident"
        : `${SERVICE_LABELS[window.serviceId ?? "overall"]}の全Incident`;
    case "host":
      return "このHostと配下Container / BackupのIncident";
    case "container":
      return "このContainerのIncidentのみ";
    case "backup":
      return "このBackup TargetのIncidentのみ";
  }
}

function statusClass(status: WindowStatus): string {
  switch (status) {
    case "active": return styles.maintenanceActive;
    case "upcoming": return styles.maintenanceUpcoming;
    case "ended": return styles.maintenanceEnded;
    case "cancelled": return styles.maintenanceCancelled;
  }
}

export function ReliabilityMaintenancePanel({
  windows,
  dataAvailable,
  canManage,
  targets,
  targetsDataAvailable,
  range,
  outcome,
  generatedAt,
}: Props) {
  const generatedAtMs = Date.parse(generatedAt);
  const defaultStart = new Date(generatedAtMs + 15 * 60_000);
  const defaultEnd = new Date(generatedAtMs + 75 * 60_000);
  const message = outcome ? OUTCOME_MESSAGES[outcome] ?? null : null;

  const ordered = [...windows].sort((left, right) => {
    const rank = (status: WindowStatus) =>
      status === "active" ? 0 : status === "upcoming" ? 1 : status === "ended" ? 2 : 3;
    const leftStatus = windowStatus(left, generatedAtMs);
    const rightStatus = windowStatus(right, generatedAtMs);
    const byStatus = rank(leftStatus) - rank(rightStatus);
    if (byStatus !== 0) return byStatus;
    if (leftStatus === "ended" || leftStatus === "cancelled") {
      return effectiveEnd(right) - effectiveEnd(left);
    }
    return Date.parse(left.startsAt) - Date.parse(right.startsAt);
  });

  const visible = ordered.slice(0, 24);
  const activeCount = windows.filter(
    (window) => windowStatus(window, generatedAtMs) === "active",
  ).length;
  const upcomingCount = windows.filter(
    (window) => windowStatus(window, generatedAtMs) === "upcoming",
  ).length;

  return (
    <section id="maintenance-windows" aria-labelledby="maintenance-windows-title">
      <div className={styles.sectionTitle}>
        <div>
          <span>PLANNED MAINTENANCE</span>
          <h2 id="maintenance-windows-title">SLO Maintenance Windows</h2>
        </div>
        <p>
          計画停止は該当Incidentとの重複区間だけをSLO計算から除外します。Raw IncidentとRaw Downtimeは変更しません。
        </p>
      </div>

      {!dataAvailable ? (
        <div className={styles.coverage} role="status">
          Maintenance Windowを取得できないため、計画停止を0秒と仮定せず、設定済みSLOの計算をData unavailableにしています。Raw Reliabilityは継続表示します。
        </div>
      ) : null}

      {message ? (
        <div
          className={
            outcome === "created" || outcome === "cancelled"
              ? styles.policySuccess
              : styles.policyError
          }
          role="status"
        >
          {message}
        </div>
      ) : null}

      <div className={styles.maintenanceSummary}>
        <div><span>ACTIVE</span><strong>{activeCount}</strong></div>
        <div><span>UPCOMING</span><strong>{upcomingCount}</strong></div>
        <div><span>LOADED</span><strong>{windows.length}</strong></div>
        <div><span>POLICY</span><strong>Scoped only</strong></div>
      </div>

      {canManage ? (
        <details className={styles.maintenanceCreate} open={outcome !== null && outcome !== "cancelled"}>
          <summary>Maintenance Windowを登録</summary>
          {!targetsDataAvailable || !targets ? (
            <div className={styles.coverage} role="status">
              対象Host / Container / Backup一覧を取得できないため、新規登録フォームを無効化しています。既存Windowの表示・取消には影響しません。
            </div>
          ) : (
            <ReliabilityMaintenanceForm
              catalog={targets}
              defaultEndsAt={localDateTimeInput(defaultEnd)}
              defaultStartsAt={localDateTimeInput(defaultStart)}
              range={range}
            />
          )}
        </details>
      ) : null}

      {visible.length === 0 ? (
        <div className={styles.maintenanceEmpty}>
          <strong>Maintenance Windowはありません</strong>
          <p>計画停止を登録していない期間は、SLO-counted DowntimeとRaw Downtimeが一致します。</p>
        </div>
      ) : (
        <div className={styles.maintenanceGrid}>
          {visible.map((window) => {
            const status = windowStatus(window, generatedAtMs);
            const cancellable =
              canManage &&
              !window.cancelledAt &&
              Date.parse(window.endsAt) > generatedAtMs;
            return (
              <article className={styles.maintenanceCard} key={window.id}>
                <div className={styles.maintenanceHead}>
                  <div>
                    <span>{window.scopeType.toUpperCase()}</span>
                    <h3>{targetLabel(window)}</h3>
                    <small>{scopeDescription(window)}</small>
                  </div>
                  <span className={`${styles.badge} ${statusClass(status)}`}>
                    {statusLabel(status)}
                  </span>
                </div>

                <p className={styles.maintenanceReason}>{window.reason}</p>
                <dl className={styles.maintenanceTimes}>
                  <div><dt>START</dt><dd>{dateTime(window.startsAt)} JST</dd></div>
                  <div><dt>END</dt><dd>{dateTime(window.endsAt)} JST</dd></div>
                  {window.cancelledAt ? (
                    <div><dt>CANCELLED</dt><dd>{dateTime(window.cancelledAt)} JST</dd></div>
                  ) : null}
                </dl>

                {cancellable ? (
                  <form action="/api/reliability/maintenance" method="post">
                    <input name="action" type="hidden" value="cancel" />
                    <input name="windowId" type="hidden" value={window.id} />
                    <input name="range" type="hidden" value={range} />
                    <button type="submit">このWindowを取り消す</button>
                  </form>
                ) : null}
              </article>
            );
          })}
        </div>
      )}

      {ordered.length > visible.length ? (
        <p className={styles.maintenanceFootnote}>
          表示量を抑えるため最新・進行中の24件を表示しています。SLO計算には取得済みの全Windowを使用します。
        </p>
      ) : null}
    </section>
  );
}
