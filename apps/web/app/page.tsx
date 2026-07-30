type Status = "online" | "offline" | "stale" | "error";

type Service = {
  name: string;
  detail: string;
  status: Status;
  cpu: string;
  memory: string;
};

const services: readonly Service[] = [
  { name: "Minecraft Main", detail: "NeoForge / 生活・工業・MMO", status: "online", cpu: "18.4%", memory: "4.8 / 7 GiB" },
  { name: "Minecraft Resource", detail: "接続時に自動起動", status: "offline", cpu: "0.0%", memory: "0 / 5 GiB" },
  { name: "Resource Router", detail: "TCP 25999", status: "online", cpu: "0.2%", memory: "0.08 / 0.25 GiB" },
];

const labels: Record<Status, string> = {
  online: "稼働中",
  offline: "停止中",
  stale: "更新停止",
  error: "異常",
};

export default function HomePage() {
  const online = services.filter((service) => service.status === "online").length;

  return (
    <main className="shell">
      <aside className="sidebar">
        <a className="brand" href="#top"><span>IV</span><strong>IVRM Console</strong></a>
        <nav aria-label="メインナビゲーション">
          {["概要", "Minecraft", "ホスト", "Herta.", "AWS", "監査ログ"].map((item, index) => (
            <a className={index === 0 ? "active" : ""} href="#services" key={item}>{item}</a>
          ))}
        </nav>
        <div className="agent"><i />OCI Agent<br /><small>Heartbeat 正常</small></div>
      </aside>

      <section className="content" id="top">
        <header>
          <div><h1>システム概要</h1><p>IVRMのサービスとインフラを一元監視します。</p></div>
          <button disabled>管理者メニュー</button>
        </header>

        <section className="summary" aria-label="稼働状況サマリー">
          <article><span>監視対象</span><strong>{services.length}</strong><small>OCI上の初期対象</small></article>
          <article><span>稼働中</span><strong>{online}</strong><small>Heartbeat正常</small></article>
          <article><span>ホストメモリ</span><strong>12 GiB</strong><small>OCI ARMホスト</small></article>
          <article><span>最終バックアップ</span><strong>成功</strong><small>S3 / mc-main</small></article>
        </section>

        <section id="services">
          <div className="heading"><div><h2>サービス</h2><p>現在はUI確認用のデモデータです。</p></div><small>自動更新 10秒</small></div>
          <div className="list">
            {services.map((service) => (
              <article className="row" key={service.name}>
                <div className="identity"><b>{service.name.slice(0, 1)}</b><div><h3>{service.name}</h3><p>{service.detail}</p></div></div>
                <span className={`status ${service.status}`}>{labels[service.status]}</span>
                <div className="metric"><small>CPU</small><strong>{service.cpu}</strong></div>
                <div className="metric"><small>メモリ</small><strong>{service.memory}</strong></div>
                <time>数秒前</time>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
