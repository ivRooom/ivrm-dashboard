package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

const (
	agentVersion              = "0.6.0"
	defaultDockerSnapshotPath = "/run/ivrm-agent/docker-state.json"
	maxDockerSnapshotAge      = 45 * time.Second
	maxContainersPerSnapshot  = 20
	maxMinecraftPlayers       = 1_000_000
	maxMinecraftTPS           = 1_000.0
	maxMinecraftMSPT          = 60_000.0
	maxSafeInteger      uint64 = 9_007_199_254_740_991
)

var containerNamePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)

var validContainerStates = map[string]struct{}{
	"created":    {},
	"running":    {},
	"paused":     {},
	"restarting": {},
	"removing":   {},
	"exited":     {},
	"dead":       {},
	"unknown":    {},
	"not_found":  {},
}

var validContainerHealth = map[string]struct{}{
	"starting":  {},
	"healthy":   {},
	"unhealthy": {},
	"none":      {},
	"unknown":   {},
}

type config struct {
	serverID           string
	endpoint           string
	token              string
	interval           time.Duration
	dockerSnapshotPath string
}

type hostMetrics struct {
	CPUCount             int     `json:"cpuCount"`
	MemoryTotalBytes     uint64  `json:"memoryTotalBytes"`
	MemoryAvailableBytes uint64  `json:"memoryAvailableBytes"`
	DiskTotalBytes       uint64  `json:"diskTotalBytes"`
	DiskAvailableBytes   uint64  `json:"diskAvailableBytes"`
	LoadAverage1         float64 `json:"loadAverage1"`
	LoadAverage5         float64 `json:"loadAverage5"`
	LoadAverage15        float64 `json:"loadAverage15"`
	UptimeSeconds        float64 `json:"uptimeSeconds"`
}

type containerMetrics struct {
	Name               string   `json:"name"`
	State              string   `json:"state"`
	Health             string   `json:"health"`
	RestartCount       int      `json:"restartCount"`
	OOMKilled          bool     `json:"oomKilled"`
	ExitCode           *int     `json:"exitCode"`
	CPUPercent         *float64 `json:"cpuPercent"`
	MemoryUsageBytes   *uint64  `json:"memoryUsageBytes"`
	MemoryLimitBytes   *uint64  `json:"memoryLimitBytes"`
	NetworkRxBytes     *uint64  `json:"networkRxBytes"`
	NetworkTxBytes     *uint64  `json:"networkTxBytes"`
	BlockReadBytes     *uint64  `json:"blockReadBytes"`
	BlockWriteBytes    *uint64  `json:"blockWriteBytes"`
	PIDs               *int     `json:"pids"`
}

type minecraftEndpoint struct {
	Reachable bool    `json:"reachable"`
	LatencyMs *int    `json:"latencyMs"`
	Version   *string `json:"version"`
	Online    *int    `json:"online"`
	Max       *int    `json:"max"`
}

type minecraftPerformance struct {
	Source       string  `json:"source"`
	TPS1m        float64 `json:"tps1m"`
	TPS5m        float64 `json:"tps5m"`
	TPS15m       float64 `json:"tps15m"`
	MSPTMedian1m float64 `json:"msptMedian1m"`
	MSPTP95_1m   float64 `json:"msptP95_1m"`
	MSPTMax1m    float64 `json:"msptMax1m"`
}

type minecraftProbe struct {
	PublicEndpoint          minecraftEndpoint     `json:"publicEndpoint"`
	Backend                 minecraftEndpoint     `json:"backend"`
	ProxyPortPublished      bool                  `json:"proxyPortPublished"`
	BackendPortPublished    bool                  `json:"backendPortPublished"`
	VoiceChatPortPublished  bool                  `json:"voiceChatPortPublished"`
	Performance             *minecraftPerformance `json:"performance,omitempty"`
}

type dockerSnapshot struct {
	GeneratedAt time.Time          `json:"generatedAt"`
	Containers  []containerMetrics `json:"containers"`
	Minecraft   *minecraftProbe    `json:"minecraft,omitempty"`
}

type payload struct {
	ServerID     string             `json:"serverId"`
	AgentVersion string             `json:"agentVersion"`
	SentAt       time.Time          `json:"sentAt"`
	Host         hostMetrics        `json:"host"`
	Containers   []containerMetrics `json:"containers"`
	Minecraft    *minecraftProbe    `json:"minecraft,omitempty"`
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := loadConfig()
	if err != nil {
		logger.Error("設定の読み込みに失敗しました", "error", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	logger.Info("IVRM Agentを開始します", "server_id", cfg.serverID, "interval", cfg.interval.String(), "version", agentVersion)
	runOnce(ctx, logger, cfg)

	ticker := time.NewTicker(cfg.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			logger.Info("IVRM Agentを停止します")
			return
		case <-ticker.C:
			runOnce(ctx, logger, cfg)
		}
	}
}

func loadConfig() (config, error) {
	interval := 15 * time.Second
	if raw := os.Getenv("IVRM_AGENT_INTERVAL"); raw != "" {
		parsed, err := time.ParseDuration(raw)
		if err != nil {
			return config{}, fmt.Errorf("送信間隔が不正です: %w", err)
		}
		interval = parsed
	}

	dockerSnapshotPath := strings.TrimSpace(os.Getenv("IVRM_AGENT_DOCKER_SNAPSHOT_PATH"))
	if dockerSnapshotPath == "" {
		dockerSnapshotPath = defaultDockerSnapshotPath
	}

	cfg := config{
		serverID:           os.Getenv("IVRM_AGENT_SERVER_ID"),
		endpoint:           os.Getenv("IVRM_AGENT_ENDPOINT"),
		token:              os.Getenv("IVRM_AGENT_TOKEN"),
		interval:           interval,
		dockerSnapshotPath: dockerSnapshotPath,
	}
	if cfg.serverID == "" || cfg.endpoint == "" || cfg.token == "" {
		return config{}, errors.New("SERVER_ID・ENDPOINT・TOKENは必須です")
	}
	if len(cfg.token) < 32 {
		return config{}, errors.New("TOKENは32文字以上にしてください")
	}
	if cfg.interval < 10*time.Second {
		return config{}, errors.New("送信間隔は10秒以上にしてください")
	}
	if !strings.HasPrefix(cfg.dockerSnapshotPath, "/") {
		return config{}, errors.New("Dockerスナップショットのパスは絶対パスにしてください")
	}

	parsed, err := url.Parse(cfg.endpoint)
	if err != nil || parsed.Host == "" {
		return config{}, errors.New("Endpointが有効なURLではありません")
	}
	if parsed.Scheme != "https" && parsed.Hostname() != "localhost" && parsed.Hostname() != "127.0.0.1" {
		return config{}, errors.New("本番EndpointにはHTTPSが必要です")
	}
	return cfg, nil
}

func runOnce(ctx context.Context, logger *slog.Logger, cfg config) {
	metrics, err := collectHostMetrics()
	if err != nil {
		logger.Error("ホスト情報の収集に失敗しました", "error", err)
		return
	}

	now := time.Now().UTC()
	snapshot, err := readDockerSnapshot(cfg.dockerSnapshotPath, now)
	if err != nil {
		logger.Warn("Docker状態スナップショットを利用できません", "error", err)
		snapshot = dockerSnapshot{Containers: []containerMetrics{}}
	} else if err := validateSnapshotMinecraft(&snapshot); err != nil {
		logger.Warn("Minecraft Probeの一部を利用できません", "error", err)
	}

	body, err := json.Marshal(payload{
		ServerID:     cfg.serverID,
		AgentVersion: agentVersion,
		SentAt:       now,
		Host:         metrics,
		Containers:   snapshot.Containers,
		Minecraft:    snapshot.Minecraft,
	})
	if err != nil {
		logger.Error("JSON変換に失敗しました", "error", err)
		return
	}

	nonce, err := newNonce()
	if err != nil {
		logger.Error("Nonce生成に失敗しました", "error", err)
		return
	}
	timestamp := strconv.FormatInt(now.Unix(), 10)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.endpoint, bytes.NewReader(body))
	if err != nil {
		logger.Error("リクエスト作成に失敗しました", "error", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "ivrm-agent/"+agentVersion)
	req.Header.Set("X-IVRM-Agent-ID", cfg.serverID)
	req.Header.Set("X-IVRM-Timestamp", timestamp)
	req.Header.Set("X-IVRM-Nonce", nonce)
	req.Header.Set("X-IVRM-Signature", sign([]byte(cfg.token), timestamp, nonce, body))

	response, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		logger.Warn("Heartbeat送信に失敗しました", "error", err)
		return
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		logger.Warn("Heartbeat APIがエラーを返しました", "status", response.StatusCode)
		return
	}
	logger.Info(
		"Heartbeatを送信しました",
		"containers",
		len(snapshot.Containers),
		"minecraft",
		snapshot.Minecraft != nil,
		"minecraft_performance",
		snapshot.Minecraft != nil && snapshot.Minecraft.Performance != nil,
	)
}

func readDockerSnapshot(path string, now time.Time) (dockerSnapshot, error) {
	file, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return dockerSnapshot{Containers: []containerMetrics{}}, nil
		}
		return dockerSnapshot{}, err
	}
	defer file.Close()

	decoder := json.NewDecoder(io.LimitReader(file, 256*1024))
	decoder.DisallowUnknownFields()

	var snapshot dockerSnapshot
	if err := decoder.Decode(&snapshot); err != nil {
		return dockerSnapshot{}, fmt.Errorf("DockerスナップショットのJSONが不正です: %w", err)
	}
	if snapshot.GeneratedAt.IsZero() {
		return dockerSnapshot{}, errors.New("Dockerスナップショットの生成時刻がありません")
	}
	age := now.Sub(snapshot.GeneratedAt)
	if age < -5*time.Second {
		return dockerSnapshot{}, errors.New("Dockerスナップショットの生成時刻が未来です")
	}
	if age > maxDockerSnapshotAge {
		return dockerSnapshot{}, fmt.Errorf("Dockerスナップショットが古すぎます: %s", age.Round(time.Second))
	}
	if len(snapshot.Containers) > maxContainersPerSnapshot {
		return dockerSnapshot{}, fmt.Errorf("Dockerコンテナ数が上限を超えています: %d", len(snapshot.Containers))
	}

	seen := make(map[string]struct{}, len(snapshot.Containers))
	for index, container := range snapshot.Containers {
		if !containerNamePattern.MatchString(container.Name) {
			return dockerSnapshot{}, fmt.Errorf("Dockerコンテナ名が不正です: index=%d", index)
		}
		if _, ok := seen[container.Name]; ok {
			return dockerSnapshot{}, fmt.Errorf("Dockerコンテナ名が重複しています: %s", container.Name)
		}
		seen[container.Name] = struct{}{}
		if _, ok := validContainerStates[container.State]; !ok {
			return dockerSnapshot{}, fmt.Errorf("Dockerコンテナ状態が不正です: %s", container.State)
		}
		if _, ok := validContainerHealth[container.Health]; !ok {
			return dockerSnapshot{}, fmt.Errorf("Docker Healthが不正です: %s", container.Health)
		}
		if container.RestartCount < 0 {
			return dockerSnapshot{}, fmt.Errorf("Docker再起動回数が不正です: %d", container.RestartCount)
		}
		if err := validateContainerResourceMetrics(container); err != nil {
			return dockerSnapshot{}, fmt.Errorf("Dockerリソース値が不正です: %s: %w", container.Name, err)
		}
	}

	return snapshot, nil
}

func readContainerSnapshot(path string, now time.Time) ([]containerMetrics, error) {
	snapshot, err := readDockerSnapshot(path, now)
	return snapshot.Containers, err
}

func validateSnapshotMinecraft(snapshot *dockerSnapshot) error {
	if snapshot.Minecraft == nil {
		return nil
	}
	if err := validateMinecraftProbe(*snapshot.Minecraft); err != nil {
		snapshot.Minecraft = nil
		return err
	}
	if snapshot.Minecraft.Performance != nil {
		if err := validateMinecraftPerformance(*snapshot.Minecraft.Performance); err != nil {
			snapshot.Minecraft.Performance = nil
			return fmt.Errorf("性能メトリクス: %w", err)
		}
	}
	return nil
}

func validateContainerResourceMetrics(container containerMetrics) error {
	metricsCount := 0
	if container.CPUPercent != nil {
		metricsCount++
	}
	if container.MemoryUsageBytes != nil {
		metricsCount++
	}
	if container.MemoryLimitBytes != nil {
		metricsCount++
	}
	if container.NetworkRxBytes != nil {
		metricsCount++
	}
	if container.NetworkTxBytes != nil {
		metricsCount++
	}
	if container.BlockReadBytes != nil {
		metricsCount++
	}
	if container.BlockWriteBytes != nil {
		metricsCount++
	}
	if container.PIDs != nil {
		metricsCount++
	}

	if metricsCount != 0 && metricsCount != 8 {
		return errors.New("リソース値は全項目を設定するか全項目をnullにしてください")
	}
	if metricsCount == 0 {
		return nil
	}

	if math.IsNaN(*container.CPUPercent) || math.IsInf(*container.CPUPercent, 0) || *container.CPUPercent < 0 || *container.CPUPercent > 100_000 {
		return errors.New("CPU使用率が許容範囲外です")
	}
	byteValues := []*uint64{
		container.MemoryUsageBytes,
		container.MemoryLimitBytes,
		container.NetworkRxBytes,
		container.NetworkTxBytes,
		container.BlockReadBytes,
		container.BlockWriteBytes,
	}
	for _, value := range byteValues {
		if *value > maxSafeInteger {
			return errors.New("バイト値がJavaScript安全整数の範囲外です")
		}
	}
	if *container.MemoryUsageBytes > *container.MemoryLimitBytes {
		return errors.New("メモリ使用量が上限を超えています")
	}
	if *container.PIDs < 0 {
		return errors.New("PIDsが負数です")
	}
	return nil
}

func validateMinecraftProbe(probe minecraftProbe) error {
	if err := validateMinecraftEndpoint(probe.PublicEndpoint); err != nil {
		return fmt.Errorf("公開側: %w", err)
	}
	if err := validateMinecraftEndpoint(probe.Backend); err != nil {
		return fmt.Errorf("バックエンド側: %w", err)
	}
	return nil
}

func validateMinecraftEndpoint(endpoint minecraftEndpoint) error {
	presentCount := 0
	if endpoint.LatencyMs != nil {
		presentCount++
	}
	if endpoint.Version != nil {
		presentCount++
	}
	if endpoint.Online != nil {
		presentCount++
	}
	if endpoint.Max != nil {
		presentCount++
	}

	if !endpoint.Reachable {
		if presentCount != 0 {
			return errors.New("到達不能時の詳細値はnullにしてください")
		}
		return nil
	}
	if presentCount != 4 {
		return errors.New("到達可能時の詳細値が不足しています")
	}
	if *endpoint.LatencyMs < 0 || *endpoint.LatencyMs > 60_000 {
		return errors.New("レイテンシが許容範囲外です")
	}
	version := strings.TrimSpace(*endpoint.Version)
	if version == "" || utf8.RuneCountInString(version) > 128 {
		return errors.New("Versionが不正です")
	}
	if *endpoint.Online < 0 || *endpoint.Max < 1 || *endpoint.Max > maxMinecraftPlayers || *endpoint.Online > *endpoint.Max {
		return errors.New("プレイヤー数が許容範囲外です")
	}
	return nil
}

func validateMinecraftPerformance(performance minecraftPerformance) error {
	if performance.Source != "spark" {
		return errors.New("性能メトリクスSourceが不正です")
	}
	values := []struct {
		value   float64
		maximum float64
	}{
		{performance.TPS1m, maxMinecraftTPS},
		{performance.TPS5m, maxMinecraftTPS},
		{performance.TPS15m, maxMinecraftTPS},
		{performance.MSPTMedian1m, maxMinecraftMSPT},
		{performance.MSPTP95_1m, maxMinecraftMSPT},
		{performance.MSPTMax1m, maxMinecraftMSPT},
	}
	for _, item := range values {
		if math.IsNaN(item.value) || math.IsInf(item.value, 0) || item.value < 0 || item.value > item.maximum {
			return errors.New("性能メトリクス値が許容範囲外です")
		}
	}
	if performance.MSPTMedian1m > performance.MSPTP95_1m || performance.MSPTP95_1m > performance.MSPTMax1m {
		return errors.New("MSPT percentileの順序が不正です")
	}
	return nil
}

func newNonce() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func sign(token []byte, timestamp string, nonce string, body []byte) string {
	mac := hmac.New(sha256.New, token)
	mac.Write([]byte(timestamp))
	mac.Write([]byte("."))
	mac.Write([]byte(nonce))
	mac.Write([]byte("."))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func collectHostMetrics() (hostMetrics, error) {
	load, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return hostMetrics{}, err
	}
	fields := strings.Fields(string(load))
	if len(fields) < 3 {
		return hostMetrics{}, errors.New("loadavgの形式が不正です")
	}

	loadAverage1, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return hostMetrics{}, err
	}
	loadAverage5, err := strconv.ParseFloat(fields[1], 64)
	if err != nil {
		return hostMetrics{}, err
	}
	loadAverage15, err := strconv.ParseFloat(fields[2], 64)
	if err != nil {
		return hostMetrics{}, err
	}

	memoryTotal, memoryAvailable, err := readMemory()
	if err != nil {
		return hostMetrics{}, err
	}

	uptimeRaw, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return hostMetrics{}, err
	}
	uptimeFields := strings.Fields(string(uptimeRaw))
	if len(uptimeFields) == 0 {
		return hostMetrics{}, errors.New("uptimeの形式が不正です")
	}
	uptime, err := strconv.ParseFloat(uptimeFields[0], 64)
	if err != nil {
		return hostMetrics{}, err
	}

	var disk syscall.Statfs_t
	if err := syscall.Statfs("/", &disk); err != nil {
		return hostMetrics{}, fmt.Errorf("ディスク情報を取得できません: %w", err)
	}

	return hostMetrics{
		CPUCount:             runtime.NumCPU(),
		MemoryTotalBytes:     memoryTotal,
		MemoryAvailableBytes: memoryAvailable,
		DiskTotalBytes:       disk.Blocks * uint64(disk.Bsize),
		DiskAvailableBytes:   disk.Bavail * uint64(disk.Bsize),
		LoadAverage1:         loadAverage1,
		LoadAverage5:         loadAverage5,
		LoadAverage15:        loadAverage15,
		UptimeSeconds:        uptime,
	}, nil
}

func readMemory() (uint64, uint64, error) {
	file, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0, err
	}
	defer file.Close()

	return readMemoryFrom(file)
}

func readMemoryFrom(reader io.Reader) (uint64, uint64, error) {
	var total uint64
	var available uint64
	var totalFound bool
	var availableFound bool

	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch strings.TrimSuffix(fields[0], ":") {
		case "MemTotal":
			total = value * 1024
			totalFound = true
		case "MemAvailable":
			available = value * 1024
			availableFound = true
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, 0, err
	}
	if !totalFound || !availableFound || total == 0 {
		return 0, 0, errors.New("必要なメモリ情報がありません")
	}
	return total, available, nil
}
