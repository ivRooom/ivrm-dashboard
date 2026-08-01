# OCI Docker監視の配置・更新

Docker Socketを非特権の`ivrm-agent`へ渡さず、rootで動く短時間のsystemd oneshotが許可済みコンテナだけを調査します。収集結果は機密情報を除いたJSONとして`/run/ivrm-agent/docker-state.json`へ書き出し、Go Agentはそのファイルだけを読み取ります。

## 構成

```text
root / systemd timer（10秒）
  ├─ docker inspect（許可済み3コンテナのみ）
  └─ docker stats --no-stream（稼働中のみ）
       └─ /run/ivrm-agent/docker-state.json
            └─ ivrm-agent（非特権）
                 └─ HTTPS Heartbeat
```

Agentを`docker`グループへ追加しません。Docker Socket、環境変数、Mount、IP、ログ本文、Secretは外部へ送信しません。

## 収集対象

`/etc/ivrm-agent/docker.env`で次のコンテナだけを許可します。

```env
IVRM_DOCKER_CONTAINERS=mc-main,mc-resource,mc-resource-router
IVRM_DOCKER_SNAPSHOT_PATH=/run/ivrm-agent/docker-state.json
IVRM_DOCKER_BINARY=/usr/bin/docker
```

Collectorは次の値だけをJSONへ保存します。

- State、Health、RestartCount、OOMKilled、ExitCode
- CPU使用率
- メモリ使用量・上限
- Network RX / TX累計
- Block Read / Write累計
- PIDs

停止中・未作成のコンテナではリソース値を`null`にします。`docker stats`だけが失敗した場合も状態情報は保存します。

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

実際のコンテナ名が異なる場合は、root権限で`/etc/ivrm-agent/docker.env`だけを修正します。

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

## Agent `0.4.0`への更新

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

CollectorとAgentを置き換えます。既存の環境ファイルとSecretは変更しません。

```bash
sudo install -o root -g root -m 755 \
  deploy/oci/ivrm-agent-docker-snapshot.py \
  /usr/local/libexec/ivrm-agent-docker-snapshot

sudo install -o root -g root -m 755 \
  /tmp/ivrm-agent \
  /usr/local/bin/ivrm-agent
```

Collectorを先に実行し、JSONを検証します。

```bash
sudo systemctl start ivrm-agent-docker-snapshot.service
sudo python3 -m json.tool /run/ivrm-agent/docker-state.json
```

稼働中コンテナには次のキーが数値で入り、停止中コンテナでは`null`になります。

```text
cpuPercent
memoryUsageBytes
memoryLimitBytes
networkRxBytes
networkTxBytes
blockReadBytes
blockWriteBytes
pids
```

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
"msg":"IVRM Agentを開始します","version":"0.4.0"
"msg":"Heartbeatを送信しました","containers":3
```

スナップショットに機密情報が含まれていないことも確認します。

```bash
sudo python3 - <<'PY'
import json
from pathlib import Path

snapshot = json.loads(Path("/run/ivrm-agent/docker-state.json").read_text())
print("generatedAt:", snapshot.get("generatedAt"))
for item in snapshot.get("containers", []):
    print(
        item.get("name"),
        item.get("state"),
        item.get("cpuPercent"),
        item.get("memoryUsageBytes"),
        item.get("pids"),
    )
PY
```

## 障害時の挙動

- Docker停止・権限エラー・`docker inspect`の不正応答時は新しいスナップショットを作成しません。
- `docker stats`のみ失敗した場合、対象コンテナのリソース値を`null`にして状態情報を保存します。
- スナップショットが45秒より古い場合、Agentはコンテナ配列を送信せずHost Heartbeatだけを継続します。
- 指定コンテナが存在しない場合は`not_found`として保存します。
- Docker監視の障害でMinecraftコンテナを停止・起動・再起動する処理はありません。
