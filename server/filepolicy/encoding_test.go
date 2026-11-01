package filepolicy

import (
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
)

// gbkBytes GBK 编码辅助
func gbkBytes(t *testing.T, s string) []byte {
	t.Helper()
	raw, err := simplifiedchinese.GB18030.NewEncoder().Bytes([]byte(s))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// TestDecodeDisplay_Mixed 混合编码文本逐行解码：UTF-8 行原样、GBK 行解码，
// 整段处理会把合法 UTF-8 部分错转（这是 DecodeDisplay 存在的理由）
func TestDecodeDisplay_Mixed(t *testing.T) {
	mixed := "diff --git a/a.go b/a.go\n" +
		string(gbkBytes(t, "+中文 GBK 行\n")) +
		"+UTF-8 中文行\n"
	got := DecodeDisplay(mixed)
	want := "diff --git a/a.go b/a.go\n+中文 GBK 行\n+UTF-8 中文行\n"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

// TestDecodeDisplay_UTF8Passthrough 合法 UTF-8 整段原样（含 BOM 等历史形态）
func TestDecodeDisplay_UTF8Passthrough(t *testing.T) {
	s := "纯 UTF-8 文本\n第二行 中文\n"
	if got := DecodeDisplay(s); got != s {
		t.Fatalf("got %q, want unchanged", got)
	}
}

// TestDecodeDisplay_GBKWhole 纯 GBK 多行文本整体还原
func TestDecodeDisplay_GBKWhole(t *testing.T) {
	s := DecodeDisplay(string(gbkBytes(t, "第一行中文\n第二行中文\n")))
	if s != "第一行中文\n第二行中文\n" {
		t.Fatalf("got %q", s)
	}
}

// TestDecodeText_Labels 标签判定回归
func TestDecodeText_Labels(t *testing.T) {
	if _, enc := DecodeText(gbkBytes(t, "中文内容")); enc != EncodingGBK {
		t.Fatalf("gbk label = %q", enc)
	}
	if _, enc := DecodeText([]byte("utf8 中文")); enc != "" {
		t.Fatalf("utf8 label = %q, want empty", enc)
	}
	le := []byte{0xFF, 0xFE, 0x2D, 0x4E} // BOM + U+4E2D（中）
	if text, enc := DecodeText(le); enc != EncodingUTF16LE || text != "中" {
		t.Fatalf("utf16le: %q / %q", text, enc)
	}
}
