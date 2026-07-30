package main

import (
	"regexp"
	"testing"
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
