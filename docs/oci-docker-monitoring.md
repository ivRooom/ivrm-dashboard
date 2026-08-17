# OCI Docker・Minecraft監視の配置と更新

Docker Socketを非特権の`ivrm-agent`へ渡さず、rootで動く短時間のsystemd oneshotが許可済みコンテナと固定されたMinecraft接続先だけを調査します。収集結果は機密情報を除いたJSONとして`/run/ivrm-agent/docker-state.json`へ書き出し、Go Agentはそのファイルだけを読み取ります。

## 構成

```text
root / systemd timer（10秒）
  ├─ docker inspect（許可済み4コンテナのみ）
  ├─ docker stats --no-stream（稼働中のみ）
  ├─ 127.0.0.1:25565 Minecraft Ping
  ├─ mc-main内部IP:25565 Minecraft Ping
  └─ Performance有効時のみ
       docker exec mc-main rcon-cli spark tps
          └─ TPS / MSPTだけ抽出
              └─ /run/ivrm-agent/docker-state.json
                   └─ ivrm-agent（非特権 / 0.6.0+）
                        └─ HTTPS Heartbeat
```

Agentを`docker`グループへ追加しません。Docker Socket、環境変数、Mount、内部IP、ログ本文、Secretは外部へ送信しません。Minecraft Probeの接続先・コンテナ名・ネットワーク・ポートはコード内の許可リストへ固定し、環境変数から任意接続先を指定できない設計です。

TPS / MSPT収集では`mc-main`コンテナ内の`rcon-cli`だけを使用します。RCON passwordをホスト側Collector、Go Agent、Console、Supabaseへ渡しません。RCONポートもホストやインターネットへ公開しません。Collectorから実行できる対象は固定`mc-main`、コマンドは固定`spark tps`だけで、shellやユーザー入力は利用しません。

## 収集対象

`/etc/ivrm-agent/docker.env`で次のコンテナだけを許可します。

```env
IVRM_DOCKER_CONTAINERS=mc-main,ivrm-velocity,mc-resource,mc-resource-router
IVRM_DOCKER_SNAPSHOT_PATH=/run/ivrm-agent/docker-state.json
IVRM_DOCKER_BINARY=/usr/bin/docker
IVRM_MINECRAFT_PROBE_ENABLED=true
IVRM_MINECRAFT_PERFORMANCE_ENABLED=false
```

`IVRM_MINECRAFT_PERFORMANCE_ENABLED`は既定`false`です。Sparkとコンテナ内RCON CLIの動作を確認してから明示的に有効化します。

### Docker

- State、Health、RestartCount、OOMKilled、ExitCode
- CPU使用率
- メモリ使用量・上限
- Network RX / TX累計
- Block Read / Write累計
- PIDs

### Minecraft Status

- 公開`127.0.0.1:25565`の到達性・レイテンシ・Version・Online・Max
- Velocityから利用する`mc-main:25565`相当の内部到達性
- `ivrm-velocity`の`25565/tcp`公開設定
- `mc-main`の`25565/tcp`直接公開設定
- `mc-main`の`24454/udp`Voice Chat公開設定

### Minecraft Performance（Spark）

Performanceを有効化した場合だけ、`spark tps`から次の実測値を抽出します。

- TPS 1分 / 5分 / 15分
- 直近1分のTick duration median
- 直近1分のTick duration 95 percentile
- 直近1分のTick duration max
- Source=`spark`

TPS / MSPTをOnline人数、Status Probe Latency、Docker CPUなどから推定しません。SparkがTick durationを提供しない場合や出力を安全に解釈できない場合はPerformance全体を欠損扱いにします。

内部IP、プレイヤーIP、RCON password、forwarding secret、PCF secretは収集しません。停止中・未作成のコンテナではリソース値を`null`にします。`docker stats`、Minecraft Ping、Spark Performanceのいずれかだけが失敗しても、取得できた監視情報を継続します。

## 初回配置 / 0.6.0更新

リポジトリを取得したディレクトリで、CollectorテストとAgentテストを先に実行します。

```bash
python3 -m unittest deploy/oci/test_ivrm_agent_docker_snapshot.py
python3 -m unittest deploy/oci/test_ivrm_agent_minecraft_performance.py
python3 -m unittest deploy/oci/test_ivrm_backup_reporter.py

cd apps/agent
go test ./...
go build -trimpath -ldflags='-s -w' \
  -o /tmp/ivrm-agent \
  ./cmd/ivrm-agent
cd ../..
```

RuntimeディレクトリとCollectorを配置します。

```bash
sudo install -d -o root -g root -m 755 /usr/local/libexec

sudo install -o root -g root -m 755 \
  deploy/oci/ivrm-agent-docker-snapshot.py \
  /usr/local/libexec/ivrm-agent-docker-snapshot

sudo install -o root -g root -m 755 \
  deploy/oci/ivrm-agent-minecraft-performance.py \
  /usr/local/libexec/ivrm-agent-minecraft-performance

sudo install -o root -g root -m 644 \
  deploy/oci/ivrm-agent-docker-snapshot.service \
  /etc/systemd/system/ivrm-agent-docker-snapshot.service

sudo install -o root -g root -m 644 \
  deploy/oci/ivrm-agent-docker-snapshot.timer \
  /etc/systemd/system/ivrm-agent-docker-snapshot.timer

sudo install -o root -g root -m 644 \
  deploy/oci/ivrm-agent.tmpfiles.conf \
  /etc/tmpfiles.d/ivrm-agent.conf

sudo install -o root -g root -m 755 \
  /tmp/ivrm-agent \
  /usr/local/bin/ivrm-agent

sudo systemd-tmpfiles --create /etc/tmpfiles.d/ivrm-agent.conf
```

Go Agentの環境ファイルにスナップショットパスが無ければ追加します。既存Agent Secretは変更しません。

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

最初はPerformanceをOFFのまま配置します。

```bash
sudo tee /etc/ivrm-agent/docker.env >/dev/null <<'EOF'
IVRM_DOCKER_CONTAINERS=mc-main,ivrm-velocity,mc-resource,mc-resource-router
IVRM_DOCKER_SNAPSHOT_PATH=/run/ivrm-agent/docker-state.json
IVRM_DOCKER_BINARY=/usr/bin/docker
IVRM_MINECRAFT_PROBE_ENABLED=true
IVRM_MINECRAFT_PERFORMANCE_ENABLED=false
EOF
sudo chown root:root /etc/ivrm-agent/docker.env
sudo chmod 600 /etc/ivrm-agent/docker.env
```

systemd unitと既存Status監視を先に確認します。

```bash
sudo systemctl daemon-reload
sudo systemd-analyze verify \
  /etc/systemd/system/ivrm-agent-docker-snapshot.service \
  /etc/systemd/system/ivrm-agent-docker-snapshot.timer
sudo systemctl start ivrm-agent-docker-snapshot.service
sudo python3 -m json.tool /run/ivrm-agent/docker-state.json
sudo systemctl restart ivrm-agent
sleep 20
```

この段階では`minecraft.performance`が無くても正常です。既存Status Probeと4コンテナ監視が継続していることを確認します。

## Spark / RCON確認とPerformance有効化

PerformanceをONにする前に、`mc-main`内でSparkコマンドが成功することを確認します。

```bash
sudo docker exec mc-main rcon-cli spark tps
```

期待する内容はTPS 1m / 5m / 15mと、Tick durationsの直近1分値を含むSparkのhealth出力です。RCON passwordをコマンドラインへ付与しないでください。

正常に取得できたらPerformanceをONにします。

```bash
sudo sed -i \
  's/^IVRM_MINECRAFT_PERFORMANCE_ENABLED=.*/IVRM_MINECRAFT_PERFORMANCE_ENABLED=true/' \
  /etc/ivrm-agent/docker.env

sudo systemctl start ivrm-agent-docker-snapshot.service
sudo python3 -m json.tool /run/ivrm-agent/docker-state.json
sudo systemctl restart ivrm-agent
sleep 20
```

正常時は`minecraft.performance`に次のキーだけが追加されます。

```json
{
  "source": "spark",
  "tps1m": 20.0,
  "tps5m": 20.0,
  "tps15m": 20.0,
  "msptMedian1m": 3.2,
  "msptP95_1m": 8.4,
  "msptMax1m": 21.7
}
```

値は例です。固定値として設定しないでください。

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

Agent 0.6.0正常時は次の形式になります。

```text
"msg":"IVRM Agentを開始します","version":"0.6.0"
"msg":"Heartbeatを送信しました","containers":4,"minecraft":true,"minecraft_performance":true
```

Performanceが無効・取得不能の場合は`minecraft_performance:false`でもHost / Container / Minecraft Status Heartbeatは継続します。

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
- RCONポート: ホストへ公開しない

## 障害時の挙動

- Docker停止・権限エラー・`docker inspect`の不正応答時は新しいスナップショットを作成しません。
- `docker stats`のみ失敗した場合、対象コンテナのリソース値を`null`にして状態情報を保存します。
- 公開Pingまたは内部Pingが失敗した場合、対象Probeを`reachable=false`としてDocker監視とHost Heartbeatを継続します。
- Spark / RCON / Performance parserが失敗した場合、Performanceを送信せずStatus Probeを継続します。Spark出力本文はjournalへ記録しません。
- Agent側でPerformanceだけが不正な場合、そのPerformanceだけを破棄しStatus Probeを保持します。
- スナップショットが45秒より古い場合、AgentはDocker・Minecraft情報を送信せずHost Heartbeatだけを継続します。
- 指定コンテナが存在しない場合は`not_found`として保存します。
- 監視障害でMinecraftコンテナを停止・起動・再起動する処理はありません。
