package git

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// blameRefFixture 两提交线性仓库：a.txt 先经 c1 写入两行，c2 改写首行并追加
// 一行——工作树形态的 blame 首尾段 hash 不同，按 c1 blame 则整文件同 hash
func blameRefFixture(t *testing.T) (repo, c1 string) {
	t.Helper()
	repo = t.TempDir()
	must := func(args ...string) string {
		out, err := execGit(repo, args...)
		if err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
		return out
	}
	must("init", "-q")
	must("config", "user.email", "t@t")
	must("config", "user.name", "t")

	write := func(content string) {
		if err := os.WriteFile(filepath.Join(repo, "a.txt"), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	write("old-one\nsecond\n")
	must("add", ".")
	must("commit", "-q", "-m", "c1")
	c1 = strings.TrimSpace(must("rev-parse", "HEAD"))

	write("new-one\nsecond\nthird\n")
	must("add", ".")
	must("commit", "-q", "-m", "c2")
	return repo, c1
}

// 缺省（ref=""）：工作树当前态，首行 hash 为 c2、末行为 c1（行为不变）
func TestGetBlameDefaultUnchanged(t *testing.T) {
	repo, c1 := blameRefFixture(t)
	c2 := strings.TrimSpace(func() string {
		out, err := execGit(repo, "rev-parse", "HEAD")
		if err != nil {
			t.Fatal(err)
		}
		return out
	}())

	lines, err := GetBlame(repo, "a.txt", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 3 {
		t.Fatalf("want 3 blame lines, got %d", len(lines))
	}
	if lines[0].Hash != c2[:8] {
		t.Fatalf("first line hash = %q, want c2 %q", lines[0].Hash, c2[:8])
	}
	// 未变更的中间行（"second"）仍归属 c1，新追加的末行归属 c2
	if lines[1].Hash != c1[:8] {
		t.Fatalf("unchanged line hash = %q, want c1 %q", lines[1].Hash, c1[:8])
	}
	if lines[2].Hash != c2[:8] {
		t.Fatalf("appended line hash = %q, want c2 %q", lines[2].Hash, c2[:8])
	}
}

// ref 直通：按 c1 blame，整文件（c1 时刻只有两行）hash 均为 c1
func TestGetBlameWithRef(t *testing.T) {
	repo, c1 := blameRefFixture(t)

	lines, err := GetBlame(repo, "a.txt", c1)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 2 {
		t.Fatalf("want 2 blame lines at c1, got %d", len(lines))
	}
	for _, l := range lines {
		if l.Hash != c1[:8] {
			t.Fatalf("line %d hash = %q, want c1 %q", l.LineNo, l.Hash, c1[:8])
		}
	}
}

// ref 直通支持 commit-ish 后缀（X^ 上一版考古的前端路径：8 位短 hash + ^）
func TestGetBlameWithParentRef(t *testing.T) {
	repo, c1 := blameRefFixture(t)

	lines, err := GetBlame(repo, "a.txt", "HEAD^")
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 2 || lines[0].Hash != c1[:8] {
		t.Fatalf("HEAD^ blame: %d lines, first hash %q, want 2 lines at c1 %q",
			len(lines), lines[0].Hash, c1[:8])
	}
}

// 以 "-" 开头的 ref 是选项注入面（A6）：拒绝执行
func TestGetBlameRejectsOptionLikeRef(t *testing.T) {
	repo, _ := blameRefFixture(t)

	if _, err := GetBlame(repo, "a.txt", "--version"); err == nil {
		t.Fatal("option-like ref should be rejected")
	}
}

// parseBlame：以 c/f/p/b 开头的提交 hash 不得被当成元数据吞掉
// （首字符与 committer/filename/previous/boundary 同域，曾整段丢 hash）
func TestParseBlameKeepsHashWithMetaPrefixChars(t *testing.T) {
	const por = `cccc111122223333444455556666777788889999 1 1 1
author Alice
author-time 1700000000
summary c-seg
filename a.txt
	cont-c
ffff222233334444555566667777888899990000 1 2 1
author Bob
summary f-seg
boundary
	cont-f
`
	lines := parseBlame(por)
	if len(lines) != 2 {
		t.Fatalf("want 2 lines, got %d", len(lines))
	}
	if lines[0].Hash != "cccc1111" {
		t.Fatalf("c-prefixed hash lost: %q", lines[0].Hash)
	}
	if lines[1].Hash != "ffff2222" {
		t.Fatalf("f-prefixed hash lost: %q", lines[1].Hash)
	}
	if lines[1].Content != "cont-f" {
		t.Fatalf("content = %q, want cont-f", lines[1].Content)
	}
}
