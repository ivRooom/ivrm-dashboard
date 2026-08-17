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
       docker exec mc-main rcon-cli "spark tps"
          └─ TPS / MSPTだけ抽出
              └─ /run/ivrm-agent/docker-state.json
                   └─ ivrm-agent（非特権 / 0.6.0+）
                        └─ HTTPS Heartbeat
```

Agentを`docker`グループへ追加しません。Docker Socket、環境変数、Mount、内部IP、ログ本文、Secretは外部へ送信しません。Minecraft Probeの接続先・コンテナ名・ネットワーク・ポートはコード内の許可リストへ固定し、環境変数から任意接続先を指定できない設計です。

TPS / MSPT収集では`mc-main`コンテナ内の`rcon-cli`だけを使用します。RCON passwordをホスト側Collector、Go Agent、Console、Supabaseへ渡しません。RCONポートもホストやインターネットへ公開しません。Collectorから実行できる対象は固定`mc-main`、コマンドは固定`spark tps`だけで、shellやユーザー入力は利用しません。

`rcon-cli`はコマンドラインの各引数を別々のRCON commandとして扱うため、複数語の`spark tps`は必ず1引数として渡します。`rcon-cli spark tps`のように分割しません。

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

TPS / MSPTをOnline人数、Status Probe Latency、Docker CPU使用率などから推定しません。SparkがTick durationを提供しない場合や出力を安全に解釈できない場合はPerformance全体を欠損扱いにします。

内部IP、プレイヤーIP、RCON password、forwarding secret、PCF secretは収集しません。停止中・未作成のコンテナではリソース値を`null`にします。`docker stats`、Minecraft Ping、Spark Performanceのいずれかだけが失敗しても、取得できた監視情報を継続します。

## 推奨更新手順

相対パスを手作業で順番に実行せず、更新スクリプトを使用します。最初に必ず最新`main`を新しい一時ディレクトリへ取得します。

```bash
set -euo pipefail

cd /tmp
rm -rf ivrm-dashboard
git clone --depth 1 https://github.com/ivRooom/ivrm-dashboard.git

git -C /tmp/ivrm-dashboard rev-parse HEAD
bash /tmp/ivrm-dashboard/deploy/oci/update-monitoring-stack.sh
```

`update-monitoring-stack.sh`はスクリプト自身の場所からrepository rootを解決するため、呼び出し元のcurrent directoryに依存しません。

スクリプトは次を順に実施します。

1. Git checkout・必要コマンド・必要ファイルを検証
2. Docker / Minecraft Performance Collector / Backup Reporterをテスト
3. Go Agentをテスト・ビルド
4. 既存`/etc/ivrm-agent/agent.env`の存在を確認し、Secretを保持
5. Collector / systemd unit / timer / Agentを配置
6. `docker.env`を既知設定へ戻し、Performanceを必ずOFFにする
7. systemd unitを検証
8. 4コンテナとMinecraft Status Probeを確認
9. Agentを再起動

テスト・ビルド・Secret確認のどれかが失敗した場合は新しいAgent binaryをProductionへ配置しません。

更新直後は次の状態が正常です。

```text
Agent: 0.6.0+
containers: 4
minecraft: true
minecraft_performance: false
```

## Spark / RCON確認とPerformance有効化

PerformanceをONにする前に、まずread-onlyのMinecraft commandでRCON応答経路を確認します。

```bash
sudo docker exec mc-main rcon-cli list
echo "list_exit=$?"
```

`list`の応答が返ることを確認したら、Sparkを**1つのRCON command引数**として実行します。

```bash
sudo docker exec mc-main rcon-cli "spark tps"
echo "spark_exit=$?"
```

TPS 1m / 5m / 15mとTick durationsの直近1分値が表示され、`spark_exit=0`になることを確認します。RCON passwordをコマンドラインへ付与しません。

RCON portがホストへ公開されていないことも確認します。標準構成ではRCONはcontainer内`25575/tcp`です。

```bash
sudo docker port mc-main 25575/tcp || true
```

何も表示されないことが期待値です。

上記をすべて確認できた場合だけPerformanceをONにします。

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

値は例です。固定値として設定しません。

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

## 障害時の挙動

- Docker停止・権限エラー・`docker inspect`の不正応答時は新しいスナップショットを作成しません。
- `docker stats`のみ失敗した場合、対象コンテナのリソース値を`null`にして状態情報を保存します。
- 公開Pingまたは内部Pingが失敗した場合、対象Probeを`reachable=false`としてDocker監視とHost Heartbeatを継続します。
- Spark / RCON / Performance parserが失敗した場合、Performanceを送信せずStatus Probeを継続します。Spark出力本文はjournalへ記録しません。
- Agent側でPerformanceだけが不正な場合、そのPerformanceだけを破棄しStatus Probeを保持します。
- スナップショットが45秒より古い場合、AgentはDocker・Minecraft情報を送信せずHost Heartbeatだけを継続します。
- 指定コンテナが存在しない場合は`not_found`として保存します。
- 監視障害でMinecraftコンテナを停止・起動・再起動する処理はありません。
