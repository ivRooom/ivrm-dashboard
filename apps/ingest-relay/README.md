# ingest-relay (予備 ingest 受信サービス)

Issue #242 (A案)。Console (Vercel) が Hobby fair use 超過などで停止しても監視 ingest が止まらないよう、DB ホスト上で **tailnet 限定** で待ち受ける予備の受け口。

## 仕様

- 受ける経路は本系と同一: `POST /api/agent/heartbeat` / `cloud` / `backups` / `logs`、`GET /healthz`。
- 認証は本系 `apps/web/lib/operation-agent-auth-core.ts` と同一: サーバー別 secret による HMAC-SHA256 (`timestamp.nonce.body`)、timestamp の許容ずれ ±300 秒、nonce は使い捨て (DB 関数側で再生検知)。
- 永続化は本系と同じ PostgREST RPC (`insert_agent_heartbeat_v3` / `ingest_cloud_monitor_v1` / `ingest_backup_report_v1` / `ingest_console_log_report_v1`) に委ね、結果文字列 (`accepted` / `replayed_request` など) の HTTP ステータスへの対応も本系と揃えている。
- ペイロードの詳細検証は DB 関数側の原子検証が正本。本サービスは構造の最小チェック (必須フィールドと型) のみ行う。
- 依存は Python 標準ライブラリのみ。

## 設定

環境変数 (詳細は `deploy/systemd/ivrm-ingest-relay.env.example`):

- `IVRM_RELAY_BIND` — 待ち受け `host:port`。**必ず tailnet IP を指定する**。
- `IVRM_RELAY_SECRETS_FILE` — `serverId -> secret` の JSON ファイル。Vercel 側の `IVRM_AGENT_SECRETS_JSON` (base + additional 統合) と同一内容にする。
- `IVRM_RELAY_POSTGREST_URL` / `IVRM_RELAY_SERVICE_KEY` — 本系 Web と同じ PostgREST 宛先と service role key。

## 配置

systemd unit は `deploy/systemd/ivrm-ingest-relay.service`。配置先ホストでの有効化は Owner ゲート (Issue #242 の S3)。

## テスト

```sh
python3 -m unittest test_relay
```

## 送信側のフェイルオーバー

- Go agent: `IVRM_AGENT_FALLBACK_ENDPOINT`
- cloud-collector: 設定 JSON の `ingestUrl` / `ingestFallbackUrl`
- backup reporter: `IVRM_AGENT_BACKUP_FALLBACK_ENDPOINT`
- log reporter: `IVRM_AGENT_LOG_FALLBACK_ENDPOINT`

いずれも主系が transport error または非 2xx のときだけ予備へ送り、試行ごとに nonce を新規発行する。主系の応答が失われた場合に予備へ再送されても、同一内容の再投入として処理されるため実害はない (heartbeat は直近値の再記録、backup / log / cloud は同一内容の再適用)。
