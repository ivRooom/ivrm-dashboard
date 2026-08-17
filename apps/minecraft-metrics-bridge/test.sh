#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ivrm-metrics-bridge-test.XXXXXX")"

cleanup() {
  rm -rf -- "${BUILD_DIR}"
}
trap cleanup EXIT

mkdir -p \
  "${BUILD_DIR}/src/net/fabricmc/api" \
  "${BUILD_DIR}/src/me/lucko/spark/api/statistic/types" \
  "${BUILD_DIR}/src/me/lucko/spark/api/statistic/misc" \
  "${BUILD_DIR}/src/me/lucko/spark/api/statistic" \
  "${BUILD_DIR}/src/me/lucko/spark/api" \
  "${BUILD_DIR}/src/jp/ivrm/metrics" \
  "${BUILD_DIR}/classes"

cat >"${BUILD_DIR}/src/net/fabricmc/api/ModInitializer.java" <<'JAVA'
package net.fabricmc.api;

public interface ModInitializer {
    void onInitialize();
}
JAVA

cat >"${BUILD_DIR}/src/me/lucko/spark/api/statistic/StatisticWindow.java" <<'JAVA'
package me.lucko.spark.api.statistic;

import java.time.Duration;

public interface StatisticWindow {
    Duration length();

    enum TicksPerSecond implements StatisticWindow {
        SECONDS_5(Duration.ofSeconds(5)),
        SECONDS_10(Duration.ofSeconds(10)),
        MINUTES_1(Duration.ofMinutes(1)),
        MINUTES_5(Duration.ofMinutes(5)),
        MINUTES_15(Duration.ofMinutes(15));

        private final Duration length;

        TicksPerSecond(Duration length) {
            this.length = length;
        }

        @Override
        public Duration length() {
            return length;
        }
    }

    enum MillisPerTick implements StatisticWindow {
        SECONDS_10(Duration.ofSeconds(10)),
        MINUTES_1(Duration.ofMinutes(1)),
        MINUTES_5(Duration.ofMinutes(5));

        private final Duration length;

        MillisPerTick(Duration length) {
            this.length = length;
        }

        @Override
        public Duration length() {
            return length;
        }
    }
}
JAVA

cat >"${BUILD_DIR}/src/me/lucko/spark/api/statistic/misc/DoubleAverageInfo.java" <<'JAVA'
package me.lucko.spark.api.statistic.misc;

public interface DoubleAverageInfo {
    double mean();
    double max();
    double min();

    default double median() {
        return percentile(0.50d);
    }

    default double percentile95th() {
        return percentile(0.95d);
    }

    double percentile(double percentile);
}
JAVA

cat >"${BUILD_DIR}/src/me/lucko/spark/api/statistic/types/DoubleStatistic.java" <<'JAVA'
package me.lucko.spark.api.statistic.types;

import me.lucko.spark.api.statistic.StatisticWindow;

public interface DoubleStatistic<W extends Enum<W> & StatisticWindow> {
    double poll(W window);
}
JAVA

cat >"${BUILD_DIR}/src/me/lucko/spark/api/statistic/types/GenericStatistic.java" <<'JAVA'
package me.lucko.spark.api.statistic.types;

import me.lucko.spark.api.statistic.StatisticWindow;

public interface GenericStatistic<I, W extends Enum<W> & StatisticWindow> {
    I poll(W window);
}
JAVA

cat >"${BUILD_DIR}/src/me/lucko/spark/api/Spark.java" <<'JAVA'
package me.lucko.spark.api;

import me.lucko.spark.api.statistic.StatisticWindow;
import me.lucko.spark.api.statistic.misc.DoubleAverageInfo;
import me.lucko.spark.api.statistic.types.DoubleStatistic;
import me.lucko.spark.api.statistic.types.GenericStatistic;

public interface Spark {
    DoubleStatistic<StatisticWindow.TicksPerSecond> tps();
    GenericStatistic<DoubleAverageInfo, StatisticWindow.MillisPerTick> mspt();
}
JAVA

cat >"${BUILD_DIR}/src/me/lucko/spark/api/SparkProvider.java" <<'JAVA'
package me.lucko.spark.api;

import me.lucko.spark.api.statistic.StatisticWindow;
import me.lucko.spark.api.statistic.misc.DoubleAverageInfo;
import me.lucko.spark.api.statistic.types.DoubleStatistic;
import me.lucko.spark.api.statistic.types.GenericStatistic;

public final class SparkProvider {
    private static final Spark INSTANCE = new Spark() {
        private final DoubleStatistic<StatisticWindow.TicksPerSecond> tps = window -> switch (window) {
            case MINUTES_1 -> 19.98;
            case MINUTES_5 -> 19.95;
            case MINUTES_15 -> 19.90;
            default -> 20.0;
        };

        private final GenericStatistic<DoubleAverageInfo, StatisticWindow.MillisPerTick> mspt = window -> {
            if (window != StatisticWindow.MillisPerTick.MINUTES_1) {
                return null;
            }
            return new DoubleAverageInfo() {
                @Override public double mean() { return 4.1; }
                @Override public double max() { return 41.2; }
                @Override public double min() { return 2.2; }
                @Override public double percentile(double percentile) {
                    if (Math.abs(percentile - 0.50d) < 0.000001d) {
                        return 3.4;
                    }
                    if (Math.abs(percentile - 0.95d) < 0.000001d) {
                        return 9.8;
                    }
                    throw new IllegalArgumentException("unexpected percentile=" + percentile);
                }
            };
        };

        @Override
        public DoubleStatistic<StatisticWindow.TicksPerSecond> tps() {
            return tps;
        }

        @Override
        public GenericStatistic<DoubleAverageInfo, StatisticWindow.MillisPerTick> mspt() {
            return mspt;
        }
    };

    private SparkProvider() {}

    public static Spark get() {
        return INSTANCE;
    }
}
JAVA

cat >"${BUILD_DIR}/src/jp/ivrm/metrics/IvrmMetricsBridgeTestMain.java" <<'JAVA'
package jp.ivrm.metrics;

public final class IvrmMetricsBridgeTestMain {
    private IvrmMetricsBridgeTestMain() {}

    public static void main(String[] args) throws Exception {
        IvrmMetricsBridge.MetricsSnapshot snapshot = IvrmMetricsBridge.readSparkMetrics();
        assertClose(snapshot.tps1m(), 19.98, "tps1m");
        assertClose(snapshot.tps5m(), 19.95, "tps5m");
        assertClose(snapshot.tps15m(), 19.90, "tps15m");
        assertClose(snapshot.msptMedian1m(), 3.4, "msptMedian1m");
        assertClose(snapshot.msptP95_1m(), 9.8, "msptP95_1m");
        assertClose(snapshot.msptMax1m(), 41.2, "msptMax1m");

        String json = snapshot.toJson();
        require(json.contains("\"source\":\"spark\""), "source is missing");
        require(json.contains("\"tps1m\":19.98"), "tps1m JSON is missing");
        require(json.contains("\"msptMax1m\":41.2"), "msptMax1m JSON is missing");
        System.out.println("metrics_bridge_reflection_test=ok");
    }

    private static void assertClose(double actual, double expected, String name) {
        if (Math.abs(actual - expected) > 0.000001) {
            throw new AssertionError(name + " expected=" + expected + " actual=" + actual);
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new AssertionError(message);
        }
    }
}
JAVA

mapfile -t TEST_SOURCES < <(find "${BUILD_DIR}/src" -name '*.java' -print | sort)

javac \
  --release 21 \
  -Xlint:all \
  -Werror \
  -d "${BUILD_DIR}/classes" \
  "${TEST_SOURCES[@]}" \
  "${SCRIPT_DIR}/src/main/java/jp/ivrm/metrics/IvrmMetricsBridge.java"

java \
  -cp "${BUILD_DIR}/classes" \
  jp.ivrm.metrics.IvrmMetricsBridgeTestMain
