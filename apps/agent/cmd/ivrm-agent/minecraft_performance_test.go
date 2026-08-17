package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestValidateMinecraftPerformanceAcceptsSparkMetrics(t *testing.T) {
	t.Parallel()

	err := validateMinecraftPerformance(minecraftPerformance{
		Source:       "spark",
		TPS1m:        20,
		TPS5m:        19.99,
		TPS15m:       19.95,
		MSPTMedian1m: 3.2,
		MSPTP95_1m:   8.4,
		MSPTMax1m:    21.7,
	})
	if err != nil {
		t.Fatalf("正しいSparkメトリクスを拒否しました: %v", err)
	}
}

func TestValidateMinecraftPerformanceRejectsInvalidPercentileOrder(t *testing.T) {
	t.Parallel()

	err := validateMinecraftPerformance(minecraftPerformance{
		Source:       "spark",
		TPS1m:        20,
		TPS5m:        20,
		TPS15m:       20,
		MSPTMedian1m: 10,
		MSPTP95_1m:   8,
		MSPTMax1m:    12,
	})
	if err == nil {
		t.Fatal("不正なMSPT percentile順序を拒否できませんでした")
	}
}

func TestValidateSnapshotMinecraftDropsOnlyInvalidPerformance(t *testing.T) {
	t.Parallel()

	snapshot := dockerSnapshot{
		Minecraft: &minecraftProbe{
			PublicEndpoint: minecraftEndpoint{Reachable: false},
			Backend:        minecraftEndpoint{Reachable: false},
			Performance: &minecraftPerformance{
				Source:       "spark",
				TPS1m:        20,
				TPS5m:        20,
				TPS15m:       20,
				MSPTMedian1m: 10,
				MSPTP95_1m:   8,
				MSPTMax1m:    12,
			},
		},
	}

	if err := validateSnapshotMinecraft(&snapshot); err == nil {
		t.Fatal("不正なPerformanceを検出できませんでした")
	}
	if snapshot.Minecraft == nil {
		t.Fatal("Status Probeまで破棄されました")
	}
	if snapshot.Minecraft.Performance != nil {
		t.Fatal("不正なPerformanceが残っています")
	}
}

func TestReadDockerSnapshotAcceptsPerformance(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 17, 10, 0, 30, 0, time.UTC)
	snapshot := dockerSnapshot{
		GeneratedAt: now.Add(-5 * time.Second),
		Containers:  []containerMetrics{},
		Minecraft: &minecraftProbe{
			PublicEndpoint: minecraftEndpoint{Reachable: false},
			Backend:        minecraftEndpoint{Reachable: false},
			Performance: &minecraftPerformance{
				Source:       "spark",
				TPS1m:        20,
				TPS5m:        20,
				TPS15m:       20,
				MSPTMedian1m: 3,
				MSPTP95_1m:   6,
				MSPTMax1m:    12,
			},
		},
	}
	data, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("JSON化できません: %v", err)
	}
	path := filepath.Join(t.TempDir(), "docker-state.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("スナップショットを書き込めません: %v", err)
	}

	actual, err := readDockerSnapshot(path, now)
	if err != nil {
		t.Fatalf("Performance付きSnapshotを読めません: %v", err)
	}
	if actual.Minecraft == nil || actual.Minecraft.Performance == nil {
		t.Fatalf("Performanceが欠落しました: %#v", actual.Minecraft)
	}
}
