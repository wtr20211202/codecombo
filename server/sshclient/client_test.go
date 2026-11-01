package sshclient

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"strings"
	"testing"
)

func TestBuildAuthMethodsPassword(t *testing.T) {
	m, err := buildAuthMethods(AuthMethod{Type: AuthTypePassword, Password: "secret"})
	if err != nil {
		t.Fatalf("buildAuthMethods: %v", err)
	}
	if len(m) != 1 {
		t.Fatalf("expected 1 method, got %d", len(m))
	}
}

func TestBuildAuthMethodsPasswordEmpty(t *testing.T) {
	_, err := buildAuthMethods(AuthMethod{Type: AuthTypePassword, Password: ""})
	if err == nil {
		t.Fatal("expected error for empty password")
	}
}

func TestBuildAuthMethodsPemRSA(t *testing.T) {
	priv, _ := rsa.GenerateKey(rand.Reader, 2048)
	keyBytes := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(priv),
	})
	m, err := buildAuthMethods(AuthMethod{Type: AuthTypePem, PemContent: string(keyBytes)})
	if err != nil {
		t.Fatalf("buildAuthMethods pem: %v", err)
	}
	if len(m) != 1 {
		t.Fatalf("expected 1 method, got %d", len(m))
	}
}

func TestBuildAuthMethodsInvalidPem(t *testing.T) {
	_, err := buildAuthMethods(AuthMethod{Type: AuthTypePem, PemContent: "not a pem"})
	if err == nil {
		t.Fatal("expected error for invalid pem")
	}
}

func TestBuildAuthMethodsUnknownType(t *testing.T) {
	_, err := buildAuthMethods(AuthMethod{Type: "unknown"})
	if err == nil {
		t.Fatal("expected error for unknown type")
	}
}

func TestShellQuote(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"", "''"},
		{"simple", "simple"},
		{"hello world", "'hello world'"},
		{"a'b", "'a'\"'\"'b'"},
		{"$VAR", "'$VAR'"},
		{"a;b", "'a;b'"},
	}
	for _, c := range cases {
		got := shellQuote(c.in)
		if got != c.want {
			t.Errorf("shellQuote(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestSanitizeCommandForLog(t *testing.T) {
	got := SanitizeCommandForLog("export ANTHROPIC_TOKEN=secret123 && bash")
	if strings.Contains(got, "secret123") {
		t.Errorf("token not sanitized: %s", got)
	}
	if !strings.Contains(got, "***") {
		t.Errorf("expected *** placeholder, got %s", got)
	}
}

func TestSanitizeCommandForLogKeepsNonExport(t *testing.T) {
	cmd := "useradd -m -G wheel cld"
	got := SanitizeCommandForLog(cmd)
	if got != cmd {
		t.Errorf("non-export commands should be unchanged, got %s", got)
	}
}

func TestSplitLinesEmpty(t *testing.T) {
	if got := splitLines(""); len(got) != 0 {
		t.Errorf("expected empty, got %v", got)
	}
}

func TestSplitLines(t *testing.T) {
	got := splitLines("a\nb\nc")
	if len(got) != 3 || got[0] != "a" || got[2] != "c" {
		t.Errorf("expected [a b c], got %v", got)
	}
}
