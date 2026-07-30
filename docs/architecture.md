# IVRM Dashboard アーキテクチャ

## 責務

- `apps/web`: Next.js管理画面。Vercelへ配置する。
- `apps/agent`: 各ホストでメトリクスを収集し、外向きHTTPSで送信する。
- `supabase`: 状態、履歴、権限、監査ログ、Realtime配信を管理する。

```text
OCI / Lightsail / EC2
  └─ IVRM Agent
       ├─ /proc/loadavg
       ├─ /proc/meminfo
       ├─ /proc/uptime
       └─ statfs
            ↓ HMAC署名付きHTTPS
       Heartbeat API
            ↓
       Supabase Postgres
            ↓
       console.ivrm.jp
```

## セキュリティ

- Docker Socket、Docker API、SSH、RCONをインターネットへ公開しない。
- MVPは読み取り専用とし、任意Shell・任意Dockerコマンド・任意RCONを実装しない。
- Agent Secretをログへ出力しない。
- 受信APIではAgent ID、Timestamp、HMAC署名、再送、頻度、サイズを検証する。

## 次の実装

1. Heartbeat受信APIとHMAC検証
2. SupabaseへのHeartbeat保存
3. Docker Unix Socketから読み取り専用stats収集
4. Stale / Offline / Error判定
5. Cloudflare AccessとDiscord OAuth
