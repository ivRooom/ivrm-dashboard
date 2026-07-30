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
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const agentVersion = "0.2.0"

type config struct {
	serverID string
	endpoint string
	token    string
	interval time.Duration
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

type payload struct {
	ServerID     string      `json:"serverId"`
	AgentVersion string      `json:"agentVersion"`
	SentAt       time.Time   `json:"sentAt"`
	Host         hostMetrics `json:"host"`
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

	cfg := config{
		serverID: os.Getenv("IVRM_AGENT_SERVER_ID"),
		endpoint: os.Getenv("IVRM_AGENT_ENDPOINT"),
		token:    os.Getenv("IVRM_AGENT_TOKEN"),
		interval: interval,
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
	body, err := json.Marshal(payload{
		ServerID:     cfg.serverID,
		AgentVersion: agentVersion,
		SentAt:       now,
		Host:         metrics,
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
	logger.Info("Heartbeatを送信しました")
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

	var total uint64
	var available uint64
	scanner := bufio.NewScanner(file)
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
		case "MemAvailable":
			available = value * 1024
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, 0, err
	}
	if total == 0 || available == 0 {
		return 0, 0, errors.New("必要なメモリ情報がありません")
	}
	return total, available, nil
}
