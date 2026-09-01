package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testConfig(t *testing.T) config {
	t.Helper()
	return config{
		serverID:           fixedServerID,
		token:              "0123456789abcdef0123456789abcdef",
		claimEndpoint:      "https://console.ivrm.jp/api/agent/operations/claim",
		transitionEndpoint: "https://console.ivrm.jp/api/agent/operations/transition",
		leaseOwner:         fixedServerID + ":operation-worker",
		workDir:            t.TempDir(),
		pollInterval:       time.Second,
		resultTimeout:      100 * time.Millisecond,
		executionEnabled:   false,
	}
}

func TestValidActionAllowlist(t *testing.T) {
	for _, action := range []string{"start_backend", "restart_backend", "stop_backend"} {
		if !validAction(action) {
			t.Fatalf("expected allowed action: %s", action)
		}
	}
	for _, action := range []string{"restart_proxy", "docker", "shell", "rcon", ""} {
		if validAction(action) {
			t.Fatalf("unexpected allowed action: %s", action)
		}
	}
}

func TestLoadConfigExecutionDisabledByDefault(t *testing.T) {
	t.Setenv("IVRM_AGENT_SERVER_ID", fixedServerID)
	t.Setenv("IVRM_AGENT_TOKEN", "0123456789abcdef0123456789abcdef")
	t.Setenv("IVRM_OPERATION_CLAIM_ENDPOINT", "https://console.ivrm.jp/api/agent/operations/claim")
	t.Setenv("IVRM_OPERATION_TRANSITION_ENDPOINT", "https://console.ivrm.jp/api/agent/operations/transition")
	os.Unsetenv("IVRM_OPERATION_EXECUTION_ENABLED")
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.executionEnabled {
		t.Fatal("execution must default to false")
	}
}

func TestWriteExclusiveRejectsDuplicateAndUsesOwnerOnlyMode(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "job.json")
	if err := writeExclusive(path, []byte(`{"jobId":"x"}`)); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("unexpected mode: %o", info.Mode().Perm())
	}
	if err := writeExclusive(path, []byte(`{"jobId":"y"}`)); err == nil {
		t.Fatal("expected duplicate write rejection")
	}
}

func TestConfigRejectsArbitraryServerID(t *testing.T) {
	t.Setenv("IVRM_AGENT_SERVER_ID", "other-host")
	t.Setenv("IVRM_AGENT_TOKEN", "0123456789abcdef0123456789abcdef")
	t.Setenv("IVRM_OPERATION_CLAIM_ENDPOINT", "https://console.ivrm.jp/api/agent/operations/claim")
	t.Setenv("IVRM_OPERATION_TRANSITION_ENDPOINT", "https://console.ivrm.jp/api/agent/operations/transition")
	if _, err := loadConfig(); err == nil {
		t.Fatal("expected fixed server ID rejection")
	}
}

func TestConfigRejectsArbitraryOperationEndpoint(t *testing.T) {
	t.Setenv("IVRM_AGENT_SERVER_ID", fixedServerID)
	t.Setenv("IVRM_AGENT_TOKEN", "0123456789abcdef0123456789abcdef")
	t.Setenv("IVRM_OPERATION_CLAIM_ENDPOINT", "https://example.com/api/agent/operations/claim")
	t.Setenv("IVRM_OPERATION_TRANSITION_ENDPOINT", "https://console.ivrm.jp/api/agent/operations/transition")
	if _, err := loadConfig(); err == nil {
		t.Fatal("expected endpoint host rejection")
	}
}

func TestConfigBoundsResultTimeoutBelowLease(t *testing.T) {
	t.Setenv("IVRM_AGENT_SERVER_ID", fixedServerID)
	t.Setenv("IVRM_AGENT_TOKEN", "0123456789abcdef0123456789abcdef")
	t.Setenv("IVRM_OPERATION_CLAIM_ENDPOINT", "https://console.ivrm.jp/api/agent/operations/claim")
	t.Setenv("IVRM_OPERATION_TRANSITION_ENDPOINT", "https://console.ivrm.jp/api/agent/operations/transition")
	t.Setenv("IVRM_OPERATION_RESULT_TIMEOUT", "241s")
	if _, err := loadConfig(); err == nil {
		t.Fatal("expected result timeout rejection")
	}
	t.Setenv("IVRM_OPERATION_RESULT_TIMEOUT", "225s")
	if _, err := loadConfig(); err != nil {
		t.Fatal(err)
	}
}

func TestSignedPostRejectsRedirectWithoutForwardingSignedHeaders(t *testing.T) {
	forwarded := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		forwarded = true
		w.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirector.Close()

	cfg := testConfig(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := signedPost(ctx, cfg, redirector.URL, []byte(`{}`)); err == nil {
		t.Fatal("expected redirect rejection")
	}
	if forwarded {
		t.Fatal("signed request followed redirect")
	}
}

func TestTransitionAcceptsExpectedResponseFields(t *testing.T) {
	job := claimedJob{JobID: "123e4567-e89b-42d3-a456-426614174000", Action: "start_backend", Status: "running"}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"accepted":true,"jobId":"123e4567-e89b-42d3-a456-426614174000","status":"succeeded"}`))
	}))
	defer server.Close()
	cfg := testConfig(t)
	cfg.transitionEndpoint = server.URL
	if err := transition(context.Background(), cfg, job, "running", "succeeded", map[string]string{"phase": "health_gate_passed"}); err != nil {
		t.Fatal(err)
	}
}

func TestRecoveryRequiresExistingIPCState(t *testing.T) {
	cfg := testConfig(t)
	if err := os.MkdirAll(filepath.Join(cfg.workDir, "requests"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(cfg.workDir, "results"), 0o750); err != nil {
		t.Fatal(err)
	}
	job := claimedJob{JobID: "123e4567-e89b-42d3-a456-426614174000", Action: "restart_backend", Status: "running"}
	_, err := executeThroughIPC(context.Background(), cfg, job, false)
	if !errors.Is(err, errRecoveryStateMissing) {
		t.Fatalf("expected recovery state error, got %v", err)
	}
}
