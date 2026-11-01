package git

import (
	"strings"
	"testing"
)

func TestRedactCredentials(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "user:password 形态",
			in:   "fatal: unable to access 'https://user:ghp_abc123@github.com/o/r.git/': denied",
			want: "fatal: unable to access 'https://***@github.com/o/r.git/': denied",
		},
		{
			name: "token 即用户名形态",
			in:   "remote: https://x-access-token:abc@host/repo pushed",
			want: "remote: https://***@host/repo pushed",
		},
		{
			name: "纯用户名（token@host）",
			in:   "error: https://mytoken@git.example.com/repo.git not found",
			want: "error: https://***@git.example.com/repo.git not found",
		},
		{
			name: "scp-like 不动（无 http 协议前缀）",
			in:   "ssh: git@github.com:o/r.git permission denied",
			want: "ssh: git@github.com:o/r.git permission denied",
		},
		{
			name: "路径里的 @ 不误伤（/ 阻断 userinfo）",
			in:   "https://github.com/o/repo@v1.0.git failed",
			want: "https://github.com/o/repo@v1.0.git failed",
		},
		{
			name: "无 URL 纯文本原样",
			in:   "fatal: index.lock exists",
			want: "fatal: index.lock exists",
		},
		{
			name: "空串",
			in:   "",
			want: "",
		},
		{
			name: "多匹配全部脱敏",
			in:   "https://a:b@h1/x and https://c:d@h2/y",
			want: "https://***@h1/x and https://***@h2/y",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := RedactCredentials(tc.in); got != tc.want {
				t.Fatalf("RedactCredentials(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestExecGitErrorRedacted 端到端：git 失败返回的错误串不含凭据。
// 用一个必然失败且 stderr 可控的命令验证脱敏在真实链路生效
func TestExecGitErrorRedacted(t *testing.T) {
	_, err := execGit(t.TempDir(), "fetch", "https://user:secret123@invalid.invalid/r.git")
	if err == nil {
		t.Fatal("expect error")
	}
	if strings.Contains(err.Error(), "secret123") {
		t.Fatalf("error leaked credentials: %q", err.Error())
	}
}
