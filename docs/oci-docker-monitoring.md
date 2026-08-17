# OCI Docker・Minecraft監視の配置と更新

Docker Socketを非特権の`ivrm-agent`へ渡さず、rootで動く短時間のsystemd oneshotが許可済みコンテナと固定されたMinecraft接続先だけを調査します。収集結果は機密情報を除いたJSONとして`/run/ivrm-agent/docker-state.json`へ書き出し、Go Agentはそのファイルだけを読み取ります。

## 構成

```text
mc-main / Fabric
  └─ IVRM Metrics Bridge（10秒）
       └─ Spark公式API
            ├─ TPS 1m / 5m / 15m
            └─ MSPT 1m median / p95 / max
                 ↓ atomic write
       /data/ivrm/metrics.json

root / systemd timer（10秒）
  ├─ docker inspect（許可済み4コンテナのみ）
  ├─ docker stats --no-stream（稼働中のみ）
  ├─ 127.0.0.1:25565 Minecraft Ping
  ├─ mc-main内部IP:25565 Minecraft Ping
  └─ Performance有効時のみ
       docker exec mc-main cat /data/ivrm/metrics.json
          └─ schema / freshness / range validation
              └─ /run/ivrm-agent/docker-state.json
                   └─ ivrm-agent（非特権 / 0.6.0+）
                        └─ HTTPS Heartbeat
```

Agentを`docker`グループへ追加しません。Docker Socket、環境変数、Mount、内部IP、ログ本文、Secretは外部へ送信しません。Minecraft Probeの接続先・コンテナ名・ネットワーク・ポートはコード内の許可リストへ固定し、環境変数から任意接続先を指定できない設計です。

## TPS / MSPT収集方式

TPS / MSPTはSparkの人間向けcommand出力をparseしません。

実機ではRCON自体は正常でも、`spark tps`の応答が部分出力または空出力になるケースを確認しました。したがってPerformance監視ではRCONをデータAPIとして利用せず、Minecraft内の`IVRM Metrics Bridge`がSpark公開APIを直接pollして構造化JSONへ変換します。

Metrics Bridgeは次だけを書き出します。

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

値は例です。固定値として設定しません。

Host Collectorは次を検証します。

- JSON objectであること
- 許可した8 key以外を含まないこと
- `source=spark`
- `generatedAt`がtimezone付きであること
- 45秒以内のfresh dataであること
- 5秒を超えて未来時刻でないこと
- TPSが`0..1000`
- MSPTが`0..60000ms`
- `median <= p95 <= max`

Bridgeが未導入・Sparkが未ready・ファイルが古い・JSONが不正な場合はPerformanceだけを欠損扱いにし、Docker / Minecraft Status / Host Heartbeatは継続します。

## 収集対象

`/etc/ivrm-agent/docker.env`で次のコンテナだけを許可します。

```env
IVRM_DOCKER_CONTAINERS=mc-main,ivrm-velocity,mc-resource,mc-resource-router
IVRM_DOCKER_SNAPSHOT_PATH=/run/ivrm-agent/docker-state.json
IVRM_DOCKER_BINARY=/usr/bin/docker
IVRM_MINECRAFT_PROBE_ENABLED=true
IVRM_MINECRAFT_PERFORMANCE_ENABLED=false
```

`IVRM_MINECRAFT_PERFORMANCE_ENABLED`は既定`false`です。Metrics Bridgeの導入・Minecraft再起動・構造化JSON確認まで完了してから明示的に有効化します。

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

### Minecraft Performance（Spark API）

- TPS 1分 / 5分 / 15分
- 直近1分のTick duration median
- 直近1分のTick duration 95 percentile
- 直近1分のTick duration max
- Source=`spark`

TPS / MSPTをOnline人数、Status Probe Latency、Docker CPU使用率などから推定しません。

## Agent / Collector更新

相対パスを手作業で順番に実行せず、必ず更新スクリプトを使用します。

```bash
set -euo pipefail

cd /tmp
rm -rf ivrm-dashboard
git clone --depth 1 https://github.com/ivRooom/ivrm-dashboard.git

git -C /tmp/ivrm-dashboard rev-parse HEAD
bash /tmp/ivrm-dashboard/deploy/oci/update-monitoring-stack.sh
```

`update-monitoring-stack.sh`はcurrent directoryに依存せず、次を順に実施します。

1. Git checkout・必要コマンド・必要ファイルを検証
2. Docker / Minecraft Performance Collector / Backup Reporterをテスト
3. Go Agentをテスト・ビルド
4. 既存`/etc/ivrm-agent/agent.env`を確認しSecretを保持
5. Collector / systemd unit / timer / Agentを配置
6. `docker.env`を既知設定へ戻しPerformanceを必ずOFFにする
7. systemd unitを検証
8. 4コンテナとMinecraft Status Probeを確認
9. Agentを再起動

テスト・ビルド・Secret確認のどれかが失敗した場合は新しいAgent binaryをProductionへ配置しません。

更新直後は次が正常です。

```text
Agent: 0.6.0+
containers: 4
minecraft: true
minecraft_performance: false
```

## Metrics Bridgeのステージ

PerformanceはOFFのまま、最新`main` checkoutから実行します。

```bash
bash /tmp/ivrm-dashboard/deploy/oci/stage-minecraft-metrics-bridge.sh
```

このスクリプトは次を保証します。

- `mc-main`がrunningであることを確認
- `/data/mods`が存在しない場合は中止
- Performanceが`false`でなければ中止
- Java compilerがHostにある場合はHostでbuild
- 無い場合はnetworkなし・read-onlyのJDK containerでbuild
- `/data/mods/ivrm-metrics-bridge.jar`へ固定配置
- 既存Bridgeがある場合は配置中だけbackup
- Minecraftを自動再起動しない
- Performanceを自動ONにしない

Minecraft再起動はサービス影響を伴うため、ステージスクリプトから実行しません。

## メンテナンス再起動後のBridge確認

Minecraftを通常の運用手順で再起動した後、15秒以上待ちます。

```bash
sudo docker exec mc-main test -s /data/ivrm/metrics.json
echo "metrics_file_exit=$?"

sudo docker exec mc-main cat /data/ivrm/metrics.json \
  | python3 -m json.tool
```

次の8 keyだけが存在することを確認します。

```text
generatedAt
source
tps1m
tps5m
tps15m
msptMedian1m
msptP95_1m
msptMax1m
```

`source`は`spark`である必要があります。

Bridgeの汎用ログ確認は次です。メトリクス値そのものはログへ出しません。

```bash
sudo docker logs mc-main --since 5m 2>&1 \
  | grep -F 'ivrm-metrics-bridge' || true
```

## Performance有効化

Bridge JSONが正常に継続更新されることを確認した場合だけONにします。

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

`generatedAt`はfreshness確認のためBridgeとCollector間だけで使い、Heartbeat payloadへは追加しません。

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
sudo docker port mc-main 25575/tcp || true
```

期待結果:

- `ivrm-velocity 25565/tcp`: ホスト`25565`へ公開
- `mc-main 25565/tcp`: 公開なし
- `mc-main 24454/udp`: ホスト`24454`へ公開
- `mc-main 25575/tcp`: 公開なし

RCONはMinecraft運用用途として残せますが、TPS / MSPT Performance監視経路では利用しません。

## 障害時の挙動

- Docker停止・権限エラー・`docker inspect`の不正応答時は新しいスナップショットを作成しません。
- `docker stats`のみ失敗した場合、対象コンテナのリソース値を`null`にして状態情報を保存します。
- 公開Pingまたは内部Pingが失敗した場合、対象Probeを`reachable=false`としてDocker監視とHost Heartbeatを継続します。
- Spark API / Metrics Bridgeが失敗した場合、古いmetrics fileは45秒でstale判定されPerformanceを送信しません。
- Metrics Bridge JSON本文やSpark内部値をwarning logへ転記しません。
- Agent側でPerformanceだけが不正な場合、そのPerformanceだけを破棄しStatus Probeを保持します。
- Docker snapshotが45秒より古い場合、AgentはDocker・Minecraft情報を送信せずHost Heartbeatだけを継続します。
- 指定コンテナが存在しない場合は`not_found`として保存します。
- 監視障害だけを理由にMinecraftコンテナを停止・起動・再起動する処理はありません。
