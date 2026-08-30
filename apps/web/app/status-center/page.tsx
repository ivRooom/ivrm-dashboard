import { randomUUID } from "node:crypto";
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
import { getConsoleSession, hasConsoleRole } from "../../lib/console-auth";
import {
  getStatusCenterOverview,
  type StatusCenterAnnouncement,
  type StatusCenterIncident,
  type StatusCenterMaintenance,
} from "../../lib/status-center";
import styles from "./status-center.module.css";

export const dynamic = "force-dynamic";
type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function first(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] || null : value || null;
}

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

function jstDateTimeLocalAfter(minutes = 0): string {
  const date = new Date(Date.now() + minutes * 60_000 + 9 * 3_600_000);
  return date.toISOString().slice(0, 16);
}

function services(ids: string[]) {
  if (ids.length === 0) return <span className={styles.meta}>全体</span>;
  return (
    <span className={styles.serviceList}>
      {ids.map((id) => <code className={styles.serviceCode} key={id}>{id}</code>)}
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

function maintenanceLifecycle(item: StatusCenterMaintenance, now = Date.now()) {
  if (item.publicationState === "draft") return "draft" as const;
  if (item.publicationState === "cancelled") return "cancelled" as const;
  if (now < Date.parse(item.startsAt)) return "scheduled" as const;
  if (now < Date.parse(item.endsAt)) return "in_progress" as const;
  return "completed" as const;
}

function maintenanceLifecycleTone(state: ReturnType<typeof maintenanceLifecycle>) {
  if (state === "in_progress") return "warning" as const;
  if (state === "completed") return "success" as const;
  if (state === "cancelled") return "neutral" as const;
  if (state === "scheduled") return "info" as const;
  return "warning" as const;
}

function announcementLifecycle(item: StatusCenterAnnouncement, now = Date.now()) {
  if (item.publicationState === "draft") return "draft" as const;
  if (item.publicationState === "archived") return "archived" as const;
  if (now < Date.parse(item.publishAt)) return "scheduled" as const;
  if (item.expiresAt && now >= Date.parse(item.expiresAt)) return "expired" as const;
  return "active" as const;
}

function announcementLifecycleTone(state: ReturnType<typeof announcementLifecycle>) {
  if (state === "active") return "success" as const;
  if (state === "scheduled") return "info" as const;
  if (state === "expired" || state === "archived") return "neutral" as const;
  return "warning" as const;
}

function incidentMutationMessage(outcome: string | null): { title: string; variant: "info" | "warning" | "error" } | null {
  if (!outcome) return null;
  if (outcome === "created") return { title: "Incident draftを作成しました", variant: "info" };
  if (outcome === "published") return { title: "Incidentを公開しました", variant: "info" };
  if (outcome === "updated") return { title: "Incident updateを公開しました", variant: "info" };
  if (outcome === "resolved") return { title: "Incidentを復旧済みにしました", variant: "info" };
  if (outcome === "acknowledgement_required") return { title: "公開・復旧には確認チェックが必要です", variant: "warning" };
  if (outcome.endsWith("_invalid") || outcome === "identity_invalid") return { title: "入力内容を確認してください", variant: "warning" };
  return { title: "Incident操作に失敗しました", variant: "error" };
}

function maintenanceMutationMessage(outcome: string | null): { title: string; variant: "info" | "warning" | "error" } | null {
  if (!outcome) return null;
  if (outcome === "created") return { title: "Maintenance draftを作成しました", variant: "info" };
  if (outcome === "published") return { title: "Maintenanceを予約公開しました", variant: "info" };
  if (outcome === "cancelled") return { title: "Maintenanceを取消しました", variant: "info" };
  if (outcome === "acknowledgement_required") return { title: "公開・取消には確認チェックが必要です", variant: "warning" };
  if (outcome.endsWith("_invalid") || outcome === "identity_invalid") return { title: "Maintenance入力内容を確認してください", variant: "warning" };
  return { title: "Maintenance操作に失敗しました", variant: "error" };
}

function announcementMutationMessage(outcome: string | null): { title: string; variant: "info" | "warning" | "error" } | null {
  if (!outcome) return null;
  if (outcome === "created") return { title: "Announcement draftを作成しました", variant: "info" };
  if (outcome === "published") return { title: "Announcementを公開・予約しました", variant: "info" };
  if (outcome === "archived") return { title: "AnnouncementをArchiveしました", variant: "info" };
  if (outcome === "acknowledgement_required") return { title: "公開・Archiveには確認チェックが必要です", variant: "warning" };
  if (outcome.endsWith("_invalid") || outcome === "identity_invalid") return { title: "Announcement入力内容を確認してください", variant: "warning" };
  return { title: "Announcement操作に失敗しました", variant: "error" };
}

function IncidentTable({ incidents }: { incidents: StatusCenterIncident[] }) {
  if (incidents.length === 0) {
    return <StatePanel title="Incidentはまだありません">administrator / ownerは上のフォームからdraftを作成できます。</StatePanel>;
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

function IncidentCreateForm() {
  return (
    <form className={styles.editorForm} action="/api/status-center/incidents" method="post">
      <input type="hidden" name="action" value="create" />
      <input type="hidden" name="idempotencyKey" value={randomUUID()} />
      <label className={styles.fieldWide}>タイトル<input name="title" required maxLength={160} placeholder="Minecraft Network 接続障害" /></label>
      <label>影響<select name="impact" defaultValue="major"><option value="none">none</option><option value="minor">minor</option><option value="major">major</option><option value="critical">critical</option></select></label>
      <label>発生日時（JST）<input type="datetime-local" name="startedAt" required defaultValue={jstDateTimeLocalAfter()} /></label>
      <label className={styles.fieldWide}>対象Service ID（カンマ区切り）<input name="serviceIds" required defaultValue="minecraft-network" placeholder="minecraft-network,herta-discord-bot" /></label>
      <label className={styles.fieldWide}>公開サマリー<textarea name="summary" required minLength={1} maxLength={2000} rows={3} placeholder="利用者影響と現在確認できている事実だけを記載します。" /></label>
      <div className={styles.formActions}><button type="submit">Draftを作成</button><span>作成直後は非公開です。</span></div>
    </form>
  );
}

function IncidentManageForms({ incidents }: { incidents: StatusCenterIncident[] }) {
  const manageable = incidents.filter((item) => item.publicationState !== "archived" && item.lifecycleStatus !== "resolved");
  if (manageable.length === 0) return null;
  return (
    <div className={styles.manageList}>
      {manageable.map((incident) => (
        <article className={styles.manageCard} id={`incident-${incident.publicId}`} key={incident.publicId}>
          <header><div><strong>{incident.title}</strong><span>{incident.publicId}</span></div><StatusBadge tone={publicationTone(incident.publicationState)}>{incident.publicationState}</StatusBadge></header>
          <p>{incident.summary}</p>
          {incident.publicationState === "draft" ? (
            <form className={styles.inlineActionForm} action="/api/status-center/incidents" method="post">
              <input type="hidden" name="action" value="publish" />
              <input type="hidden" name="publicId" value={incident.publicId} />
              <input type="hidden" name="requestId" value={randomUUID()} />
              <label className={styles.confirm}><input type="checkbox" name="acknowledged" required />この内容が status.ivrm.jp に公開されることを確認しました</label>
              <button type="submit">Incidentを公開</button>
            </form>
          ) : (
            <form className={styles.editorForm} action="/api/status-center/incidents" method="post">
              <input type="hidden" name="action" value="update" />
              <input type="hidden" name="publicId" value={incident.publicId} />
              <input type="hidden" name="requestId" value={randomUUID()} />
              <label>次の状態<select name="lifecycleStatus" defaultValue={incident.lifecycleStatus === "investigating" ? "identified" : incident.lifecycleStatus === "identified" ? "monitoring" : "monitoring"}>
                {incident.lifecycleStatus === "investigating" ? <option value="investigating">investigating</option> : null}
                {incident.lifecycleStatus === "investigating" || incident.lifecycleStatus === "identified" ? <option value="identified">identified</option> : null}
                <option value="monitoring">monitoring</option><option value="resolved">resolved</option>
              </select></label>
              <label className={styles.fieldWide}>公開Update<textarea name="message" required minLength={1} maxLength={2000} rows={3} placeholder="調査結果・対処状況・復旧確認など、公開してよい内容のみ記載します。" /></label>
              <label className={`${styles.confirm} ${styles.fieldWide}`}><input type="checkbox" name="acknowledged" />resolvedを選ぶ場合は、復旧確認済みであることをチェックしてください</label>
              <div className={styles.formActions}><button type="submit">Updateを公開</button><span>Lifecycleは後戻りできません。</span></div>
            </form>
          )}
        </article>
      ))}
    </div>
  );
}

function MaintenanceCreateForm() {
  return (
    <form className={styles.editorForm} action="/api/status-center/maintenance" method="post">
      <input type="hidden" name="action" value="create" />
      <input type="hidden" name="idempotencyKey" value={randomUUID()} />
      <label className={styles.fieldWide}>タイトル<input name="title" required maxLength={160} placeholder="Minecraft Network 定期メンテナンス" /></label>
      <label>開始日時（JST）<input type="datetime-local" name="startsAt" required defaultValue={jstDateTimeLocalAfter(60)} /></label>
      <label>終了日時（JST）<input type="datetime-local" name="endsAt" required defaultValue={jstDateTimeLocalAfter(120)} /></label>
      <label className={styles.fieldWide}>対象Service ID（カンマ区切り）<input name="serviceIds" required defaultValue="minecraft-network" placeholder="minecraft-network,herta-discord-bot" /></label>
      <label className={styles.fieldWide}>公開本文<textarea name="body" required minLength={1} maxLength={4000} rows={4} placeholder="予定している作業内容、利用者影響、予定時間を公開可能な情報だけで記載します。" /></label>
      <label className={styles.fieldWide}>Reliability Window UUID（任意）<input name="reliabilityWindowId" maxLength={36} placeholder="SLO除外Windowと関連付ける場合のみ指定" /></label>
      <div className={styles.formActions}><button type="submit">Maintenance Draftを作成</button><span>Public NoticeとSLO除外Windowは別データです。</span></div>
    </form>
  );
}

function MaintenanceManageForms({ maintenance }: { maintenance: StatusCenterMaintenance[] }) {
  const now = Date.now();
  const manageable = maintenance.filter((item) =>
    item.publicationState === "draft" ||
    (item.publicationState === "published" && Date.parse(item.startsAt) > now),
  );
  if (manageable.length === 0) return null;
  return (
    <div className={styles.manageList}>
      {manageable.map((item) => {
        const lifecycle = maintenanceLifecycle(item, now);
        return (
          <article className={styles.manageCard} id={`maintenance-${item.publicId}`} key={item.publicId}>
            <header>
              <div><strong>{item.title}</strong><span>{item.publicId}</span></div>
              <StatusBadge tone={maintenanceLifecycleTone(lifecycle)}>{lifecycle}</StatusBadge>
            </header>
            <p>{item.body}</p>
            <p className={styles.meta}>{formatDateTime(item.startsAt)} 〜 {formatDateTime(item.endsAt)} / {item.affectedServiceIds.join(", ")}</p>
            {item.publicationState === "draft" ? (
              <form className={styles.inlineActionForm} action="/api/status-center/maintenance" method="post">
                <input type="hidden" name="action" value="publish" />
                <input type="hidden" name="publicId" value={item.publicId} />
                <input type="hidden" name="requestId" value={randomUUID()} />
                <label className={styles.confirm}><input type="checkbox" name="acknowledged" required />この予定が status.ivrm.jp に公開され、時刻からLifecycleが自動導出されることを確認しました</label>
                <button type="submit">Maintenanceを予約公開</button>
              </form>
            ) : (
              <form className={styles.inlineActionForm} action="/api/status-center/maintenance" method="post">
                <input type="hidden" name="action" value="cancel" />
                <input type="hidden" name="publicId" value={item.publicId} />
                <input type="hidden" name="requestId" value={randomUUID()} />
                <label className={styles.confirm}><input type="checkbox" name="acknowledged" required />開始前のMaintenance予定を取消し、Public Archiveへ取消済みとして残すことを確認しました</label>
                <button type="submit">予定を取消</button>
              </form>
            )}
          </article>
        );
      })}
    </div>
  );
}

function MaintenanceTable({ maintenance }: { maintenance: StatusCenterMaintenance[] }) {
  if (maintenance.length === 0) return <StatePanel title="Maintenanceはまだありません">Public NoticeとReliability SLO除外は別責務のまま関連付けられます。</StatePanel>;
  const now = Date.now();
  return (
    <TableShell label="Status Maintenance一覧">
      <table className={styles.table}>
        <thead><tr><th>Maintenance</th><th>Lifecycle</th><th>期間</th><th>対象</th><th>Publication</th><th>Reliability</th></tr></thead>
        <tbody>{maintenance.map((item) => {
          const lifecycle = maintenanceLifecycle(item, now);
          return <tr key={item.publicId}><td><span className={styles.primaryCell}><strong>{item.title}</strong><small>{item.publicId}</small></span></td><td><StatusBadge tone={maintenanceLifecycleTone(lifecycle)}>{lifecycle}</StatusBadge></td><td><span className={styles.primaryCell}><span>{formatDateTime(item.startsAt)}</span><small>〜 {formatDateTime(item.endsAt)}</small></span></td><td>{services(item.affectedServiceIds)}</td><td><StatusBadge tone={publicationTone(item.publicationState)}>{item.publicationState}</StatusBadge></td><td className={styles.meta}>{item.reliabilityWindowId ? "Linked" : "Not linked"}</td></tr>;
        })}</tbody>
      </table>
    </TableShell>
  );
}

function AnnouncementCreateForm() {
  return (
    <form className={styles.editorForm} action="/api/status-center/announcements" method="post">
      <input type="hidden" name="action" value="create" />
      <input type="hidden" name="idempotencyKey" value={randomUUID()} />
      <label>種別<select name="kind" defaultValue="info"><option value="info">info</option><option value="warning">warning</option></select></label>
      <label>公開日時（JST）<input type="datetime-local" name="publishAt" required defaultValue={jstDateTimeLocalAfter(15)} /></label>
      <label className={styles.fieldWide}>タイトル<input name="title" required maxLength={160} placeholder="サービス更新のお知らせ" /></label>
      <label className={styles.fieldWide}>対象Service ID（任意・カンマ区切り）<input name="serviceIds" placeholder="minecraft-network,herta-discord-bot" /></label>
      <label className={styles.fieldWide}>公開本文<textarea name="body" required minLength={1} maxLength={4000} rows={4} placeholder="利用者へ公開してよい情報だけをPlain textで記載します。" /></label>
      <label>公開終了日時（JST・任意）<input type="datetime-local" name="expiresAt" /></label>
      <div className={styles.formActions}><button type="submit">Announcement Draftを作成</button><span>Draftは非公開です。公開時刻とArchiveは別操作で確定します。</span></div>
    </form>
  );
}

function AnnouncementManageForms({ announcements }: { announcements: StatusCenterAnnouncement[] }) {
  const now = Date.now();
  const manageable = announcements.filter((item) => item.publicationState !== "archived");
  if (manageable.length === 0) return null;
  return (
    <div className={styles.manageList}>
      {manageable.map((item) => {
        const lifecycle = announcementLifecycle(item, now);
        return (
          <article className={styles.manageCard} id={`announcement-${item.publicId}`} key={item.publicId}>
            <header>
              <div><strong>{item.title}</strong><span>{item.publicId}</span></div>
              <StatusBadge tone={announcementLifecycleTone(lifecycle)}>{lifecycle}</StatusBadge>
            </header>
            <p>{item.body}</p>
            <p className={styles.meta}>公開 {formatDateTime(item.publishAt)} / 終了 {formatDateTime(item.expiresAt)} / {item.affectedServiceIds.length > 0 ? item.affectedServiceIds.join(", ") : "全体"}</p>
            {item.publicationState === "draft" ? (
              <form className={styles.inlineActionForm} action="/api/status-center/announcements" method="post">
                <input type="hidden" name="action" value="publish" />
                <input type="hidden" name="publicId" value={item.publicId} />
                <input type="hidden" name="requestId" value={randomUUID()} />
                <label className={styles.confirm}><input type="checkbox" name="acknowledged" required />publishAt以降に status.ivrm.jp へ公開されることを確認しました</label>
                <button type="submit">Announcementを公開・予約</button>
              </form>
            ) : (
              <form className={styles.inlineActionForm} action="/api/status-center/announcements" method="post">
                <input type="hidden" name="action" value="archive" />
                <input type="hidden" name="publicId" value={item.publicId} />
                <input type="hidden" name="requestId" value={randomUUID()} />
                <label className={styles.confirm}><input type="checkbox" name="acknowledged" required />Archive後は公開対象から外れます。公開予定前なら予約取消として将来もFeedへ出ないことを確認しました</label>
                <button type="submit">AnnouncementをArchive</button>
              </form>
            )}
          </article>
        );
      })}
    </div>
  );
}

function AnnouncementTable({ announcements }: { announcements: StatusCenterAnnouncement[] }) {
  if (announcements.length === 0) return <StatePanel title="Announcementはまだありません">administrator / ownerは上のフォームからdraftを作成できます。</StatePanel>;
  const now = Date.now();
  return (
    <TableShell label="Status Announcement一覧">
      <table className={styles.table}>
        <thead><tr><th>Announcement</th><th>Lifecycle</th><th>種別</th><th>公開予定</th><th>終了</th><th>対象</th><th>Publication</th></tr></thead>
        <tbody>{announcements.map((item) => {
          const lifecycle = announcementLifecycle(item, now);
          return <tr key={item.publicId}><td><span className={styles.primaryCell}><strong>{item.title}</strong><small>{item.publicId}</small></span></td><td><StatusBadge tone={announcementLifecycleTone(lifecycle)}>{lifecycle}</StatusBadge></td><td><StatusBadge tone={item.kind === "warning" ? "warning" : "info"}>{item.kind}</StatusBadge></td><td>{formatDateTime(item.publishAt)}</td><td>{formatDateTime(item.expiresAt)}</td><td>{services(item.affectedServiceIds)}</td><td><StatusBadge tone={publicationTone(item.publicationState)}>{item.publicationState}</StatusBadge></td></tr>;
        })}</tbody>
      </table>
    </TableShell>
  );
}

export default async function StatusCenterPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const incidentMutation = incidentMutationMessage(first(query.incidentMutation));
  const maintenanceMutation = maintenanceMutationMessage(first(query.maintenanceMutation));
  const announcementMutation = announcementMutationMessage(first(query.announcementMutation));
  let data = null;
  let loadError = false;
  let canMutate = false;
  try {
    const session = await getConsoleSession();
    canMutate = hasConsoleRole(session, "administrator") && (session.role === "administrator" || session.role === "owner");
  } catch (error) {
    console.error("Status Center Session取得に失敗しました", error);
  }
  try {
    data = await getStatusCenterOverview();
  } catch (error) {
    loadError = true;
    console.error("Status Center Overviewの取得に失敗しました", error);
  }

  const now = Date.now();
  const activeIncidents = data?.incidents.filter((item) => item.publicationState === "published" && item.lifecycleStatus !== "resolved").length ?? 0;
  const upcomingMaintenance = data?.maintenance.filter((item) => item.publicationState === "published" && Date.parse(item.endsAt) > now).length ?? 0;
  const activeAnnouncements = data?.announcements.filter((item) => item.publicationState === "published" && Date.parse(item.publishAt) <= now && (!item.expiresAt || Date.parse(item.expiresAt) > now)).length ?? 0;
  const drafts = data ? [...data.incidents, ...data.maintenance, ...data.announcements].filter((item) => item.publicationState === "draft").length : 0;

  return (
    <>
      {!canMutate ? <AutoRefresh intervalMs={30_000} /> : null}
      <section className={`content ${styles.content}`}>
        <PageHeader eyebrow="ADMINISTRATION / PUBLIC STATUS" title="Status Center" description="status.ivrm.jpへ公開するIncident・Maintenance・Announcementを、公開サイトから分離した管理面で扱います。" actions={<><ActionLink href="https://status.ivrm.jp">公開Status</ActionLink><ActionLink href="/notifications">通知Center</ActionLink></>} />
        {incidentMutation ? <StatePanel title={incidentMutation.title} variant={incidentMutation.variant}>公開Feedへ反映する処理はServer-side RBAC・Origin検証・監査ログを通過します。</StatePanel> : null}
        {maintenanceMutation ? <StatePanel title={maintenanceMutation.title} variant={maintenanceMutation.variant}>MaintenanceのPublicationと公開Lifecycleを分離し、公開Lifecycleは時刻から導出します。</StatePanel> : null}
        {announcementMutation ? <StatePanel title={announcementMutation.title} variant={announcementMutation.variant}>AnnouncementはPlain textのみを扱い、scheduled / active / expiredを時刻から導出します。</StatePanel> : null}

        {loadError || !data ? <StatePanel title="Status Centerを取得できませんでした" variant="error">Supabase Public Status CMS read modelのServer-side接続を確認してください。</StatePanel> : <>
          <MetricGrid label="Status Center summary"><MetricCard label="Active Incident" value={activeIncidents} tone={activeIncidents > 0 ? "danger" : "success"} detail="公開中・未解決" /><MetricCard label="Maintenance" value={upcomingMaintenance} tone={upcomingMaintenance > 0 ? "warning" : "neutral"} detail="予定または実施中" /><MetricCard label="Announcement" value={activeAnnouncements} tone="info" detail="現在公開対象" /><MetricCard label="Draft" value={drafts} tone={drafts > 0 ? "warning" : "neutral"} detail={`Feed ${formatDateTime(data.generatedAt)}`} /></MetricGrid>

          <section className={styles.section} id="public-incidents">
            <SectionHeader title="Public Incidents" description="監視Signalを直接公開せず、公開用にsanitizedされたIncidentだけを管理します。" />
            {canMutate ? <><div className={styles.editorPanel}><h3>Incident draftを作成</h3><p>作成段階では非公開です。内容を確認後に別操作で公開します。</p><IncidentCreateForm /></div><IncidentManageForms incidents={data.incidents} /></> : <StatePanel title="Incident編集はadministrator / owner限定です" variant="info">現在のロールでは公開コンテンツを変更できません。</StatePanel>}
            <IncidentTable incidents={data.incidents} />
          </section>

          <section className={styles.section} id="maintenance-notices">
            <SectionHeader title="Maintenance Notices" description="Public NoticeとReliability SLO exclusionを別責務のまま関連付け、Lifecycleは開始・終了時刻から導出します。" />
            {canMutate ? <><div className={styles.editorPanel}><h3>Maintenance draftを作成</h3><p>Draftは非公開です。予約公開後はscheduled / in_progress / completedを時刻から自動判定します。</p><MaintenanceCreateForm /></div><MaintenanceManageForms maintenance={data.maintenance} /></> : <StatePanel title="Maintenance編集はadministrator / owner限定です" variant="info">現在のロールでは公開Maintenanceを変更できません。</StatePanel>}
            <MaintenanceTable maintenance={data.maintenance} />
          </section>

          <section className={styles.section} id="announcements">
            <SectionHeader title="Announcements" description="Plain textの公開お知らせをCreate Draft → Publish/Schedule → Archiveし、Lifecycleは公開・終了時刻から導出します。" />
            {canMutate ? <><div className={styles.editorPanel}><h3>Announcement draftを作成</h3><p>Draftと将来publishAtの予約はPublic Feedへ出ません。公開予定前のArchiveは予約取消として将来も非公開です。</p><AnnouncementCreateForm /></div><AnnouncementManageForms announcements={data.announcements} /></> : <StatePanel title="Announcement編集はadministrator / owner限定です" variant="info">現在のロールでは公開Announcementを変更できません。</StatePanel>}
            <AnnouncementTable announcements={data.announcements} />
          </section>
          <p className={styles.note}>Incident / Maintenance / Announcement Mutationを実装済みです。Durable lifecycle deliveryは分離した後続Phaseで追加します。</p>
        </>}
      </section>
    </>
  );
}
