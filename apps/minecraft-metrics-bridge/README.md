# IVRM Minecraft Metrics Bridge

`mc-main`内でSparkの公開APIをpollし、IVRM Agentが安全に読み取れる最小の構造化JSONへ変換するNeoForge server modです。

Production `mc-main`はNeoForgeで動作しており、Sparkも`*-neoforge.jar`としてロードされています。Bridgeも同じNeoForge `javafml` entrypointとしてロードします。

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

## NeoForge entrypoint

JARは`META-INF/neoforge.mods.toml`を持ち、`javafml`の`@Mod("ivrm_metrics_bridge")` entrypointで起動します。

BridgeはMinecraft/NeoForgeのgame APIへ依存せず、NeoForgeはentrypoint起動にだけ利用します。公開constructorは引数なし1つだけです。

起動できた場合、server logへ次の汎用行を1回だけ出します。

```text
[ivrm-metrics-bridge] initialized
```

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

NeoForge API jarそのものへのruntime同梱はありません。`@Mod`のcompile-time stubはbuild後に成果物から削除し、runtimeではNeoForge/FMLが提供するannotationを使用します。

## Test

```bash
bash apps/minecraft-metrics-bridge/test.sh
```

テストでは次を確認します。

- NeoForge `@Mod` annotationとmod id
- public no-arg constructorが1つだけ
- Spark公開APIと同じgeneric bound / method erasure
- reflectionでTPS/MSPTを実際にpoll可能
- structured JSON contract

## ProductionのMod source

Productionの`itzg/minecraft-server`構成では、永続Mod sourceの`/mods`が起動時に`/data/mods`へ同期されます。

そのためBridge JARを`/data/mods`へ直接配置しません。`stage-minecraft-metrics-bridge.sh`はDocker mount metadataから`/mods`のHost sourceを解決し、そこへJARを配置します。

```text
Host persistent mods directory
        ↓ bind mount
container /mods
        ↓ itzg startup sync
container /data/mods
        ↓ NeoForge load
IVRM Metrics Bridge
```

Host sourceの場所はスクリプトへハードコードしません。build成果物・Host source・container `/mods`のSHA256が一致しない場合はstageを失敗させ、既存JARを復元します。

## Production rollout

Bridge stagingはMinecraftを自動再起動しません。

```bash
bash deploy/oci/stage-minecraft-metrics-bridge.sh
```

stage完了時点では、永続`/mods` sourceにJARがあり、PerformanceはOFFのままです。

その後、通常のメンテナンス手順で`mc-main`を再起動します。起動時同期後に次を確認します。

```bash
sudo docker exec mc-main test -s /data/mods/ivrm-metrics-bridge.jar
sudo docker logs mc-main --since 5m 2>&1 \
  | grep -F '[ivrm-metrics-bridge] initialized'
```

15秒以上経過してから構造化メトリクスを確認します。

```bash
sudo docker exec mc-main cat /data/ivrm/metrics.json \
  | python3 -m json.tool
```

JSONが継続更新されることを確認するまで`IVRM_MINECRAFT_PERFORMANCE_ENABLED`を`true`にしません。
