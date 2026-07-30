package main

import "testing"

func TestSignIsStable(t *testing.T) {
	t.Parallel()
	actual := sign([]byte("secret"), "123", []byte(`{"ok":true}`))
	const expected = "12f14ade5e7e737164d9ae20ea4e070056a3045b2c8f42f5f216008eae4684dd"
	if actual != expected {
		t.Fatalf("署名が一致しません: got=%s want=%s", actual, expected)
	}
}
