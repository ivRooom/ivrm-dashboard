# Read-only Log Viewer

`console.ivrm.jp/logs` へMinecraft / Velocity / IVRM Agentの短期ログを表示するIssue #68 Phase A実装です。

旧PR #69の未Merge実装を、現在のConsole Shell / Design System / Discord Session境界へ再適用しています。`/logs`は独自Sidebarを持たず、現在の共通NavigationのMinecraftグループから到達します。

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
  ↓ Service Role RPC only / FORCE RLS
/api/logs
  ↓ Discord Console Session
/logs
```

- Docker Socket / Docker API / SSH / RCONをInternetへ公開しない。
- Browserからcontainer名やshell commandをReporterへ渡さない。
- sourceはOCI / Web / DBの3層でallowlist固定する。
- Agent自体へDocker権限を与えず、短時間のroot oneshot helperへ分離する。
- ANSI escape / Minecraft legacy formattingは除去し、HTMLへ変換しない。
- IP / Bearer / token / password / secret / RCON password / forwarding secretはOCIとWebの両方でredactする。
- 1 requestは64KiB以下、最大120行、1行2048文字以下。
- Viewer初回は100 / 300 / 500行から選択し、Follow中のDOMは最大800行。
- 表示期間は5m / 15m / 1h / 6h / 24hのallowlistだけを許可する。
- Followと自動スクロールは独立して切替可能。過去ログを読んでいる間は新着取得を継続したままviewportを固定できる。
- DB Read RPCは24時間Retention内、最大500行に固定する。
- 24時間Retentionはingest時のbounded pruneに加えてpg_cronで毎時実行する。
- Supabase Service Role KeyはServer側だけで使用し、Browserへ渡さない。

## Allowed sources

| type | source |
| --- | --- |
| container | `mc-main` |
| container | `mc-block` |
| container | `ivrm-velocity` |
| container | `mc-resource` |
| container | `mc-resource-router` |
| systemd | `ivrm-agent` |

存在しないcontainerはReporterがskipします。`mc-block`はMode切替を見越したallowlistです。

## Rollout states

Production DBへLog Viewer Migrationが未適用の場合、`/logs`はログ0件と推測しません。`Log storageはまだ利用できません`というwarning stateを表示し、Client pollingを開始しません。

Reporterも既定値は`IVRM_LOG_REPORTING_ENABLED=false`です。DB / Web / OCI unitの確認が終わるまで収集・送信しません。

## Safe rollout

### 1. Migration

次のMigrationを順番にProductionへ適用します。

```text
202608180001_console_log_viewer.sql
202608180002_console_log_retention_schedule.sql
202608180003_console_log_read_stable_time.sql
202608180004_console_log_time_window.sql
```

v1 Read RPCは互換性のため残し、Webはv2を使用します。v2ではtime windowを5 / 15 / 60 / 360 / 1440分のallowlistに限定します。

確認:

```sql
select to_regclass('public.console_log_entries') as entries_table,
       to_regclass('public.console_log_ingest_requests') as requests_table;

select to_regprocedure(
  'public.get_console_logs_v2(text,text,text,text,integer,bigint,integer)'
) as log_read_v2;

select jobid, jobname, schedule
from cron.job
where jobname = 'ivrm-console-log-retention-v1';
```

両Tableと`get_console_logs_v2`がnon-nullで、Retention Jobが1件だけ存在することを確認します。

権限確認:

```sql
select has_function_privilege(
  'anon',
  'public.get_console_logs_v2(text,text,text,text,integer,bigint,integer)',
  'EXECUTE'
) as anon_can_read,
has_function_privilege(
  'authenticated',
  'public.get_console_logs_v2(text,text,text,text,integer,bigint,integer)',
  'EXECUTE'
) as authenticated_can_read,
has_function_privilege(
  'service_role',
  'public.get_console_logs_v2(text,text,text,text,integer,bigint,integer)',
  'EXECUTE'
) as service_role_can_read;
```

期待値は`false / false / true`です。

### 2. Web Production

PR merge後のmainがVercel ProductionでREADYになり、`/logs`が共通Console Shell配下に表示されることを確認します。

- 未認証ユーザーは既存Discord Login境界を通る。
- NavigationはMinecraft → Logs → Operationsの順を維持する。
- Reporterはまだ有効にしない。

### 3. OCI Log Reporterだけをstage

最新mainをcloneし、Log専用stage scriptを実行します。

```bash
bash /tmp/ivrm-dashboard/deploy/oci/stage-log-reporter.sh
```

このscriptはMinecraft、IVRM Agent、Docker Snapshot、TPS/MSPT Performanceを再起動・変更しません。既存Performanceを維持したままLog ReporterだけをOFF状態で配置します。

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

`update-monitoring-stack.sh`にもLog Reporter配置を含めますが、同scriptは安全のためPerformanceとLog ReportingをOFFへ戻します。Log Viewer単独rolloutでは`stage-log-reporter.sh`を優先します。

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

まず件数とsourceだけを確認します。

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

Retention確認:

```sql
select count(*) as recent_rows,
       min(received_at) as oldest,
       max(received_at) as latest
from public.console_log_entries
where received_at >= now() - interval '24 hours';
```

### 6. Browser

Discord認証済みで`/logs`を開き、次を確認します。

- 共通Console Shell / Minecraft navigationから到達できる
- Source filter
- Level filter
- 本文検索
- 表示期間 5m / 15m / 1h / 6h / 24h
- 最新N行 100 / 300 / 500
- Follow ON/OFF
- 自動スクロール ON/OFF
- Follow ON + 自動スクロール OFFで新着取得だけ継続できる
- 過去へスクロールした場合はAuto-scrollがPAUSEDになり、位置が勝手に戻らない
- `最新へ`で末尾へ戻れる
- Filter変更時に変更前ログが残らない
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

このRollbackはMinecraft、Velocity、既存Heartbeat、Docker Snapshot、TPS/MSPT収集を変更しません。

DB migrationはログ収集停止のためにrollbackしません。Table/RPC削除よりReporter停止を優先し、既存データは24時間Retentionで自然削除します。

## Future reuse

Phase B以降では、このLog ViewerをOperation Terminalへ再利用します。

- start / stop / restart実行中ログ
- NeoForge ready判定までの起動ログ
- Mode切替 (`mc-main` / `mc-block`) のprogress
- 許可済みMinecraft commandの結果

汎用OS shellとは分離し、Operation API / RBAC / CSRF / Idempotency / Lock / Auditを満たす操作だけを表示します。
