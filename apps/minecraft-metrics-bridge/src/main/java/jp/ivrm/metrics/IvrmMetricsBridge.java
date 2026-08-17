package jp.ivrm.metrics;

import net.fabricmc.api.ModInitializer;

import java.io.IOException;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Instant;
import java.util.EnumSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

public final class IvrmMetricsBridge implements ModInitializer {
    private static final Path OUTPUT_PATH = Path.of("/data/ivrm/metrics.json");
    private static final long INITIAL_DELAY_SECONDS = 15;
    private static final long INTERVAL_SECONDS = 10;
    private static final long WARNING_INTERVAL_SECONDS = 60;
    private static final double MAX_TPS = 1_000.0;
    private static final double MAX_MSPT_MS = 60_000.0;

    private final AtomicLong lastWarningEpochSecond = new AtomicLong(Long.MIN_VALUE);

    @Override
    public void onInitialize() {
        ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor(
            daemonThreadFactory()
        );
        executor.scheduleWithFixedDelay(
            this::collectAndWriteSafely,
            INITIAL_DELAY_SECONDS,
            INTERVAL_SECONDS,
            TimeUnit.SECONDS
        );
    }

    private static ThreadFactory daemonThreadFactory() {
        return runnable -> {
            Thread thread = new Thread(runnable, "ivrm-metrics-bridge");
            thread.setDaemon(true);
            thread.setUncaughtExceptionHandler((ignored, throwable) -> {
                System.err.println("[ivrm-metrics-bridge] unexpected collector failure");
            });
            return thread;
        };
    }

    private void collectAndWriteSafely() {
        try {
            MetricsSnapshot snapshot = readSparkMetrics();
            writeAtomically(OUTPUT_PATH, snapshot.toJson());
        } catch (ReflectiveOperationException | IOException | RuntimeException exception) {
            warnRateLimited();
        }
    }

    static MetricsSnapshot readSparkMetrics() throws ReflectiveOperationException {
        Class<?> providerClass = Class.forName("me.lucko.spark.api.SparkProvider");
        Object spark = invokeStaticNoArg(providerClass, "get");

        Object tpsStatistic = invokeNoArg(spark, "tps");
        Object msptStatistic = invokeNoArg(spark, "mspt");
        if (tpsStatistic == null || msptStatistic == null) {
            throw new IllegalStateException("Spark TPS/MSPT statistic is unavailable");
        }

        Class<?> tpsWindowClass = Class.forName(
            "me.lucko.spark.api.statistic.StatisticWindow$TicksPerSecond"
        );
        Class<?> msptWindowClass = Class.forName(
            "me.lucko.spark.api.statistic.StatisticWindow$MillisPerTick"
        );
        Class<?> doubleStatisticClass = Class.forName(
            "me.lucko.spark.api.statistic.types.DoubleStatistic"
        );
        Class<?> genericStatisticClass = Class.forName(
            "me.lucko.spark.api.statistic.types.GenericStatistic"
        );

        double tps1m = pollDouble(
            doubleStatisticClass,
            tpsStatistic,
            enumValue(tpsWindowClass, "MINUTES_1")
        );
        double tps5m = pollDouble(
            doubleStatisticClass,
            tpsStatistic,
            enumValue(tpsWindowClass, "MINUTES_5")
        );
        double tps15m = pollDouble(
            doubleStatisticClass,
            tpsStatistic,
            enumValue(tpsWindowClass, "MINUTES_15")
        );

        Object oneMinuteMspt = pollObject(
            genericStatisticClass,
            msptStatistic,
            enumValue(msptWindowClass, "MINUTES_1")
        );
        if (oneMinuteMspt == null) {
            throw new IllegalStateException("Spark one-minute MSPT statistic is unavailable");
        }

        double median = invokeDoubleNoArg(oneMinuteMspt, "median");
        double percentile95 = invokeDoubleNoArg(oneMinuteMspt, "percentile95th");
        double maximum = invokeDoubleNoArg(oneMinuteMspt, "max");

        return MetricsSnapshot.validated(
            Instant.now(),
            tps1m,
            tps5m,
            tps15m,
            median,
            percentile95,
            maximum
        );
    }

    private static Object invokeStaticNoArg(Class<?> type, String methodName)
        throws ReflectiveOperationException {
        try {
            return type.getMethod(methodName).invoke(null);
        } catch (InvocationTargetException exception) {
            throw unwrap(exception);
        }
    }

    private static Object invokeNoArg(Object target, String methodName)
        throws ReflectiveOperationException {
        try {
            return target.getClass().getMethod(methodName).invoke(target);
        } catch (InvocationTargetException exception) {
            throw unwrap(exception);
        }
    }

    private static double invokeDoubleNoArg(Object target, String methodName)
        throws ReflectiveOperationException {
        Object value = invokeNoArg(target, methodName);
        if (!(value instanceof Number number)) {
            throw new IllegalStateException("Spark statistic is not numeric");
        }
        return number.doubleValue();
    }

    private static double pollDouble(Class<?> statisticType, Object statistic, Object window)
        throws ReflectiveOperationException {
        Object value = pollObject(statisticType, statistic, window);
        if (!(value instanceof Number number)) {
            throw new IllegalStateException("Spark TPS statistic is not numeric");
        }
        return number.doubleValue();
    }

    private static Object pollObject(Class<?> statisticType, Object statistic, Object window)
        throws ReflectiveOperationException {
        Method poll = statisticType.getMethod("poll", Enum.class);
        try {
            return poll.invoke(statistic, window);
        } catch (InvocationTargetException exception) {
            throw unwrap(exception);
        }
    }

    @SuppressWarnings({"rawtypes", "unchecked"})
    private static Object enumValue(Class<?> enumClass, String name) {
        if (!enumClass.isEnum()) {
            throw new IllegalStateException("Spark statistic window is not an enum");
        }
        return Enum.valueOf((Class<? extends Enum>) enumClass.asSubclass(Enum.class), name);
    }

    private static ReflectiveOperationException unwrap(InvocationTargetException exception) {
        Throwable cause = exception.getCause();
        if (cause instanceof ReflectiveOperationException reflective) {
            return reflective;
        }
        return new ReflectiveOperationException("Spark API invocation failed", cause);
    }

    private static void writeAtomically(Path path, String json) throws IOException {
        Path parent = path.getParent();
        if (parent == null) {
            throw new IOException("Metrics output path has no parent");
        }
        Files.createDirectories(parent);

        Path temporary = Files.createTempFile(parent, ".ivrm-metrics-", ".json");
        try {
            Files.writeString(temporary, json, StandardCharsets.UTF_8);
            setOwnerOnlyPermissions(temporary);
            try {
                Files.move(
                    temporary,
                    path,
                    StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING
                );
            } catch (AtomicMoveNotSupportedException exception) {
                Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private static void setOwnerOnlyPermissions(Path path) throws IOException {
        try {
            Set<PosixFilePermission> permissions = EnumSet.of(
                PosixFilePermission.OWNER_READ,
                PosixFilePermission.OWNER_WRITE
            );
            Files.setPosixFilePermissions(path, permissions);
        } catch (UnsupportedOperationException ignored) {
            // Non-POSIX filesystems are not expected in production, but do not block startup.
        }
    }

    private void warnRateLimited() {
        long now = Instant.now().getEpochSecond();
        long previous = lastWarningEpochSecond.get();
        if (previous != Long.MIN_VALUE && now - previous < WARNING_INTERVAL_SECONDS) {
            return;
        }
        if (lastWarningEpochSecond.compareAndSet(previous, now)) {
            System.err.println("[ivrm-metrics-bridge] Spark TPS/MSPT is temporarily unavailable");
        }
    }

    record MetricsSnapshot(
        Instant generatedAt,
        double tps1m,
        double tps5m,
        double tps15m,
        double msptMedian1m,
        double msptP95_1m,
        double msptMax1m
    ) {
        static MetricsSnapshot validated(
            Instant generatedAt,
            double tps1m,
            double tps5m,
            double tps15m,
            double msptMedian1m,
            double msptP95_1m,
            double msptMax1m
        ) {
            requireRange(tps1m, 0.0, MAX_TPS, "tps1m");
            requireRange(tps5m, 0.0, MAX_TPS, "tps5m");
            requireRange(tps15m, 0.0, MAX_TPS, "tps15m");
            requireRange(msptMedian1m, 0.0, MAX_MSPT_MS, "msptMedian1m");
            requireRange(msptP95_1m, 0.0, MAX_MSPT_MS, "msptP95_1m");
            requireRange(msptMax1m, 0.0, MAX_MSPT_MS, "msptMax1m");
            if (!(msptMedian1m <= msptP95_1m && msptP95_1m <= msptMax1m)) {
                throw new IllegalArgumentException("MSPT percentile order is invalid");
            }
            return new MetricsSnapshot(
                generatedAt,
                tps1m,
                tps5m,
                tps15m,
                msptMedian1m,
                msptP95_1m,
                msptMax1m
            );
        }

        String toJson() {
            return String.format(
                Locale.ROOT,
                "{\"generatedAt\":\"%s\",\"source\":\"spark\",\"tps1m\":%s,\"tps5m\":%s,\"tps15m\":%s,\"msptMedian1m\":%s,\"msptP95_1m\":%s,\"msptMax1m\":%s}%n",
                generatedAt,
                Double.toString(tps1m),
                Double.toString(tps5m),
                Double.toString(tps15m),
                Double.toString(msptMedian1m),
                Double.toString(msptP95_1m),
                Double.toString(msptMax1m)
            );
        }

        private static void requireRange(double value, double minimum, double maximum, String name) {
            if (!Double.isFinite(value) || value < minimum || value > maximum) {
                throw new IllegalArgumentException(name + " is outside the allowed range");
            }
        }
    }
}
