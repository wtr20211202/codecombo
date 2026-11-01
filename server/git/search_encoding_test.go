package git

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"

	"codecombo/server/filepolicy"
)

// TestSearchNonUTF8Supplement GBK 文件中文补扫：字节级主通道命不中的内容
// 在解码空间命中，行号/列号为解码空间语义
func TestSearchNonUTF8Supplement(t *testing.T) {
	dir := t.TempDir() // 非 git 目录：走 WalkDir 回退路径
	gbkText := "第一行：端口配置\n第二行：数据库密码\n"
	raw, err := simplifiedchinese.GB18030.NewEncoder().Bytes([]byte(gbkText))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.txt"), raw, 0644); err != nil {
		t.Fatal(err)
	}
	// 合法 UTF-8 文件必须跳过（主通道已覆盖，避免重复结果）
	if err := os.WriteFile(filepath.Join(dir, "utf8.txt"), []byte("数据库在 UTF-8 文件里\n"), 0644); err != nil {
		t.Fatal(err)
	}
	// 二进制扩展名跳过
	if err := os.WriteFile(filepath.Join(dir, "blob.png"), raw, 0644); err != nil {
		t.Fatal(err)
	}

	matches, err := searchNonUTF8Supplement(dir, "数据库", SearchOptions{MaxResults: 50}, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 1 {
		t.Fatalf("matches = %d, want 1（只命中 GBK 文件）", len(matches))
	}
	m := matches[0]
	if m.Path != "config.txt" || m.Line != 2 || m.Column != 5 {
		t.Fatalf("match = %+v", m)
	}
	if !strings.Contains(m.Content, "第二行：数据库密码") {
		t.Fatalf("content = %q", m.Content)
	}
}

// TestSearchNonUTF8Supplement_ASCIIQuerySkipped 纯 ASCII 查询无需补扫
// （字节级匹配已覆盖所有编码）——这里直接断言 guard 函数
func TestSearchNonUTF8Supplement_ASCIIQuerySkipped(t *testing.T) {
	if hasNonASCII("port 8080") {
		t.Fatal("ascii query must not be flagged")
	}
	if !hasNonASCII("数据库") {
		t.Fatal("chinese query must be flagged")
	}
}

// TestConflictContentEncodingRoundTrip 冲突内容读取解码 + 按原编码写回：
// 解决冲突不再把 GBK 文件转成 UTF-8
func TestConflictContentEncodingRoundTrip(t *testing.T) {
	dir := t.TempDir()
	gbkBody := "<<<<<<< HEAD\n ours 中文\n=======\n theirs 中文\n>>>>>>> branch\n"
	raw, err := simplifiedchinese.GB18030.NewEncoder().Bytes([]byte(gbkBody))
	if err != nil {
		t.Fatal(err)
	}
	conflictFile := filepath.Join(dir, "f.txt")
	if err := os.WriteFile(conflictFile, raw, 0644); err != nil {
		t.Fatal(err)
	}

	cc, err := GetConflictContent(dir, "f.txt")
	if err != nil {
		t.Fatal(err)
	}
	if cc.Encoding != filepolicy.EncodingGBK {
		t.Fatalf("encoding = %q, want gbk", cc.Encoding)
	}
	if !strings.Contains(cc.Content, "<<<<<<< HEAD") || !strings.Contains(cc.Content, "ours 中文") {
		t.Fatalf("content = %q（冲突标记与正文都应可读）", cc.Content)
	}
	if cc.Hash == "" {
		t.Fatal("hash = empty, want sha256 hex of disk bytes")
	}

	// 用户解决冲突写回：原编码落盘
	if err := ResolveConflictWithContent(dir, "f.txt", "resolved 中文\n", cc.Encoding, ""); err != nil {
		t.Fatal(err)
	}
	onDisk, err := os.ReadFile(conflictFile)
	if err != nil {
		t.Fatal(err)
	}
	want, err := simplifiedchinese.GB18030.NewEncoder().Bytes([]byte("resolved 中文\n"))
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != string(want) {
		t.Fatalf("disk = %q, want GBK bytes", onDisk)
	}
}
