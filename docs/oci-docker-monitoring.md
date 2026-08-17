# OCI Docker・Minecraft監視の配置と更新

Docker Socketを非特権の`ivrm-agent`へ渡さず、rootで動く短時間のsystemd oneshotが許可済みコンテナと固定されたMinecraft接続先だけを調査します。収集結果は機密情報を除いたJSONとして`/run/ivrm-agent/docker-state.json`へ書き出し、Go Agentはそのファイルだけを読み取ります。

## 構成

```text
mc-main / NeoForge
  └─ IVRM Metrics Bridge（10秒）
       └─ Spark公開API
            ├─ TPS 1m / 5m / 15m
            └─ MSPT 1m median / p95 / max
                 ↓ atomic write
       /data/ivrm/metrics.json

root / systemd timer
  ├─ docker inspect（許可済み4コンテナのみ）
  ├─ docker stats --no-stream（稼働中のみ）
  ├─ 127.0.0.1:25565 Minecraft Ping
  ├─ mc-main内部:25565 Minecraft Ping
  └─ Performance有効時のみ
       docker exec mc-main cat /data/ivrm/metrics.json
          └─ schema / freshness / range validation
              └─ /run/ivrm-agent/docker-state.json
                   └─ ivrm-agent（非特権 / 0.6.0+）
                        └─ HTTPS Heartbeat
```

Agentを`docker`グループへ追加しません。Docker Socket、環境変数、Mount、内部IP、ログ本文、Secretは外部へ送信しません。

## TPS / MSPT収集方式

TPS / MSPTはSparkの人間向けcommand出力をparseしません。Production実機ではRCON自体は正常でも`spark tps`が部分応答または空応答になるケースがあったため、Performance監視ではRCONをデータAPIとして利用しません。

Minecraft内の`IVRM Metrics Bridge`がSpark公開APIを直接pollし、次の8 keyだけを構造化JSONへ書きます。

```json
{
  "generatedAt": "2026-08-17T12:30:00Z",
  "source": "spark",
  "tps1m": 20.0,
  "tps5m": 20.0,
  "tps15m": 20.0,
  "msptMedian1m": 3.2,
  "msptP95_1m": 8.4,
  "msptMax1m": 21.7
}
```

Host Collectorはexact schema、`source=spark`、timezone付き`generatedAt`、45秒以内のfreshness、future skew 5秒以内、TPS `0..1000`、MSPT `0..60000ms`、`median <= p95 <= max`を検証します。不正・stale・未生成の場合はPerformanceだけを欠損扱いにし、Host / Container / Minecraft Status Heartbeatは継続します。

## 収集対象

`/etc/ivrm-agent/docker.env`では次のコンテナだけを許可します。

```env
IVRM_DOCKER_CONTAINERS=mc-main,ivrm-velocity,mc-resource,mc-resource-router
IVRM_DOCKER_SNAPSHOT_PATH=/run/ivrm-agent/docker-state.json
IVRM_DOCKER_BINARY=/usr/bin/docker
IVRM_MINECRAFT_PROBE_ENABLED=true
IVRM_MINECRAFT_PERFORMANCE_ENABLED=false
```

`IVRM_MINECRAFT_PERFORMANCE_ENABLED`は既定`false`です。Metrics Bridgeのロードと構造化JSONの継続更新まで確認してから明示的に有効化します。

### Docker

- State / Health / RestartCount / OOMKilled / ExitCode
- CPU / Memory
- Network RX / TX
- Block Read / Write
- PIDs

### Minecraft Status

- 公開`127.0.0.1:25565`の到達性・Latency・Version・Online・Max
- `mc-main:25565`相当の内部到達性
- Velocity 25565/TCP公開設定
- Backend 25565/TCP非公開設定
- Voice Chat 24454/UDP公開設定

### Minecraft Performance

- TPS 1m / 5m / 15m
- MSPT 1m median / p95 / max
- Source=`spark`

TPS/MSPTをOnline人数、Ping、Docker CPUなどから推定しません。

## Agent / Collector更新

相対パスを手作業で実行せず、必ず更新スクリプトを使用します。

```bash
set -euo pipefail
cd /tmp
rm -rf ivrm-dashboard
git clone --depth 1 https://github.com/ivRooom/ivrm-dashboard.git
git -C /tmp/ivrm-dashboard rev-parse HEAD
bash /tmp/ivrm-dashboard/deploy/oci/update-monitoring-stack.sh
```

`update-monitoring-stack.sh`はGit checkout、Collector tests、Go test/build、既存Agent Secret、systemd unit、4コンテナ、Minecraft Statusを検証し、Performanceを必ずOFFへ戻したうえでAgentを再起動します。

正常な更新直後は次です。

```text
Agent: 0.6.0+
containers: 4
minecraft: true
minecraft_performance: false
```

## Metrics Bridgeの永続Mod source

Productionの`itzg/minecraft-server`構成では、`/mods`が永続Mod sourceで、起動時に`/data/mods`へ同期されます。

```text
Host persistent mods directory
        ↓ bind mount
container /mods
        ↓ startup sync
container /data/mods
        ↓ NeoForge load
IVRM Metrics Bridge
```

したがって`stage-minecraft-metrics-bridge.sh`は`/data/mods`へ直接JARを書きません。Docker mount metadataから`/mods`のHost sourceを解決し、Host側へJARを配置します。Hostパスはハードコードしません。

stage時に次を検証します。

- `mc-main` running
- container `/mods`と`/data/mods`が存在
- `/data/mods`にNeoForge版Sparkが存在
- Performance=false
- `/mods`のHost mount sourceを一意に解決可能
- JDK 21+、またはnetworkなし/read-only JDK builderを利用可能
- build成果物 / Host source / container `/mods` のSHA256一致
- 失敗時は旧Bridgeを復元、初回stageなら新JARを削除
- Minecraftを自動再起動しない
- Performanceを自動ONにしない

実行:

```bash
bash /tmp/ivrm-dashboard/deploy/oci/stage-minecraft-metrics-bridge.sh
```

## メンテナンス再起動後のBridge確認

通常の運用手順で`mc-main`を再起動します。再起動前はPerformanceをOFFのまま維持します。

起動時同期後、まずJARが`/data/mods`に入ったことを確認します。

```bash
sudo docker exec mc-main test -s /data/mods/ivrm-metrics-bridge.jar
echo "bridge_data_exit=$?"
```

次にNeoForge entrypointがロードされたことを確認します。

```bash
sudo docker logs mc-main --since 5m 2>&1 \
  | grep -F '[ivrm-metrics-bridge] initialized'
```

15秒以上経過後、metrics JSONを確認します。

```bash
sudo docker exec mc-main test -s /data/ivrm/metrics.json
echo "metrics_file_exit=$?"

sudo docker exec mc-main cat /data/ivrm/metrics.json \
  | python3 -m json.tool
```

さらに12秒後にもう一度確認し、`generatedAt`が進んでいることを確認します。

```bash
sleep 12
sudo docker exec mc-main cat /data/ivrm/metrics.json \
  | python3 -m json.tool
```

## Performance有効化

Bridge JARの同期、`initialized`ログ、metrics JSONの継続更新がすべて正常な場合だけONにします。

```bash
sudo sed -i \
  's/^IVRM_MINECRAFT_PERFORMANCE_ENABLED=.*/IVRM_MINECRAFT_PERFORMANCE_ENABLED=true/' \
  /etc/ivrm-agent/docker.env

sudo grep '^IVRM_MINECRAFT_PERFORMANCE_ENABLED=' \
  /etc/ivrm-agent/docker.env

sudo systemctl start ivrm-agent-docker-snapshot.service
sudo python3 -m json.tool /run/ivrm-agent/docker-state.json
sudo systemctl restart ivrm-agent
sleep 20
```

Snapshotの`minecraft.performance`には次の7 keyだけが入ります。

```text
source
tps1m
tps5m
tps15m
msptMedian1m
msptP95_1m
msptMax1m
```

`generatedAt`はBridge→Collector間のfreshness判定にだけ使い、Heartbeatへは送りません。

## 運用確認

```bash
sudo systemctl status ivrm-agent-docker-snapshot.timer --no-pager -l
sudo journalctl -u ivrm-agent-docker-snapshot.service -n 20 --no-pager -l
sudo systemctl status ivrm-agent --no-pager -l
sudo journalctl -u ivrm-agent -n 20 --no-pager -l
```

Agent 0.6.0正常時:

```text
"msg":"IVRM Agentを開始します","version":"0.6.0"
"msg":"Heartbeatを送信しました","containers":4,"minecraft":true,"minecraft_performance":true
```

公開設定:

```bash
sudo docker port ivrm-velocity 25565/tcp
sudo docker port mc-main 25565/tcp
sudo docker port mc-main 24454/udp
sudo docker port mc-main 25575/tcp || true
```

期待値:

- Velocity 25565/TCP: 公開
- mc-main 25565/TCP: 非公開
- mc-main 24454/UDP: 公開
- mc-main 25575/TCP: 非公開

RCONはMinecraft運用用途として残せますが、TPS/MSPT監視では利用しません。

## 障害時の挙動

- Docker停止・権限エラー・`docker inspect`不正時は新snapshotを作らない
- `docker stats`だけ失敗した場合はリソース値をnullとして状態情報を保持
- Minecraft Ping失敗時は`reachable=false`として他監視を継続
- Spark API / Bridge失敗時は45秒でPerformanceをstale扱い
- Bridge JSON本文やSpark内部値をwarning logへ転記しない
- Performanceだけ不正ならAgentはPerformanceだけ破棄しStatus Probeを保持
- snapshotが45秒より古い場合はHost heartbeatだけ継続
- 監視障害を理由にMinecraftを自動停止・起動・再起動しない
