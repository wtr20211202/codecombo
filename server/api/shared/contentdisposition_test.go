package shared

import (
	"strings"
	"testing"
)

// ContentDispositionFile 三态契约（P-20261003-109）：注入串剥离 / 中文 RFC 5987
// / ASCII 兼容（与历史手拼端点输出逐字节一致）。其余边界（参数分隔符转义、
// 空名回退）一并钉住，防后续「优化」回退成 url.PathEscape 旧隐患
func TestContentDispositionFile(t *testing.T) {
	t.Run("ASCII 名输出与历史手拼端点逐字节兼容", func(t *testing.T) {
		got := ContentDispositionFile("hello.txt")
		// 既有 files/download.go、files/archive.go、gitops/patch.go、
		// remote/remotehost_{files,zip}.go 切换前的 ASCII 输出原样
		want := `attachment; filename="hello.txt"; filename*=UTF-8''hello.txt`
		if got != want {
			t.Fatalf("ContentDispositionFile(hello.txt) = %q, want %q", got, want)
		}
	})

	t.Run("中文名走 RFC 5987 filename* 百分号编码", func(t *testing.T) {
		got := ContentDispositionFile("报告.txt")
		want := `attachment; filename="__.txt"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.txt`
		if got != want {
			t.Fatalf("ContentDispositionFile(报告.txt) = %q, want %q", got, want)
		}
		// 兜底与扩展值都不残留原始多字节（quoted-string 是 Latin-1 语义，
		// 原始 UTF-8 进兜底正是历史乱码面）
		for _, r := range got {
			if r > 0x7f {
				t.Fatalf("non-ASCII rune %q leaked into header value: %q", r, got)
			}
		}
	})

	t.Run("CRLF 响应头注入被剥除", func(t *testing.T) {
		got := ContentDispositionFile("a\r\nX-Injected: 1\r\nb.txt")
		if strings.ContainsAny(got, "\r\n") {
			t.Fatalf("CRLF survived sanitization: %q", got)
		}
		// 剥除后整体仍是单个合法头值（残留正文只是文件名的一部分）
		if !strings.HasPrefix(got, "attachment") {
			t.Fatalf("value = %q, want attachment prefix", got)
		}
	})

	t.Run("引号与反斜杠剥除（quoted-string 破坏面）", func(t *testing.T) {
		got := ContentDispositionFile(`evil"name\path.txt`)
		// 双形式的结构性引号恰为兜底值两侧一对；反斜杠无结构位，必须零残留
		if n := strings.Count(got, `"`); n != 2 {
			t.Fatalf("quote count = %d (want exactly 2 delimiters), value = %q", n, got)
		}
		if strings.Contains(got, `\`) {
			t.Fatalf("backslash survived sanitization: %q", got)
		}
		if !strings.Contains(got, `filename="evilnamepath.txt"`) {
			t.Fatalf("value = %q, want folded fallback", got)
		}
	})

	t.Run("参数分隔符在 filename* 中被转义（PathEscape 旧隐患收口）", func(t *testing.T) {
		got := ContentDispositionFile("a;b=c,d.txt")
		// url.PathEscape 会放过 ;=,，直接拼会把头参数拆散；helper 必须逐字节转义
		if !strings.Contains(got, `filename*=UTF-8''a%3Bb%3Dc%2Cd.txt`) {
			t.Fatalf("value = %q, want percent-encoded delimiters", got)
		}
		// 兜底在 quoted-string 内合法保留分隔符（可读性优先，解码方取 filename*）
		if !strings.Contains(got, `filename="a;b=c,d.txt"`) {
			t.Fatalf("value = %q, want quoted fallback", got)
		}
	})

	t.Run("空格与百分号转义", func(t *testing.T) {
		got := ContentDispositionFile("a b%c.txt")
		if !strings.Contains(got, `filename*=UTF-8''a%20b%25c.txt`) {
			t.Fatalf("value = %q, want space/percent encoded", got)
		}
	})

	t.Run("全净空名回退裸 attachment", func(t *testing.T) {
		got := ContentDispositionFile("\r\n\r\n")
		if got != "attachment" {
			t.Fatalf("value = %q, want bare attachment", got)
		}
	})
}
