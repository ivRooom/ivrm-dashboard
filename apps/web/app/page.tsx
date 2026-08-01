import { AutoRefresh } from "../components/auto-refresh";
import {
  getMonitoringSnapshot,
  type ContainerHealth,
  type ContainerOverview,
  type ContainerState,
  type HostOverview,
  type HostStatus,
} from "../lib/monitoring";

export const dynamic = "force-dynamic";

const navigation = [
  { label: "概要", href: "#top" },
  { label: "ホスト", href: "#hosts" },
  { label: "コンテナ", href: "#containers" },
] as const;

const labels: Record<HostStatus, string> = {
  online: "稼働中",
  offline: "停止中",
  stale: "更新遅延",
  error: "異常",
};

const containerStateLabels: Record<ContainerState, string> = {
  created: "作成済み",
  running: "実行中",
  paused: "一時停止",
  restarting: "再起動中",
  removing: "削除中",
  exited: "終了",
  dead: "異常終了",
  unknown: "不明",
  not_found: "未作成",
};

const containerHealthLabels: Record<ContainerHealth, string> = {
  starting: "確認中",
  healthy: "正常",
  unhealthy: "異常",
  none: "未設定",
  unknown: "不明",
};

function formatGiB(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1);
}

function formatCapacity(total: number | null, available: number | null): string {
  if (total === null || available === null || total <= 0) {
    return "未取得";
  }

  const used = Math.max(0, total - available);
  const percent = Math.min(100, Math.max(0, (used / total) * 100));
  return `${formatGiB(used)} / ${formatGiB(total)} GiB (${percent.toFixed(0)}%)`;
}

function formatLoad(host: HostOverview): string {
  if (
    host.loadAverage1 === null ||
    host.loadAverage5 === null ||
    host.loadAverage15 === null
  ) {
    return "未取得";
  }

  return [host.loadAverage1, host.loadAverage5, host.loadAverage15]
    .map((value) => value.toFixed(2))
    .join(" / ");
}

function formatUptime(seconds: number | null): string {
  if (seconds === null) {
    return "Uptime未取得";
  }

  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  if (days > 0) {
    return `Uptime ${days}日${hours}時間`;
  }
  return `Uptime ${hours}時間`;
}

function formatRelativeTime(timestamp: string | null, reference: string): string {
  if (!timestamp) {
    return "未受信";
  }

  const ageSeconds = Math.max(
    0,
    Math.floor((Date.parse(reference) - Date.parse(timestamp)) / 1_000),
  );
  if (ageSeconds < 60) {
    return `${ageSeconds}秒前`;
  }
  if (ageSeconds < 3_600) {
    return `${Math.floor(ageSeconds / 60)}分前`;
  }
  if (ageSeconds < 86_400) {
    return `${Math.floor(ageSeconds / 3_600)}時間前`;
  }
  return `${Math.floor(ageSeconds / 86_400)}日前`;
}

function overallStatus(hosts: HostOverview[], hasDataError: boolean): HostStatus {
  if (hasDataError) {
    return "error";
  }
  if (hosts.some((host) => host.status === "online")) {
    return "online";
  }
  if (hosts.some((host) => host.status === "stale")) {
    return "stale";
  }
  return "offline";
}

function formatExit(container: ContainerOverview): string {
  if (container.oomKilled) {
    return "OOMKilled";
  }
  if (container.exitCode === null) {
    return "—";
  }
  return `Code ${container.exitCode}`;
}

export default async function HomePage() {
  let hosts: HostOverview[] = [];
  let containers: ContainerOverview[] = [];
  let generatedAt = new Date().toISOString();
  let hasDataError = false;

  try {
    const snapshot = await getMonitoringSnapshot();
    hosts = snapshot.hosts;
    containers = snapshot.containers;
    generatedAt = snapshot.generatedAt;
  } catch {
    hasDataError = true;
    console.error("監視データの取得に失敗しました");
  }

  const status = overallStatus(hosts, hasDataError);
  const onlineCount = hosts.filter((host) => host.status === "online").length;
  const totalMemoryBytes = hosts.reduce(
    (total, host) => total + (host.memoryTotalBytes ?? 0),
    0,
  );
  const latestHeartbeat =
    hosts
      .map((host) => host.receivedAt)
      .filter((receivedAt): receivedAt is string => receivedAt !== null)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;

  return (
    <main className="shell">
      <AutoRefresh />

      <aside className="sidebar">
        <a className="brand" href="#top">
          <span>IV</span>
          <strong>IVRM Console</strong>
        </a>
        <nav aria-label="メインナビゲーション">
          {navigation.map((item) => (
            <a href={item.href} key={item.href}>
              {item.label}
            </a>
          ))}
        </nav>
        <div className="agent">
          <i className={status} />
          OCI Agent
          <br />
          <small>{labels[status]}</small>
        </div>
      </aside>

      <section className="content" id="top">
        <header>
          <div>
            <h1>システム概要</h1>
            <p>OCIホストとDockerコンテナの最新状態を表示しています。</p>
          </div>
          <button disabled>管理者メニュー</button>
        </header>

        <section className="summary" aria-label="稼働状況サマリー">
          <article>
            <span>監視ホスト</span>
            <strong>{hasDataError ? "—" : hosts.length}</strong>
            <small>有効なAgent登録数</small>
          </article>
          <article>
            <span>監視コンテナ</span>
            <strong>{hasDataError ? "—" : containers.length}</strong>
            <small>最新スナップショット</small>
          </article>
          <article>
            <span>ホストメモリ</span>
            <strong>
              {hasDataError || totalMemoryBytes === 0
                ? "—"
                : `${formatGiB(totalMemoryBytes)} GiB`}
            </strong>
            <small>Agent報告値の合計</small>
          </article>
          <article>
            <span>最終受信</span>
            <strong>{formatRelativeTime(latestHeartbeat, generatedAt)}</strong>
            <small>{onlineCount}ホスト正常 / 15秒更新</small>
          </article>
        </section>

        <section id="hosts">
          <div className="heading">
            <div>
              <h2>ホスト</h2>
              <p>CPU、メモリ、ディスク、Load Average、Uptimeの現在値です。</p>
            </div>
            <small>自動更新 15秒</small>
          </div>

          {hasDataError ? (
            <div className="empty error-panel" role="alert">
              <strong>監視データを取得できませんでした</strong>
              <p>VercelのSupabase環境変数とAPI稼働状況を確認してください。</p>
            </div>
          ) : hosts.length === 0 ? (
            <div className="empty">
              <strong>監視対象がありません</strong>
              <p>有効なホストとHeartbeatが登録されると、ここへ表示されます。</p>
            </div>
          ) : (
            <div className="list">
              {hosts.map((host) => (
                <article className="row" key={host.id}>
                  <div className="identity">
                    <b>{host.displayName.slice(0, 1).toUpperCase()}</b>
                    <div>
                      <h3>{host.displayName}</h3>
                      <p>
                        {host.provider.toUpperCase()} / {host.environment} /{" "}
                        {host.cpuCount ?? "—"} vCPU /{" "}
                        {formatUptime(host.uptimeSeconds)}
                      </p>
                    </div>
                  </div>
                  <span className={`status ${host.status}`}>
                    {labels[host.status]}
                  </span>
                  <div className="metric">
                    <small>LOAD 1 / 5 / 15</small>
                    <strong>{formatLoad(host)}</strong>
                  </div>
                  <div className="metric">
                    <small>メモリ</small>
                    <strong>
                      {formatCapacity(
                        host.memoryTotalBytes,
                        host.memoryAvailableBytes,
                      )}
                    </strong>
                  </div>
                  <div className="metric">
                    <small>ディスク</small>
                    <strong>
                      {formatCapacity(
                        host.diskTotalBytes,
                        host.diskAvailableBytes,
                      )}
                    </strong>
                  </div>
                  <time dateTime={host.receivedAt ?? undefined}>
                    {formatRelativeTime(host.receivedAt, generatedAt)}
                    <small>Agent {host.agentVersion ?? "未受信"}</small>
                  </time>
                </article>
              ))}
            </div>
          )}
        </section>

        <section id="containers">
          <div className="heading">
            <div>
              <h2>Dockerコンテナ</h2>
              <p>許可済みコンテナのState、Health、再起動回数を表示します。</p>
            </div>
            <small>{containers.length}コンテナ</small>
          </div>

          {hasDataError ? (
            <div className="empty error-panel" role="alert">
              <strong>コンテナ状態を取得できませんでした</strong>
              <p>SupabaseのMigrationと監視APIを確認してください。</p>
            </div>
          ) : containers.length === 0 ? (
            <div className="empty">
              <strong>Dockerスナップショットがありません</strong>
              <p>OCIへスナップショット収集Timerを配置すると表示されます。</p>
            </div>
          ) : (
            <div className="list">
              {containers.map((container) => (
                <article
                  className="row"
                  key={`${container.hostId}:${container.name}`}
                >
                  <div className="identity">
                    <b>{container.name.slice(0, 1).toUpperCase()}</b>
                    <div>
                      <h3>{container.name}</h3>
                      <p>{container.hostDisplayName}</p>
                    </div>
                  </div>
                  <span className={`status ${container.status}`}>
                    {containerStateLabels[container.state]}
                  </span>
                  <div className="metric">
                    <small>HEALTH</small>
                    <strong>{containerHealthLabels[container.health]}</strong>
                  </div>
                  <div className="metric">
                    <small>RESTART COUNT</small>
                    <strong>{container.restartCount}</strong>
                  </div>
                  <div className="metric">
                    <small>EXIT / OOM</small>
                    <strong>{formatExit(container)}</strong>
                  </div>
                  <time dateTime={container.receivedAt}>
                    {formatRelativeTime(container.receivedAt, generatedAt)}
                    <small>{labels[container.status]}</small>
                  </time>
                </article>
              ))}
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
