package auth

import (
	"errors"
	"fmt"
	"testing"
)

func TestAuthErrorKindClassification(t *testing.T) {
	cases := []struct {
		err  *AuthError
		kind ErrKind
	}{
		{ExpiredError("op", errors.New("invalid_grant")), KindAuthExpired},
		{PendingError("op", nil), KindAuthPending},
		{SlowDownError("op", nil), KindAuthSlowDown},
		{DeniedError("op", errors.New("access_denied")), KindAuthDenied},
		{NetworkError("op", errors.New("timeout")), KindNetwork},
		{ConfigError("op", errors.New("missing")), KindConfig},
		{InternalError("op", errors.New("panic")), KindInternal},
	}
	for i, c := range cases {
		if c.err.Kind != c.kind {
			t.Errorf("case %d: kind = %v, want %v", i, c.err.Kind, c.kind)
		}
	}
}

func TestAuthErrorErrorsAs(t *testing.T) {
	err := ExpiredError("refresh", fmt.Errorf("invalid_grant"))
	var ae *AuthError
	if !errors.As(err, &ae) {
		t.Fatal("errors.As should match *AuthError")
	}
	if ae.Op != "refresh" {
		t.Errorf("Op = %q, want %q", ae.Op, "refresh")
	}
}

func TestKindString(t *testing.T) {
	cases := map[ErrKind]string{
		KindAuthExpired:  "expired",
		KindAuthPending:  "pending",
		KindAuthSlowDown: "slow_down",
		KindAuthDenied:   "denied",
		KindNetwork:      "network",
		KindConfig:       "config",
		KindInternal:     "internal",
	}
	for k, want := range cases {
		if got := k.String(); got != want {
			t.Errorf("Kind %d: String() = %q, want %q", k, got, want)
		}
	}
}
