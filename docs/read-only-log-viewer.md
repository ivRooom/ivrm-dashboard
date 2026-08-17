# Read-only Log Viewer

`console.ivrm.jp/logs` へMinecraft / Velocity / IVRM Agentの短期ログを表示するPhase A実装です。

## Security boundary

```text
container / systemd logs
  ↓ fixed allowlist / bounded tail
root-owned ivrm-log-reporter.service
  ↓ ANSI strip + IP/Secret redaction
  ↓ HMAC-SHA256 signed HTTPS
/api/agent/logs
  ↓ strict payload validation + second redaction
  ↓ replay / rate limit / event dedupe
Supabase console_log_entries
  ↓ Service Role RPC only / RLS forced
/api/logs
  ↓ Discord Console Session
/logs
```

- Docker Socket / Docker API / SSH / RCONをInternetへ公開しない。
- Browserからcontainer名やshell commandをReporterへ渡さない。
- sourceはコードとDBの両方でallowlist固定。
- Agent自体へDocker権限を与えず、短時間のroot oneshot helperへ分離する。
- ANSI escapeは除去しHTMLへ変換しない。
- IP / Bearer / token / password / secret / RCON password / forwarding secretはOCIとWebの両方でredactする。
- 1 requestは64KiB以下、最大120行、1行2048文字以下。
- Viewer初回300行、Follow中のDOMは最大800行。
- DB Read RPCは24時間以内、最大500行に固定する。
- 24時間Retentionはingest時のbounded pruneに加えてpg_cronで毎時実行する。

## Allowed sources

| type | source |
| --- | --- |
| container | `mc-main` |
| container | `mc-block` |
| container | `ivrm-velocity` |
| container | `mc-resource` |
| container | `mc-resource-router` |
| systemd | `ivrm-agent` |

存在しないcontainerはReporterがskipします。`mc-block`は将来のMode切替を見越したallowlistです。

## Safe rollout

### 1. Migration

次のMigrationを順番にProductionへ適用します。

```text
202608180001_console_log_viewer.sql
202608180002_console_log_retention_schedule.sql
202608180003_console_log_read_stable_time.sql
```

確認:

```sql
select to_regclass('public.console_log_entries') as entries_table,
       to_regclass('public.console_log_ingest_requests') as requests_table;

select jobid, jobname, schedule
from cron.job
where jobname = 'ivrm-console-log-retention-v1';
```

両Tableがnon-nullで、Retention Jobが1件だけ存在することを確認します。

### 2. Web Production

PR merge後のmainがVercel ProductionでREADYになり、匿名アクセスが従来どおりDiscord Loginへ誘導されることを確認します。

Reporterはまだ有効にしません。

### 3. OCI Log Reporterだけをstage

最新mainをcloneし、**通常のmonitoring updaterではなくLog専用stage script**を実行します。

```bash
bash /tmp/ivrm-dashboard/deploy/oci/stage-log-reporter.sh
```

このscriptはMinecraft、IVRM Agent、Docker Snapshot、TPS/MSPT Performanceを再起動・変更しません。既存のPerformanceを維持したままLog ReporterだけをOFF状態で配置します。

期待値:

```text
logReporting=false
logEndpoint=https://console.ivrm.jp/api/agent/logs
Minecraft / Agent / Performanceは再起動・変更していません。
```

確認:

```bash
sudo grep '^IVRM_LOG_REPORTING_ENABLED=' /etc/ivrm-agent/log.env
sudo grep '^IVRM_AGENT_LOG_ENDPOINT=' /etc/ivrm-agent/agent.env
sudo systemctl is-active ivrm-log-reporter.timer
```

期待:

```text
IVRM_LOG_REPORTING_ENABLED=false
IVRM_AGENT_LOG_ENDPOINT=https://console.ivrm.jp/api/agent/logs
active
```

TimerはactiveでもReporterはOFFなのでDocker/Journaldを収集・送信しません。

`update-monitoring-stack.sh`にもLog Reporter配置は含まれますが、同scriptは既存仕様どおりMinecraft Performanceも安全のためOFFへ戻すため、Log Viewer単独rolloutでは使用しません。

### 4. Enable

Migration / Web / OCI unitがすべて確認できてから有効化します。

```bash
sudo sed -i \
  's/^IVRM_LOG_REPORTING_ENABLED=.*/IVRM_LOG_REPORTING_ENABLED=true/' \
  /etc/ivrm-agent/log.env

sudo systemctl start ivrm-log-reporter.service
sleep 3
sudo systemctl status ivrm-log-reporter.service --no-pager -l
```

oneshotが`status=0/SUCCESS`であることを確認します。

### 5. Production DB

```sql
select
  source_type,
  source_name,
  level,
  count(*) as rows,
  max(observed_at) as latest_at
from public.console_log_entries
where received_at >= now() - interval '5 minutes'
group by source_type, source_name, level
order by source_name, level;
```

本文を確認する場合もSecret値を外部へコピーしません。DBにはredact済み本文だけが保存される設計です。

件数確認:

```sql
select count(*) as recent_rows,
       min(received_at) as oldest,
       max(received_at) as latest
from public.console_log_entries
where received_at >= now() - interval '24 hours';
```

### 6. Browser

Discord認証済みで `/logs` を開き、次を確認します。

- Source filter
- Level filter
- 本文検索
- Follow ON/OFF
- 過去へスクロールしても位置が勝手に戻らない
- `最新へ`で末尾へ戻れる
- IP / Secret類が表示されない
- Mobileで横・縦スクロールが破綻しない

## Rollback

ログ収集だけを即停止します。

```bash
sudo sed -i \
  's/^IVRM_LOG_REPORTING_ENABLED=.*/IVRM_LOG_REPORTING_ENABLED=false/' \
  /etc/ivrm-agent/log.env

sudo systemctl stop ivrm-log-reporter.service || true
sudo grep '^IVRM_LOG_REPORTING_ENABLED=' /etc/ivrm-agent/log.env
```

Timerはactiveのままでもdisabled reporterは即exitします。必要ならTimer自体も停止できます。

```bash
sudo systemctl disable --now ivrm-log-reporter.timer
```

このRollbackはMinecraft、Velocity、既存Heartbeat、TPS/MSPT収集を変更しません。

## Future reuse

Phase B以降では、このLog ViewerをOperation Terminalへ再利用します。

- start / stop / restart実行中ログ
- NeoForge ready判定までの起動ログ
- Mode切替 (`mc-main` / `mc-block`) のprogress
- 許可済みMinecraft commandの結果

汎用OS shellとは分離し、Operation API / RBAC / CSRF / Idempotency / Lock / Auditを満たす操作だけを表示します。
