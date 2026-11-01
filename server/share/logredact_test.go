package share

import (
	"strings"
	"testing"
)

func TestTokenSummary(t *testing.T) {
	cases := []struct {
		name  string
		token string
		want  string
	}{
		{"empty stays empty", "", ""},
		{"16-char base36 keeps half", "abcd1234efgh5678", "abcd1234…"},
		{"exactly prefix length hides entirely", "abcd1234", "***"},
		{"shorter than prefix hides entirely", "abc", "***"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := TokenSummary(tc.token); got != tc.want {
				t.Fatalf("TokenSummary(%q) = %q, want %q", tc.token, got, tc.want)
			}
		})
	}
}

func TestTokenSummaryNeverReturnsFullValue(t *testing.T) {
	token := "abcd1234efgh5678"
	if s := TokenSummary(token); strings.Contains(s, token) {
		t.Fatalf("summary %q leaks the full token", s)
	}
}

// ginLineFormat 仿 gin v1.12 DefaultLogFormatter 的行形态（脱敏作用于
// 拼好的行，样本要贴近真实输出而非裸路径）
func ginLineFormat(method, status, path string) string {
	return `[GIN] 2026/10/05 - 12:00:00 | ` + status + ` |        1.234ms |       127.0.0.1 | ` +
		method + `     "` + path + `"`
}

func TestRedactLogLine(t *testing.T) {
	const tok = "abcd1234efgh5678" // 16 字符，与 DeriveShareToken 产出同形态

	cases := []struct {
		name      string
		line      string
		wantParts []string // 必须同时出现的片段
		notParts  []string // 必须不出现的片段
	}{
		{
			name:      "revoke path redacted",
			line:      ginLineFormat("DELETE", "200", "/api/share/"+tok),
			wantParts: []string{`"/api/share/abcd1234…"`},
			notParts:  []string{tok, "efgh5678"},
		},
		{
			name:      "rotate path redacted, action suffix intact",
			line:      ginLineFormat("POST", "200", "/api/share/"+tok+"/rotate"),
			wantParts: []string{"/api/share/abcd1234…/rotate"},
			notParts:  []string{tok},
		},
		{
			name:      "expiry path redacted",
			line:      ginLineFormat("POST", "200", "/api/share/"+tok+"/expiry"),
			wantParts: []string{"/api/share/abcd1234…/expiry"},
			notParts:  []string{tok},
		},
		{
			name:      "static route words untouched",
			line:      ginLineFormat("GET", "200", "/api/share/status"),
			wantParts: []string{"/api/share/status"},
			notParts:  []string{"***"},
		},
		{
			name:      "snippet route word untouched",
			line:      ginLineFormat("POST", "200", "/api/share/snippet"),
			wantParts: []string{"/api/share/snippet"},
			notParts:  []string{"***"},
		},
		{
			name:      "create path without token untouched",
			line:      ginLineFormat("POST", "200", "/api/share"),
			wantParts: []string{"POST", `"/api/share"`},
			notParts:  []string{"***", "…"},
		},
		{
			name:      "oauth device_code query redacted",
			line:      ginLineFormat("GET", "200", "/api/oauth/poll?device_code=GHS.abcd-1234"),
			wantParts: []string{"device_code=GHS.abcd…", "/api/oauth/poll"},
			notParts:  []string{"GHS.abcd-1234"},
		},
		{
			name:      "share path and device_code in one line both redacted",
			line:      ginLineFormat("DELETE", "200", "/api/share/"+tok) + " extra device_code=zzzzzzzz-yyyy9999",
			wantParts: []string{"/api/share/abcd1234…", "device_code=zzzzzzzz…"},
			notParts:  []string{tok, "yyyy9999"},
		},
		{
			name:      "unrelated line returned as-is",
			line:      ginLineFormat("GET", "200", "/api/projects/p1/files"),
			wantParts: []string{"GET", `"/api/projects/p1/files"`},
			notParts:  []string{"***", "…"},
		},
		{
			name:      "path segment below length floor untouched",
			line:      ginLineFormat("GET", "404", "/api/share/abcde1234"),
			wantParts: []string{"/api/share/abcde1234"},
			notParts:  []string{"***", "…"},
		},
		{
			name:      "hook token path redacted",
			line:      ginLineFormat("POST", "200", "/api/hooks/sch_0123456789abcdef0123456789abcdef"),
			wantParts: []string{`"/api/hooks/sch_0123…"`},
			notParts:  []string{"sch_0123456789abcdef0123456789abcdef", "456789abcdef"},
		},
		{
			name:      "header-only hook endpoint untouched",
			line:      ginLineFormat("POST", "200", "/api/hooks"),
			wantParts: []string{`"/api/hooks"`},
			notParts:  []string{"***", "…"},
		},
		{
			name:      "share path segment at length floor redacted",
			line:      ginLineFormat("GET", "404", "/api/share/abcde12345"),
			wantParts: []string{"/api/share/abcde123…"},
			notParts:  []string{"abcde12345"},
		},
		{
			// 同源访客面（P-20261020-2）：/s/<token> 挂上主引擎后同样进 gin
			// 访问日志，token 是直达内容的凭据，必须与 /api/share 同口径打码
			name:      "same-origin visitor path redacted",
			line:      ginLineFormat("GET", "200", "/s/"+tok),
			wantParts: []string{`"/s/abcd1234…"`},
			notParts:  []string{tok, "efgh5678"},
		},
		{
			name:      "same-origin visitor subresource keeps suffix",
			line:      ginLineFormat("GET", "200", "/s/"+tok+"/meta?path=docs"),
			wantParts: []string{"/s/abcd1234…/meta?path=docs"},
			notParts:  []string{tok},
		},
		{
			name:      "same-origin asset path untouched",
			line:      ginLineFormat("GET", "200", "/assets/xterm.js"),
			wantParts: []string{"/assets/xterm.js"},
			notParts:  []string{"***", "…"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := RedactLogLine(tc.line)
			for _, want := range tc.wantParts {
				if !strings.Contains(got, want) {
					t.Fatalf("RedactLogLine() = %q, want it to contain %q", got, want)
				}
			}
			for _, bad := range tc.notParts {
				if strings.Contains(got, bad) {
					t.Fatalf("RedactLogLine() = %q, want it to NOT contain %q", got, bad)
				}
			}
		})
	}
}
