import { AutoRefresh } from "../../components/auto-refresh";
import {
  ActionLink,
  MetricCard,
  MetricGrid,
  PageHeader,
  SectionHeader,
  StatePanel,
  StatusBadge,
  TableShell,
} from "../../components/console-ui";
import {
  getStatusCenterOverview,
  type StatusCenterAnnouncement,
  type StatusCenterIncident,
  type StatusCenterMaintenance,
} from "../../lib/status-center";
import styles from "./status-center.module.css";

export const dynamic = "force-dynamic";

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function services(ids: string[]) {
  if (ids.length === 0) return <span className={styles.meta}>全体</span>;
  return (
    <span className={styles.serviceList}>
      {ids.map((id) => (
        <code className={styles.serviceCode} key={id}>{id}</code>
      ))}
    </span>
  );
}

function publicationTone(state: string) {
  if (state === "published") return "success" as const;
  if (state === "cancelled" || state === "archived") return "neutral" as const;
  return "warning" as const;
}

function impactTone(impact: StatusCenterIncident["impact"]) {
  if (impact === "critical") return "danger" as const;
  if (impact === "major" || impact === "minor") return "warning" as const;
  return "neutral" as const;
}

function IncidentTable({ incidents }: { incidents: StatusCenterIncident[] }) {
  if (incidents.length === 0) {
    return <StatePanel title="公開Incidentはまだありません">CMS基盤は利用可能です。次Phaseで作成・公開操作を追加します。</StatePanel>;
  }
  return (
    <TableShell label="Status Incident一覧">
      <table className={styles.table}>
        <thead><tr><th>Incident</th><th>状態</th><th>影響</th><th>対象</th><th>開始</th><th>公開</th></tr></thead>
        <tbody>
          {incidents.map((incident) => (
            <tr key={incident.publicId}>
              <td><span className={styles.primaryCell}><strong>{incident.title}</strong><small>{incident.publicId}</small></span></td>
              <td><StatusBadge tone={incident.lifecycleStatus === "resolved" ? "success" : "warning"}>{incident.lifecycleStatus}</StatusBadge></td>
              <td><StatusBadge tone={impactTone(incident.impact)}>{incident.impact}</StatusBadge></td>
              <td>{services(incident.affectedServiceIds)}</td>
              <td>{formatDateTime(incident.startedAt)}</td>
              <td><StatusBadge tone={publicationTone(incident.publicationState)}>{incident.publicationState}</StatusBadge></td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableShell>
  );
}

function MaintenanceTable({ maintenance }: { maintenance: StatusCenterMaintenance[] }) {
  if (maintenance.length === 0) {
    return <StatePanel title="公開Maintenanceはまだありません">公開NoticeとReliability SLO除外は別責務のまま関連付けられます。</StatePanel>;
  }
  return (
    <TableShell label="Status Maintenance一覧">
      <table className={styles.table}>
        <thead><tr><th>Maintenance</th><th>期間</th><th>対象</th><th>公開</th><th>Reliability</th></tr></thead>
        <tbody>
          {maintenance.map((item) => (
            <tr key={item.publicId}>
              <td><span className={styles.primaryCell}><strong>{item.title}</strong><small>{item.publicId}</small></span></td>
              <td><span className={styles.primaryCell}><span>{formatDateTime(item.startsAt)}</span><small>〜 {formatDateTime(item.endsAt)}</small></span></td>
              <td>{services(item.affectedServiceIds)}</td>
              <td><StatusBadge tone={publicationTone(item.publicationState)}>{item.publicationState}</StatusBadge></td>
              <td className={styles.meta}>{item.reliabilityWindowId ? "Linked" : "Not linked"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableShell>
  );
}

function AnnouncementTable({ announcements }: { announcements: StatusCenterAnnouncement[] }) {
  if (announcements.length === 0) {
    return <StatePanel title="Announcementはまだありません">予約公開・Archive用のデータモデルは準備済みです。</StatePanel>;
  }
  return (
    <TableShell label="Status Announcement一覧">
      <table className={styles.table}>
        <thead><tr><th>Announcement</th><th>種別</th><th>公開予定</th><th>対象</th><th>公開</th></tr></thead>
        <tbody>
          {announcements.map((item) => (
            <tr key={item.publicId}>
              <td><span className={styles.primaryCell}><strong>{item.title}</strong><small>{item.publicId}</small></span></td>
              <td><StatusBadge tone={item.kind === "warning" ? "warning" : "info"}>{item.kind}</StatusBadge></td>
              <td>{formatDateTime(item.publishAt)}</td>
              <td>{services(item.affectedServiceIds)}</td>
              <td><StatusBadge tone={publicationTone(item.publicationState)}>{item.publicationState}</StatusBadge></td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableShell>
  );
}

export default async function StatusCenterPage() {
  let data = null;
  let loadError = false;
  try {
    data = await getStatusCenterOverview();
  } catch (error) {
    loadError = true;
    console.error("Status Center Overviewの取得に失敗しました", error);
  }

  const now = Date.now();
  const activeIncidents = data?.incidents.filter(
    (item) => item.publicationState === "published" && item.lifecycleStatus !== "resolved",
  ).length ?? 0;
  const upcomingMaintenance = data?.maintenance.filter(
    (item) => item.publicationState === "published" && Date.parse(item.endsAt) > now,
  ).length ?? 0;
  const activeAnnouncements = data?.announcements.filter(
    (item) => item.publicationState === "published" && Date.parse(item.publishAt) <= now && (!item.expiresAt || Date.parse(item.expiresAt) > now),
  ).length ?? 0;
  const drafts = data
    ? [...data.incidents, ...data.maintenance, ...data.announcements].filter((item) => item.publicationState === "draft").length
    : 0;

  return (
    <>
      <AutoRefresh intervalMs={30_000} />
      <section className={`content ${styles.content}`}>
        <PageHeader
          eyebrow="ADMINISTRATION / PUBLIC STATUS"
          title="Status Center"
          description="status.ivrm.jpへ公開するIncident・Maintenance・Announcementを、公開サイトから分離した管理面で扱います。"
          actions={<><ActionLink href="https://status.ivrm.jp">公開Status</ActionLink><ActionLink href="/notifications">通知Center</ActionLink></>}
        />

        {loadError || !data ? (
          <StatePanel title="Status Centerを取得できませんでした" variant="error">
            Supabase Public Status CMS read modelのServer-side接続を確認してください。
          </StatePanel>
        ) : (
          <>
            <MetricGrid label="Status Center summary">
              <MetricCard label="Active Incident" value={activeIncidents} tone={activeIncidents > 0 ? "danger" : "success"} detail="公開中・未解決" />
              <MetricCard label="Maintenance" value={upcomingMaintenance} tone={upcomingMaintenance > 0 ? "warning" : "neutral"} detail="予定または実施中" />
              <MetricCard label="Announcement" value={activeAnnouncements} tone="info" detail="現在公開対象" />
              <MetricCard label="Draft" value={drafts} tone={drafts > 0 ? "warning" : "neutral"} detail={`Feed ${formatDateTime(data.generatedAt)}`} />
            </MetricGrid>

            <section className={styles.section}>
              <SectionHeader title="Public Incidents" description="監視Signalを直接公開せず、公開用にsanitizedされたIncidentだけを管理します。" />
              <IncidentTable incidents={data.incidents} />
            </section>

            <section className={styles.section}>
              <SectionHeader title="Maintenance Notices" description="公開NoticeとReliability SLO exclusionを別責務のまま関連付けます。" />
              <MaintenanceTable maintenance={data.maintenance} />
            </section>

            <section className={styles.section}>
              <SectionHeader title="Announcements" description="Plain text主体の予約公開・Archiveを扱う公開お知らせ領域です。" />
              <AnnouncementTable announcements={data.announcements} />
            </section>

            <p className={styles.note}>このPhaseではRead Modelと管理画面の土台までを有効化しています。公開操作・Incident Update・Webhook event生成は次の安全なMutation Phaseで追加します。</p>
          </>
        )}
      </section>
    </>
  );
}
