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
