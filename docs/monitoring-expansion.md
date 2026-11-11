# 監視拡大ランブック（Issue #184）

`oci-minecraft-01` のみだった Container / Host 監視を、全サーバーへ広げるための手順。
前提として誤検知の是正（PR #187）と minutely timer の正常稼働が完了していること。

## 仕組みの要点

- Agent（`apps/agent`、Go）は15〜30秒ごとに Console の `/api/agent/heartbeat` へ
  Host 指標と、スナップショットファイルがあれば Container 一覧を送る
- Container 収集は Agent 本体ではなく、root の oneshot（`deploy/oci/` の
  snapshot スクリプト＋timer）が許可リスト内のコンテナだけを調べて
  `/run/ivrm-agent/docker-state.json` に書き、Agent はそのファイルだけを読む
- 認証はホストごとの秘密値で HMAC 署名する。Console 側は Vercel 環境変数
  `IVRM_AGENT_SECRETS_JSON`（server_id → 秘密値の JSON）を参照する
- Heartbeat の Container 上限は20件（`apps/web/lib/heartbeat.ts` の `MAX_CONTAINERS`）
- 監視の有効化は2点セット: `hosts.enabled = true` と、コンテナがある場合は
  `container_expectations` の seed（無いコンテナは reconcile が `running` 既定で
  評価するため、oneshot 等は必ず `on-demand` で登録する）

## ホスト別の作業

### 1. aws-app-01（EC2）— スナップショット経路の追加のみ

Agent は導入済みで Heartbeat も流れているが、`containers: 0`（スナップショット
未設定）。登録も有効化も不要で、ホスト側の追加だけで完結する。

1. `deploy/oci/` の snapshot スクリプト・service・timer・tmpfiles を OCI と同じ
   パスへ配置する（`/usr/local/libexec/ivrm-agent-docker-snapshot`、
   `/etc/systemd/system/ivrm-agent-docker-snapshot.{service,timer}`、
   `/etc/tmpfiles.d/ivrm-agent.conf`）
2. `deploy/hosts/aws-app-01/docker.env.example` を `/etc/ivrm-agent/docker.env`
   （root:root 600）として配置する
3. `/etc/ivrm-agent/agent.env` に
   `IVRM_AGENT_DOCKER_SNAPSHOT_PATH=/run/ivrm-agent/docker-state.json` を足し、
   `ivrm-agent` を再起動する
4. `deploy/sql/register-monitoring-expansion.sql` の aws-app-01 分を実行する
5. 確認: Agent ログの `containers` が 13 になること、Console にコンテナが
   並ぶこと、数分待って不要な Signal が立たないこと

### 2. lightsail-herta（Lightsail）— Agent 新規導入

1. Agent バイナリを用意する。対象は x86_64。このホストには Go が無いため、
   Go のある環境（OCI ホスト等）で
   `GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' ./cmd/ivrm-agent`
   を実行し、成果物を `/usr/local/bin/ivrm-agent` へ配置する
2. `ivrm-agent` ユーザーと `/etc/ivrm-agent` を作り、
   `deploy/hosts/lightsail-herta/agent.env.example` を雛形に `agent.env`
   （root:ivrm-agent 640）を作成する。TOKEN は新規に生成したランダム値
3. Console の `IVRM_AGENT_SECRETS_JSON` に `"lightsail-herta": "<同じ値>"` を
   追加し、Console を再デプロイする（本番 env 変更＝Owner ゲート）
4. OCI と同じ systemd unit で `ivrm-agent` を enable --now する
5. スナップショット一式を aws-app-01 と同様に配置し、
   `deploy/hosts/lightsail-herta/docker.env.example` を docker.env とする
6. `register-monitoring-expansion.sql` の lightsail-herta 分（enabled 化と
   expectations）を実行する
7. 確認: Heartbeat 到達、containers が 8 になること、herta-migrator-1 の
   停止で通知が出ないこと（on-demand の実地確認）

注意: このホストは 2 vCPU / 約2GiB と小さい。Agent 自体は OCI 実測で
メモリ数MB級だが、導入は負荷の低い時間帯に行い、導入直後はホスト指標を
Console で見守ること。

### 3. ivrm-db-postgres-01（Lightsail / PG17）— Heartbeat のみ

Docker が無いホストなので、監視単位は Host の死活とホスト指標のみ。
PostgreSQL サービス自体の監視は Agent の現行範囲外（将来課題として別途設計する）。

1. Agent バイナリ（linux/amd64）を lightsail-herta と同じ手順で配置する
2. `deploy/hosts/ivrm-db-postgres-01/agent.env.example` を雛形に agent.env を
   作成する（スナップショット関連の変数は入れない）
3. `IVRM_AGENT_SECRETS_JSON` に `"ivrm-db-postgres-01": "<値>"` を追加し
   再デプロイする（Owner ゲート）
4. `ivrm-agent` を enable --now する
5. `register-monitoring-expansion.sql` の hosts 行追加を実行する
6. 確認: Heartbeat 到達と Console の Host 一覧への表示。あわせて
   「Agent を止めると Host Offline の warning（45秒）→ critical（180秒）が
   立つ」ことを一度だけ実地確認すると、死活監視の配線が保証できる

## ロールバック

- どのホストも `systemctl disable --now ivrm-agent`（と snapshot timer）で
  監視だけを止められる。対象ホスト上の本業プロセスには影響しない
- 登録を取り消す場合は `hosts.enabled = false` に戻す（行は消さない）
