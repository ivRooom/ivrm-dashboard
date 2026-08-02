# OCI Docker・Minecraft監視の配置と更新

Docker Socketを非特権の`ivrm-agent`へ渡さず、rootで動く短時間のsystemd oneshotが許可済みコンテナと固定されたMinecraft接続先だけを調査します。収集結果は機密情報を除いたJSONとして`/run/ivrm-agent/docker-state.json`へ書き出し、Go Agentはそのファイルだけを読み取ります。

## 構成

```text
root / systemd timer（10秒）
  ├─ docker inspect（許可済み4コンテナのみ）
  ├─ docker stats --no-stream（稼働中のみ）
  ├─ 127.0.0.1:25565 Minecraft Ping
  └─ mc-main内部IP:25565 Minecraft Ping
       └─ /run/ivrm-agent/docker-state.json
            └─ ivrm-agent（非特権）
                 └─ HTTPS Heartbeat
```

Agentを`docker`グループへ追加しません。Docker Socket、環境変数、Mount、内部IP、ログ本文、Secretは外部へ送信しません。Minecraft Probeの接続先・コンテナ名・ネットワーク・ポートはコード内の許可リストへ固定し、環境変数から任意接続先を指定できない設計です。

## 収集対象

`/etc/ivrm-agent/docker.env`で次のコンテナだけを許可します。

```env
IVRM_DOCKER_CONTAINERS=mc-main,ivrm-velocity,mc-resource,mc-resource-router
IVRM_DOCKER_SNAPSHOT_PATH=/run/ivrm-agent/docker-state.json
IVRM_DOCKER_BINARY=/usr/bin/docker
IVRM_MINECRAFT_PROBE_ENABLED=true
```

Collectorは次の値だけをJSONへ保存します。

### Docker

- State、Health、RestartCount、OOMKilled、ExitCode
- CPU使用率
- メモリ使用量・上限
- Network RX / TX累計
- Block Read / Write累計
- PIDs

### Minecraft

- 公開`127.0.0.1:25565`の到達性・レイテンシ・Version・Online・Max
- Velocityから利用する`mc-main:25565`相当の内部到達性
- `ivrm-velocity`の`25565/tcp`公開設定
- `mc-main`の`25565/tcp`直接公開設定
- `mc-main`の`24454/udp`Voice Chat公開設定

内部IP、プレイヤーIP、RCON、forwarding secret、PCF secretは収集しません。停止中・未作成のコンテナではリソース値を`null`にします。`docker stats`またはMinecraft Pingだけが失敗しても、取得できた状態情報を保存します。

## 初回配置

リポジトリを取得したディレクトリで実行します。

```bash
sudo install -d -o root -g root -m 755 /usr/local/libexec
sudo install -o root -g root -m 755 \
  deploy/oci/ivrm-agent-docker-snapshot.py \
  /usr/local/libexec/ivrm-agent-docker-snapshot

sudo install -o root -g root -m 644 \
  deploy/oci/ivrm-agent-docker-snapshot.service \
  /etc/systemd/system/ivrm-agent-docker-snapshot.service

sudo install -o root -g root -m 644 \
  deploy/oci/ivrm-agent-docker-snapshot.timer \
  /etc/systemd/system/ivrm-agent-docker-snapshot.timer

sudo install -o root -g root -m 644 \
  deploy/oci/ivrm-agent.tmpfiles.conf \
  /etc/tmpfiles.d/ivrm-agent.conf

sudo install -o root -g root -m 600 \
  deploy/oci/docker.env.example \
  /etc/ivrm-agent/docker.env
```

Runtimeディレクトリを作成します。

```bash
sudo systemd-tmpfiles --create /etc/tmpfiles.d/ivrm-agent.conf
```

Go Agentの環境ファイルへスナップショットパスを追加します。追記前に必ず改行を確保します。

```bash
sudo python3 - <<'PY'
from pathlib import Path

path = Path("/etc/ivrm-agent/agent.env")
text = path.read_text().rstrip("\n")
line = "IVRM_AGENT_DOCKER_SNAPSHOT_PATH=/run/ivrm-agent/docker-state.json"

if not any(item.startswith("IVRM_AGENT_DOCKER_SNAPSHOT_PATH=") for item in text.splitlines()):
    text += "\n" + line

path.write_text(text + "\n")
PY

sudo chown root:ivrm-agent /etc/ivrm-agent/agent.env
sudo chmod 640 /etc/ivrm-agent/agent.env
```

## Agent `0.5.0`への更新

PRのマージ後、`main`を取得したディレクトリで実行します。

```bash
set -euo pipefail

cd /tmp
rm -rf ivrm-dashboard
git clone --depth 1 https://github.com/ivRooom/ivrm-dashboard.git
cd ivrm-dashboard

git rev-parse --short HEAD
python3 -m unittest deploy/oci/test_ivrm_agent_docker_snapshot.py

cd apps/agent
go test ./...
go build -trimpath -ldflags='-s -w' \
  -o /tmp/ivrm-agent \
  ./cmd/ivrm-agent
cd ../..
```

Collector、systemd unit、設定例、Agentを置き換えます。既存のAgent Secretは変更しません。

```bash
sudo install -o root -g root -m 755 \
  deploy/oci/ivrm-agent-docker-snapshot.py \
  /usr/local/libexec/ivrm-agent-docker-snapshot

sudo install -o root -g root -m 644 \
  deploy/oci/ivrm-agent-docker-snapshot.service \
  /etc/systemd/system/ivrm-agent-docker-snapshot.service

sudo install -o root -g root -m 755 \
  /tmp/ivrm-agent \
  /usr/local/bin/ivrm-agent
```

`/etc/ivrm-agent/docker.env`はSecretを含まないため、次の固定値へ更新します。

```bash
sudo tee /etc/ivrm-agent/docker.env >/dev/null <<'EOF'
IVRM_DOCKER_CONTAINERS=mc-main,ivrm-velocity,mc-resource,mc-resource-router
IVRM_DOCKER_SNAPSHOT_PATH=/run/ivrm-agent/docker-state.json
IVRM_DOCKER_BINARY=/usr/bin/docker
IVRM_MINECRAFT_PROBE_ENABLED=true
EOF
sudo chown root:root /etc/ivrm-agent/docker.env
sudo chmod 600 /etc/ivrm-agent/docker.env
```

Collectorを先に実行し、JSONを検証します。

```bash
sudo systemctl daemon-reload
sudo systemd-analyze verify \
  /etc/systemd/system/ivrm-agent-docker-snapshot.service \
  /etc/systemd/system/ivrm-agent-docker-snapshot.timer
sudo systemctl start ivrm-agent-docker-snapshot.service
sudo python3 -m json.tool /run/ivrm-agent/docker-state.json
```

正常時は`containers`が4件になり、`minecraft`に公開側・バックエンド側の到達性とポート公開状態が入ります。内部IPやSecretがJSONに含まれてはいけません。

Agentを再起動します。

```bash
sudo systemctl restart ivrm-agent
sleep 20
```

## 確認

```bash
sudo systemctl status \
  ivrm-agent-docker-snapshot.timer \
  --no-pager -l

sudo journalctl \
  -u ivrm-agent-docker-snapshot.service \
  -n 20 \
  --no-pager -l

sudo systemctl status ivrm-agent --no-pager -l
sudo journalctl -u ivrm-agent -n 20 --no-pager -l
```

成功時は次の形式になります。

```text
"msg":"IVRM Agentを開始します","version":"0.5.0"
"msg":"Heartbeatを送信しました","containers":4,"minecraft":true
```

公開設定も確認します。

```bash
sudo docker port ivrm-velocity 25565/tcp
sudo docker port mc-main 25565/tcp
sudo docker port mc-main 24454/udp
```

期待結果:

- `ivrm-velocity 25565/tcp`: ホスト`25565`へ公開
- `mc-main 25565/tcp`: 公開なし
- `mc-main 24454/udp`: ホスト`24454`へ公開

## 障害時の挙動

- Docker停止・権限エラー・`docker inspect`の不正応答時は新しいスナップショットを作成しません。
- `docker stats`のみ失敗した場合、対象コンテナのリソース値を`null`にして状態情報を保存します。
- 公開Pingまたは内部Pingが失敗した場合、対象Probeを`reachable=false`としてDocker監視とHost Heartbeatを継続します。
- スナップショットが45秒より古い場合、AgentはDocker・Minecraft情報を送信せずHost Heartbeatだけを継続します。
- 指定コンテナが存在しない場合は`not_found`として保存します。
- 監視障害でMinecraftコンテナを停止・起動・再起動する処理はありません。
