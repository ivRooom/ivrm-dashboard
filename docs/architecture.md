# IVRM Dashboard アーキテクチャ

## 責務

- `apps/web`: Next.js管理画面とHeartbeat受信API。Vercelへ配置する。
- `apps/agent`: 各ホストでメトリクスを収集し、外向きHTTPSで送信する。
- `supabase`: MVPでは状態・履歴を管理する。Realtime配信、アプリ利用者の権限、監査ログは将来実装する。

```text
OCI / Lightsail / EC2
  └─ IVRM Agent
       ├─ /proc/loadavg
       ├─ /proc/meminfo
       ├─ /proc/uptime
       └─ statfs
            ↓ HMAC署名付きHTTPS
       POST /api/agent/heartbeat
            ↓
       Supabase Postgres
            ↓
       console.ivrm.jp
```

## Heartbeat認証

Agentは毎回、次のヘッダーを付与する。

```text
X-IVRM-Agent-ID
X-IVRM-Timestamp
X-IVRM-Nonce
X-IVRM-Signature
```

署名対象は次のバイト列とする。

```text
<timestamp>.<nonce>.<raw request body>
```

受信APIは次を検証する。

1. 本文サイズが32KiB以下
2. JSONスキーマと数値範囲
3. Headerと本文のServer ID一致
4. Timestampが現在時刻から5分以内
5. Nonceが16バイト乱数の16進表現
6. HMAC-SHA256署名を定時間比較
7. HostがDB上で有効
8. Host行ロック内で最終受信から8秒以上経過していることを確認
9. NonceのDB一意制約による再送拒否

## Secret管理

- Agent側: `IVRM_AGENT_TOKEN`
- Web側: `IVRM_AGENT_SECRETS_JSON`
- Supabase Service Role Key: `SUPABASE_SERVICE_ROLE_KEY`

すべてGitHubへ保存せず、OCIの権限制限済み環境ファイルとVercelの暗号化済みEnvironment Variablesへ保存する。

## セキュリティ

- Docker Socket、Docker API、SSH、RCONをインターネットへ公開しない。
- MVPは読み取り専用とし、任意Shell・任意Dockerコマンド・任意RCONを実装しない。
- Agent Secretをログへ出力しない。
- SupabaseテーブルはRLSを有効化し、受信APIだけがService Roleで書き込む。
- Heartbeat保存はPostgres関数内でHostロック、レート制限確認、Nonce重複判定、INSERTを原子的に行う。
- APIエラーでSecret、署名、本文、Supabaseレスポンスを返却しない。

## OCIへのAgent導入準備

1. 32文字以上のランダムSecretを生成する。
2. Supabaseの`hosts`へ`server_id = oci-minecraft-01`を登録する。
3. WebとAgentへ同じSecretを安全に設定する。
4. Supabase migrationを適用する。
5. VercelへWebをデプロイする。
6. Agentをsystemdで起動する。
7. Heartbeat保存とStale判定を確認する。

## 次の実装

1. Docker Unix Socketから読み取り専用stats収集
2. Stale / Offline / ErrorのDB ViewまたはServer Component判定
3. Console画面をSupabase実データへ接続
4. Minecraft TPS / MSPT / Player / Backup収集
5. Cloudflare AccessとDiscord OAuth
