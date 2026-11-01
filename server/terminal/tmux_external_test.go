package terminal

import (
	"strings"
	"testing"
)

func TestParseExternalTmuxSessions(t *testing.T) {
	out := "build-task\t1\t1728000000\t3\t1728000100\n" +
		"train\t0\t1728000001\t1\t\n" +
		"\n" +
		"weird\t-notanumber\t-x\t-y\t-z\n"
	sessions := parseExternalTmuxSessions(out)
	if len(sessions) != 3 {
		t.Fatalf("expected 3 sessions, got %d: %+v", len(sessions), sessions)
	}
	first := sessions[0]
	if first.Name != "build-task" || first.Attached != 1 || first.CreatedAt != 1728000000 ||
		first.Windows != 3 || first.Activity != 1728000100 {
		t.Fatalf("unexpected first session: %+v", first)
	}
	// activity 缺失（旧 tmux）按 0 处理，诚实缺省不虚构
	second := sessions[1]
	if second.Name != "train" || second.Attached != 0 || second.Windows != 1 || second.Activity != 0 {
		t.Fatalf("unexpected second session: %+v", second)
	}
	// 畸形行不致命：会话名保留，数字段零值
	third := sessions[2]
	if third.Name != "weird" || third.Attached != 0 || third.CreatedAt != 0 {
		t.Fatalf("unexpected malformed session: %+v", third)
	}

	if got := parseExternalTmuxSessions(""); len(got) != 0 {
		t.Fatalf("expected empty parse for empty output, got %+v", got)
	}
}

func TestValidateExternalTmuxName(t *testing.T) {
	cases := []struct {
		name string
		ok   bool
	}{
		{"build-task", true},
		{"train_01", true},
		{"", false},
		{"has space", false},
		{"has.dot", false},
		{"has:colon", false},
		{strings.Repeat("a", 128), true},
		{strings.Repeat("a", 129), false},
	}
	for _, tc := range cases {
		msg := ValidateExternalTmuxName(tc.name)
		if tc.ok && msg != "" {
			t.Errorf("ValidateExternalTmuxName(%q) = %q, want ok", tc.name, msg)
		}
		if !tc.ok && msg == "" {
			t.Errorf("ValidateExternalTmuxName(%q) = \"\", want error", tc.name)
		}
	}
}
