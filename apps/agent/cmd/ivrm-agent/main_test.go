package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestSignIsStable(t *testing.T) {
	t.Parallel()

	actual := sign([]byte("secret"), "123", "nonce-123", []byte(`{"ok":true}`))
	const expected = "439929cf1bf76a205925a0c96707e55815bb299491005de149afc9cb41fc7cd2"
	if actual != expected {
		t.Fatalf("署名が一致しません: got=%s want=%s", actual, expected)
	}
}

func TestNewNonce(t *testing.T) {
	t.Parallel()

	first, err := newNonce()
	if err != nil {
		t.Fatalf("Nonceを生成できません: %v", err)
	}
	second, err := newNonce()
	if err != nil {
		t.Fatalf("Nonceを生成できません: %v", err)
	}
	if first == second {
		t.Fatal("Nonceが重複しました")
	}
	if !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(first) {
		t.Fatalf("Nonce形式が不正です: %s", first)
	}
}

func TestReadMemoryAcceptsZeroAvailable(t *testing.T) {
	t.Parallel()

	total, available, err := readMemoryFrom(strings.NewReader("MemTotal: 1024 kB\nMemAvailable: 0 kB\n"))
	if err != nil {
		t.Fatalf("空きメモリ0を読み取れません: %v", err)
	}
	if total != 1024*1024 {
		t.Fatalf("総メモリが不正です: %d", total)
	}
	if available != 0 {
		t.Fatalf("空きメモリが不正です: %d", available)
	}
}

func TestReadMemoryRejectsMissingAvailable(t *testing.T) {
	t.Parallel()

	_, _, err := readMemoryFrom(strings.NewReader("MemTotal: 1024 kB\n"))
	if err == nil {
		t.Fatal("MemAvailable欠落を検出できませんでした")
	}
}

func TestReadContainerSnapshot(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 1, 0, 0, 30, 0, time.UTC)
	exitCode := 0
	snapshot := dockerSnapshot{
		GeneratedAt: now.Add(-10 * time.Second),
		Containers: []containerMetrics{
			{
				Name:         "mc-main",
				State:        "running",
				Health:       "healthy",
				RestartCount: 2,
				OOMKilled:    false,
				ExitCode:     &exitCode,
			},
		},
	}

	path := writeSnapshot(t, snapshot)
	containers, err := readContainerSnapshot(path, now)
	if err != nil {
		t.Fatalf("Dockerスナップショットを読み取れません: %v", err)
	}
	if len(containers) != 1 || containers[0].Name != "mc-main" {
		t.Fatalf("Dockerコンテナが不正です: %#v", containers)
	}
}

func TestReadDockerSnapshotAcceptsMinecraftProbe(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 2, 0, 0, 30, 0, time.UTC)
	latency := 42
	version := "Velocity 1.7.2-26.2"
	online := 0
	maximum := 10
	path := writeSnapshot(t, dockerSnapshot{
		GeneratedAt: now.Add(-5 * time.Second),
		Containers:  []containerMetrics{},
		Minecraft: &minecraftProbe{
			PublicEndpoint: minecraftEndpoint{
				Reachable: true,
				LatencyMs: &latency,
				Version:   &version,
				Online:    &online,
				Max:       &maximum,
			},
			Backend: minecraftEndpoint{
				Reachable: true,
				LatencyMs: &latency,
				Version:   &version,
				Online:    &online,
				Max:       &maximum,
			},
			ProxyPortPublished:     true,
			BackendPortPublished:   false,
			VoiceChatPortPublished: true,
		},
	})

	snapshot, err := readDockerSnapshot(path, now)
	if err != nil {
		t.Fatalf("Minecraft Probeを読み取れません: %v", err)
	}
	if snapshot.Minecraft == nil || !snapshot.Minecraft.PublicEndpoint.Reachable {
		t.Fatalf("Minecraft Probeが欠落しました: %#v", snapshot.Minecraft)
	}
}

func TestValidateMinecraftEndpointAcceptsUnreachable(t *testing.T) {
	t.Parallel()

	if err := validateMinecraftEndpoint(minecraftEndpoint{Reachable: false}); err != nil {
		t.Fatalf("到達不能のProbeを拒否しました: %v", err)
	}
}

func TestValidateMinecraftEndpointRejectsPartialReachable(t *testing.T) {
	t.Parallel()

	latency := 10
	err := validateMinecraftEndpoint(minecraftEndpoint{
		Reachable: true,
		LatencyMs: &latency,
	})
	if err == nil {
		t.Fatal("不完全な到達可能Probeを拒否できませんでした")
	}
}

func TestValidateMinecraftEndpointRejectsInvalidPlayers(t *testing.T) {
	t.Parallel()

	latency := 10
	version := "26.1.2"
	online := 11
	maximum := 10
	err := validateMinecraftEndpoint(minecraftEndpoint{
		Reachable: true,
		LatencyMs: &latency,
		Version:   &version,
		Online:    &online,
		Max:       &maximum,
	})
	if err == nil {
		t.Fatal("不正なプレイヤー数を拒否できませんでした")
	}
}

func TestValidateSnapshotMinecraftDropsOnlyInvalidProbe(t *testing.T) {
	t.Parallel()

	latency := 10
	version := "26.1.2"
	online := 11
	maximum := 10
	snapshot := dockerSnapshot{
		Containers: []containerMetrics{
			{Name: "mc-main", State: "running", Health: "healthy"},
		},
		Minecraft: &minecraftProbe{
			PublicEndpoint: minecraftEndpoint{
				Reachable: true,
				LatencyMs: &latency,
				Version:   &version,
				Online:    &online,
				Max:       &maximum,
			},
			Backend: minecraftEndpoint{Reachable: false},
		},
	}

	if err := validateSnapshotMinecraft(&snapshot); err == nil {
		t.Fatal("不正なMinecraft Probeを検出できませんでした")
	}
	if snapshot.Minecraft != nil {
		t.Fatal("不正なMinecraft Probeが残っています")
	}
	if len(snapshot.Containers) != 1 || snapshot.Containers[0].Name != "mc-main" {
		t.Fatalf("Docker状態まで破棄されました: %#v", snapshot.Containers)
	}
}

func TestValidateContainerResourceMetricsAcceptsCompleteValues(t *testing.T) {
	t.Parallel()

	cpu := 12.34
	memoryUsage := uint64(1024)
	memoryLimit := uint64(2048)
	networkRx := uint64(3000)
	networkTx := uint64(4000)
	blockRead := uint64(5000)
	blockWrite := uint64(6000)
	pids := 42

	err := validateContainerResourceMetrics(containerMetrics{
		CPUPercent:       &cpu,
		MemoryUsageBytes: &memoryUsage,
		MemoryLimitBytes: &memoryLimit,
		NetworkRxBytes:   &networkRx,
		NetworkTxBytes:   &networkTx,
		BlockReadBytes:   &blockRead,
		BlockWriteBytes:  &blockWrite,
		PIDs:             &pids,
	})
	if err != nil {
		t.Fatalf("完全なリソース値を拒否しました: %v", err)
	}
}

func TestValidateContainerResourceMetricsRejectsPartialValues(t *testing.T) {
	t.Parallel()

	cpu := 1.0
	err := validateContainerResourceMetrics(containerMetrics{CPUPercent: &cpu})
	if err == nil {
		t.Fatal("一部だけのリソース値を拒否できませんでした")
	}
}

func TestValidateContainerResourceMetricsRejectsMemoryOverflow(t *testing.T) {
	t.Parallel()

	cpu := 1.0
	memoryUsage := uint64(2048)
	memoryLimit := uint64(1024)
	zero := uint64(0)
	pids := 1
	err := validateContainerResourceMetrics(containerMetrics{
		CPUPercent:       &cpu,
		MemoryUsageBytes: &memoryUsage,
		MemoryLimitBytes: &memoryLimit,
		NetworkRxBytes:   &zero,
		NetworkTxBytes:   &zero,
		BlockReadBytes:   &zero,
		BlockWriteBytes:  &zero,
		PIDs:             &pids,
	})
	if err == nil {
		t.Fatal("上限を超えたメモリ使用量を拒否できませんでした")
	}
}

func TestReadContainerSnapshotIgnoresMissingFile(t *testing.T) {
	t.Parallel()

	containers, err := readContainerSnapshot(filepath.Join(t.TempDir(), "missing.json"), time.Now())
	if err != nil {
		t.Fatalf("未作成ファイルを許容できません: %v", err)
	}
	if len(containers) != 0 {
		t.Fatalf("未作成ファイルでコンテナが返りました: %#v", containers)
	}
}

func TestReadContainerSnapshotRejectsStaleSnapshot(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 1, 0, 2, 0, 0, time.UTC)
	path := writeSnapshot(t, dockerSnapshot{
		GeneratedAt: now.Add(-2 * time.Minute),
		Containers:  []containerMetrics{},
	})

	_, err := readContainerSnapshot(path, now)
	if err == nil {
		t.Fatal("古いDockerスナップショットを拒否できませんでした")
	}
}

func TestReadContainerSnapshotRejectsDuplicateNames(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 1, 0, 0, 30, 0, time.UTC)
	path := writeSnapshot(t, dockerSnapshot{
		GeneratedAt: now,
		Containers: []containerMetrics{
			{Name: "mc-main", State: "running", Health: "healthy"},
			{Name: "mc-main", State: "exited", Health: "none"},
		},
	})

	_, err := readContainerSnapshot(path, now)
	if err == nil {
		t.Fatal("重複コンテナ名を拒否できませんでした")
	}
}

func writeSnapshot(t *testing.T, snapshot dockerSnapshot) string {
	t.Helper()

	data, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("テスト用JSONを作成できません: %v", err)
	}
	path := filepath.Join(t.TempDir(), "docker-state.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("テスト用JSONを書き込めません: %v", err)
	}
	return path
}
