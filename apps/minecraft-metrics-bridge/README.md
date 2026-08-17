# IVRM Minecraft Metrics Bridge

`mc-main`内でSparkの公開APIをpollし、IVRM Agentが安全に読み取れる最小の構造化JSONへ変換するFabric server modです。

## 目的

MinecraftのRCON commandは運用操作には利用できますが、人間向けの複数行command出力を監視データAPIとして利用しません。

Metrics BridgeはSpark APIから次の実測値だけを取得します。

- TPS 1m / 5m / 15m
- MSPT 1m median / p95 / max

Online人数、Ping、Docker CPUなどからTPS/MSPTを推定しません。

## 出力contract

10秒ごとに`/data/ivrm/metrics.json`をatomic updateします。

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

ファイルにはPlayer名、UUID、IP、RCON password、server secret、環境変数、command outputを含めません。

Host側`ivrm-agent-minecraft-performance.py`はこの8 key以外を拒否し、45秒を超えたファイルもstaleとして拒否します。

## Spark API

BridgeはSpark API jarを成果物へ同梱しません。

実行時に次の公開API class/interfaceをreflectionで利用します。

- `me.lucko.spark.api.SparkProvider`
- `me.lucko.spark.api.Spark`
- `StatisticWindow.TicksPerSecond`
- `StatisticWindow.MillisPerTick`
- `DoubleStatistic`
- `GenericStatistic`
- `DoubleAverageInfo`

Sparkがまだloadされていない場合やAPIが利用不能な場合、BridgeはMinecraft serverを停止させず、generic warningだけをrate-limitして出力して次周期で再試行します。

## Build

JDK 21以上で実行します。

```bash
bash apps/minecraft-metrics-bridge/build.sh
```

成果物:

```text
apps/minecraft-metrics-bridge/build/ivrm-metrics-bridge.jar
```

Fabric APIそのものへのruntime dependencyはありません。`ModInitializer`のcompile-time stubはbuild後に成果物から削除し、runtimeではFabric Loaderが提供するclassを使用します。

## Test

```bash
bash apps/minecraft-metrics-bridge/test.sh
```

テストではSpark公開APIと同じgeneric bound / method erasureを持つfake APIを構築し、reflectionでTPS/MSPTを実際にpollできることを確認します。

## Production rollout

Bridge stagingはMinecraftを自動再起動しません。

```bash
bash deploy/oci/stage-minecraft-metrics-bridge.sh
```

その後、通常のメンテナンス手順でMinecraftを再起動し、15秒以上経過してから以下を確認します。

```bash
sudo docker exec mc-main cat /data/ivrm/metrics.json \
  | python3 -m json.tool
```

JSONが継続更新されることを確認するまで`IVRM_MINECRAFT_PERFORMANCE_ENABLED`を`true`にしません。
