package main

import (
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
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	fixedServerID        = "oci-minecraft-01"
	defaultPollInterval  = 5 * time.Second
	defaultResultTimeout = 225 * time.Second
	maxResultTimeout     = 240 * time.Second
	maxResponseBytes     = 16 * 1024
)

var (
	uuidPattern             = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)
	errorCodePattern        = regexp.MustCompile(`^[a-z0-9._:-]{1,120}$`)
	errRecoveryStateMissing = errors.New("recovery state missing")
	operationHTTPClient     = &http.Client{
		Timeout: 10 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
)

type config struct {
	serverID           string
	token              string
	claimEndpoint      string
	transitionEndpoint string
	leaseOwner         string
	workDir            string
	pollInterval       time.Duration
	resultTimeout      time.Duration
	executionEnabled   bool
}

type claimedJob struct {
	JobID          string `json:"jobId"`
	Action         string `json:"action"`
	Status         string `json:"status"`
	LeaseExpiresAt string `json:"leaseExpiresAt"`
}

type claimResponse struct {
	Accepted bool        `json:"accepted"`
	Job      *claimedJob `json:"job"`
	Error    string      `json:"error"`
}

type executorRequest struct {
	JobID  string `json:"jobId"`
	Action string `json:"action"`
}

type executorResult struct {
	JobID     string `json:"jobId"`
	Action    string `json:"action"`
	OK        bool   `json:"ok"`
	Phase     string `json:"phase"`
	ErrorCode string `json:"errorCode,omitempty"`
}

type transitionRequest struct {
	ServerID       string            `json:"serverId"`
	JobID          string            `json:"jobId"`
	Action         string            `json:"action"`
	ExpectedStatus string            `json:"expectedStatus"`
	NewStatus      string            `json:"newStatus"`
	LeaseOwner     string            `json:"leaseOwner"`
	RequestID      string            `json:"requestId"`
	Details        map[string]string `json:"details"`
}

type transitionResponse struct {
	Accepted bool   `json:"accepted"`
	JobID    string `json:"jobId"`
	Status   string `json:"status"`
	Error    string `json:"error"`
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := loadConfig()
	if err != nil {
		logger.Error("Operation Worker設定の読み込みに失敗しました", "error", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	logger.Info("Operation Workerを開始します", "server_id", cfg.serverID, "execution_enabled", cfg.executionEnabled)

	if !cfg.executionEnabled {
		logger.Info("Operation executionはOFFです。Jobをclaimしません")
		<-ctx.Done()
		return
	}
	if err := validateWorkDirs(cfg.workDir); err != nil {
		logger.Error("Operation IPC directoryを利用できません", "error", err)
		os.Exit(1)
	}

	runOnce(ctx, logger, cfg)
	ticker := time.NewTicker(cfg.pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			logger.Info("Operation Workerを停止します")
			return
		case <-ticker.C:
			runOnce(ctx, logger, cfg)
		}
	}
}

func loadConfig() (config, error) {
	cfg := config{
		serverID:           strings.TrimSpace(os.Getenv("IVRM_AGENT_SERVER_ID")),
		token:              strings.TrimSpace(os.Getenv("IVRM_AGENT_TOKEN")),
		claimEndpoint:      strings.TrimSpace(os.Getenv("IVRM_OPERATION_CLAIM_ENDPOINT")),
		transitionEndpoint: strings.TrimSpace(os.Getenv("IVRM_OPERATION_TRANSITION_ENDPOINT")),
		leaseOwner:         strings.TrimSpace(os.Getenv("IVRM_OPERATION_LEASE_OWNER")),
		workDir:            strings.TrimSpace(os.Getenv("IVRM_OPERATION_WORK_DIR")),
		pollInterval:       defaultPollInterval,
		resultTimeout:      defaultResultTimeout,
		executionEnabled:   strings.EqualFold(strings.TrimSpace(os.Getenv("IVRM_OPERATION_EXECUTION_ENABLED")), "true"),
	}
	if cfg.serverID != fixedServerID {
		return config{}, fmt.Errorf("SERVER_IDは%s固定です", fixedServerID)
	}
	if len(cfg.token) < 32 {
		return config{}, errors.New("TOKENは32文字以上にしてください")
	}
	if cfg.claimEndpoint == "" || cfg.transitionEndpoint == "" {
		return config{}, errors.New("Operation API endpointは必須です")
	}
	if err := validateEndpoint(cfg.claimEndpoint, "/api/agent/operations/claim"); err != nil {
		return config{}, fmt.Errorf("Claim endpointが不正です: %w", err)
	}
	if err := validateEndpoint(cfg.transitionEndpoint, "/api/agent/operations/transition"); err != nil {
		return config{}, fmt.Errorf("Transition endpointが不正です: %w", err)
	}
	if cfg.leaseOwner == "" {
		cfg.leaseOwner = fixedServerID + ":operation-worker"
	}
	if !regexp.MustCompile(`^[A-Za-z0-9._:-]{1,120}$`).MatchString(cfg.leaseOwner) {
		return config{}, errors.New("Lease Ownerが不正です")
	}
	if cfg.workDir == "" {
		cfg.workDir = "/run/ivrm-agent/operations"
	}
	if !filepath.IsAbs(cfg.workDir) {
		return config{}, errors.New("Operation work directoryは絶対パスにしてください")
	}
	if raw := strings.TrimSpace(os.Getenv("IVRM_OPERATION_POLL_INTERVAL")); raw != "" {
		value, err := time.ParseDuration(raw)
		if err != nil || value < time.Second || value > time.Minute {
			return config{}, errors.New("Operation poll intervalが不正です")
		}
		cfg.pollInterval = value
	}
	if raw := strings.TrimSpace(os.Getenv("IVRM_OPERATION_RESULT_TIMEOUT")); raw != "" {
		value, err := time.ParseDuration(raw)
		if err != nil || value < 30*time.Second || value > maxResultTimeout {
			return config{}, errors.New("Operation result timeoutが不正です")
		}
		cfg.resultTimeout = value
	}
	return cfg, nil
}

func validateEndpoint(raw, expectedPath string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return errors.New("URLではありません")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != expectedPath {
		return errors.New("endpoint pathまたはURL要素が許可されていません")
	}
	local := parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1"
	if local {
		if parsed.Scheme != "http" && parsed.Scheme != "https" {
			return errors.New("localhost endpointのschemeが不正です")
		}
		return nil
	}
	if parsed.Scheme != "https" || parsed.Hostname() != "console.ivrm.jp" {
		return errors.New("Production endpointはhttps://console.ivrm.jp固定です")
	}
	if port := parsed.Port(); port != "" && port != "443" {
		return errors.New("Production endpointのportが不正です")
	}
	return nil
}

func validateWorkDirs(workDir string) error {
	for _, name := range []string{"requests", "results"} {
		info, err := os.Stat(filepath.Join(workDir, name))
		if err != nil {
			return err
		}
		if !info.IsDir() {
			return fmt.Errorf("%s is not a directory", name)
		}
	}
	return nil
}

func runOnce(ctx context.Context, logger *slog.Logger, cfg config) {
	job, err := claim(ctx, cfg)
	if err != nil {
		logger.Warn("Operation Job claimに失敗しました", "error", err)
		return
	}
	if job == nil {
		return
	}
	if !validAction(job.Action) || !uuidPattern.MatchString(job.JobID) || (job.Status != "leased" && job.Status != "running") {
		logger.Error("ClaimされたJobがallowlist契約に違反しています")
		return
	}

	publishRequest := false
	if job.Status == "leased" {
		if err := transition(ctx, cfg, *job, "leased", "running", map[string]string{"phase": "executing"}); err != nil {
			logger.Warn("Operation Jobをrunningへ遷移できません", "job_id", job.JobID, "error", err)
			return
		}
		job.Status = "running"
		publishRequest = true
	} else {
		logger.Info("in-flight Operation Jobを再開します", "job_id", job.JobID, "action", job.Action)
	}

	result, err := executeThroughIPC(ctx, cfg, *job, publishRequest)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			logger.Warn("Worker停止のためin-flight Jobを次回起動へ引き継ぎます", "job_id", job.JobID)
			return
		}
		code := "executor_timeout"
		if errors.Is(err, errRecoveryStateMissing) {
			code = "recovery_state_missing"
		}
		if terminalTransition(cfg, *job, "failed", map[string]string{"phase": "execution_failed", "errorCode": code}) {
			cleanupRequest(cfg, *job)
		}
		logger.Warn("Lifecycle helperの実行に失敗しました", "job_id", job.JobID, "error_code", code)
		return
	}

	if !result.OK {
		code := result.ErrorCode
		if !errorCodePattern.MatchString(code) {
			code = "executor_failed"
		}
		if terminalTransition(cfg, *job, "failed", map[string]string{"phase": "execution_failed", "errorCode": code}) {
			cleanupRequest(cfg, *job)
		}
		return
	}

	expectedPhase := "health_gate_passed"
	if job.Action == "stop_backend" {
		expectedPhase = "stopped"
	}
	if result.Phase != expectedPhase {
		if terminalTransition(cfg, *job, "failed", map[string]string{"phase": "execution_failed", "errorCode": "executor_result_invalid"}) {
			cleanupRequest(cfg, *job)
		}
		return
	}
	if terminalTransition(cfg, *job, "succeeded", map[string]string{"phase": expectedPhase}) {
		cleanupRequest(cfg, *job)
	}
}

func terminalTransition(cfg config, job claimedJob, status string, details map[string]string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := transition(ctx, cfg, job, "running", status, details); err != nil {
		return false
	}
	return true
}

func cleanupRequest(cfg config, job claimedJob) {
	_ = os.Remove(filepath.Join(cfg.workDir, "requests", job.JobID+".json"))
}

func validAction(action string) bool {
	return action == "start_backend" || action == "restart_backend" || action == "stop_backend"
}

func claim(ctx context.Context, cfg config) (*claimedJob, error) {
	body, err := json.Marshal(map[string]string{"serverId": cfg.serverID, "leaseOwner": cfg.leaseOwner})
	if err != nil {
		return nil, err
	}
	response, err := signedPost(ctx, cfg, cfg.claimEndpoint, body)
	if err != nil {
		return nil, err
	}
	var parsed claimResponse
	if err := decodeJSON(response, &parsed); err != nil {
		return nil, err
	}
	if !parsed.Accepted {
		return nil, fmt.Errorf("claim rejected: %s", safeError(parsed.Error))
	}
	return parsed.Job, nil
}

func transition(ctx context.Context, cfg config, job claimedJob, expected, next string, details map[string]string) error {
	requestID, err := newUUIDv4()
	if err != nil {
		return err
	}
	body, err := json.Marshal(transitionRequest{
		ServerID:       cfg.serverID,
		JobID:          job.JobID,
		Action:         job.Action,
		ExpectedStatus: expected,
		NewStatus:      next,
		LeaseOwner:     cfg.leaseOwner,
		RequestID:      requestID,
		Details:        details,
	})
	if err != nil {
		return err
	}
	response, err := signedPost(ctx, cfg, cfg.transitionEndpoint, body)
	if err != nil {
		return err
	}
	var parsed transitionResponse
	if err := decodeJSON(response, &parsed); err != nil {
		return err
	}
	if !parsed.Accepted {
		return fmt.Errorf("transition rejected: %s", safeError(parsed.Error))
	}
	if parsed.JobID != job.JobID || parsed.Status != next {
		return errors.New("transition response mismatch")
	}
	return nil
}

func signedPost(ctx context.Context, cfg config, endpoint string, body []byte) (*http.Response, error) {
	nonce, err := newNonce()
	if err != nil {
		return nil, err
	}
	timestamp := strconv.FormatInt(time.Now().UTC().Unix(), 10)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "ivrm-operation-worker/0.1.0")
	req.Header.Set("X-IVRM-Agent-ID", cfg.serverID)
	req.Header.Set("X-IVRM-Timestamp", timestamp)
	req.Header.Set("X-IVRM-Nonce", nonce)
	req.Header.Set("X-IVRM-Signature", sign([]byte(cfg.token), timestamp, nonce, body))
	response, err := operationHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponseBytes))
		return nil, fmt.Errorf("operation API returned %d", response.StatusCode)
	}
	return response, nil
}

func decodeJSON(response *http.Response, target any) error {
	defer response.Body.Close()
	decoder := json.NewDecoder(io.LimitReader(response.Body, maxResponseBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	return nil
}

func executeThroughIPC(ctx context.Context, cfg config, job claimedJob, publishRequest bool) (executorResult, error) {
	requestPath := filepath.Join(cfg.workDir, "requests", job.JobID+".json")
	resultPath := filepath.Join(cfg.workDir, "results", job.JobID+".json")

	if publishRequest {
		if pathExists(requestPath) || pathExists(resultPath) {
			return executorResult{}, errors.New("unexpected IPC residue")
		}
		body, err := json.Marshal(executorRequest{JobID: job.JobID, Action: job.Action})
		if err != nil {
			return executorResult{}, err
		}
		if err := writeExclusive(requestPath, body); err != nil {
			return executorResult{}, err
		}
	} else if !pathExists(requestPath) && !pathExists(resultPath) {
		return executorResult{}, errRecoveryStateMissing
	}

	deadline := time.NewTimer(cfg.resultTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return executorResult{}, ctx.Err()
		case <-deadline.C:
			_ = os.Remove(requestPath)
			return executorResult{}, errors.New("executor result timeout")
		case <-ticker.C:
			result, found, err := readExecutorResult(resultPath, job)
			if err != nil {
				return executorResult{}, err
			}
			if found {
				return result, nil
			}
		}
	}
}

func readExecutorResult(path string, job claimedJob) (executorResult, bool, error) {
	body, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return executorResult{}, false, nil
	}
	if err != nil {
		return executorResult{}, false, err
	}
	if len(body) > 4096 {
		return executorResult{}, false, errors.New("executor result too large")
	}
	var result executorResult
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil {
		return executorResult{}, false, err
	}
	if result.JobID != job.JobID || result.Action != job.Action {
		return executorResult{}, false, errors.New("executor result mismatch")
	}
	return result, true, nil
}

func pathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func writeExclusive(path string, body []byte) error {
	suffix, err := newNonce()
	if err != nil {
		return err
	}
	tempPath := path + "." + suffix + ".tmp"
	file, err := os.OpenFile(tempPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer os.Remove(tempPath)
	if _, err := file.Write(body); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Link(tempPath, path)
}

func newNonce() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return hex.EncodeToString(value), nil
}

func newUUIDv4() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		value[0:4], value[4:6], value[6:8], value[8:10], value[10:16]), nil
}

func sign(token []byte, timestamp, nonce string, body []byte) string {
	mac := hmac.New(sha256.New, token)
	mac.Write([]byte(timestamp))
	mac.Write([]byte("."))
	mac.Write([]byte(nonce))
	mac.Write([]byte("."))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func safeError(value string) string {
	if errorCodePattern.MatchString(value) {
		return value
	}
	return "operation_rejected"
}
