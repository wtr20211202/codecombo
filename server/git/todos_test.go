package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// ── 标记扫描测试（P-20261002-25）──
// 解析器单测：左锚定 path:line:col:content 对「content 含冒号」（TODO 注释
// 的常态）安全，通用解析器的最后冒号启发式在此错位；端到端走真实后端。

func TestParseMarkLines_ColonInContent(t *testing.T) {
	// rg --vimgrep / git grep -n --column 共同输出形状；content 含冒号、
	// 盘符状段、空 content 均不得错位
	out := strings.Join([]string{
		"main.go:3:1:// TODO: implement x",
		"src/a b.go:12:8:call(); // FIXME: see http://example.com",
		"readme.md:5:1:",
		"Binary file img matches",
		"broken-line",
		"x.go:notdigits:1:nope",
		"x.go:0:1:zero line nope",
	}, "\n")

	got := parseMarkLines(out, 0)
	if len(got) != 3 {
		t.Fatalf("matches = %+v, want 3", got)
	}
	m0 := got[0]
	if m0.Path != "main.go" || m0.Line != 3 || m0.Column != 1 || m0.Content != "// TODO: implement x" {
		t.Fatalf("m0 = %+v, want main.go:3:1 with full content", m0)
	}
	m1 := got[1]
	if m1.Path != "src/a b.go" || m1.Line != 12 || m1.Column != 8 ||
		m1.Content != "call(); // FIXME: see http://example.com" {
		t.Fatalf("m1 = %+v, want src/a b.go:12:8 with content colons intact", m1)
	}
	if got[2].Path != "readme.md" || got[2].Line != 5 || got[2].Content != "" {
		t.Fatalf("m2 = %+v, want readme.md:5 with empty content", got[2])
	}
}

func TestParseMarkLines_Limit(t *testing.T) {
	out := "a.go:1:1:one\nb.go:2:2:two\nc.go:3:3:three\n"
	got := parseMarkLines(out, 2)
	if len(got) != 2 || got[0].Path != "a.go" || got[1].Path != "b.go" {
		t.Fatalf("matches = %+v, want early-stop at 2", got)
	}
}

// TestSearchTodoMarks_Real 真机端到端：优先 rg，失败/缺失自动回退 git grep，
// 两种后端断言同一结果形状（整词+大小写敏感、未跟踪新文件纳入）
func TestSearchTodoMarks_Real(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	repo := initRepo(t)
	write := func(name, content string) {
		p := filepath.Join(repo, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("a.go", "package a\n\n// TODO: real one\n// todo lowercase\n// TODOS plural\n// FIXME: also real\n// simple hack word\n")
	write("sub/b.md", "XXX: doc note\nhack note lowercase in b\n")

	marks, err := SearchTodoMarks(repo, 100)
	if err != nil {
		t.Fatal(err)
	}
	byPath := map[string]int{}
	for _, m := range marks {
		if m.Line <= 0 {
			t.Fatalf("bad line: %+v", m)
		}
		byPath[m.Path]++
	}
	if byPath["a.go"] != 2 {
		t.Fatalf("a.go = %d marks (%+v), want 2 (TODO+FIXME)", byPath["a.go"], marks)
	}
	if byPath["sub/b.md"] != 1 {
		t.Fatalf("sub/b.md = %d marks (%+v), want 1 (XXX)", byPath["sub/b.md"], marks)
	}
	if len(marks) != 3 {
		t.Fatalf("total = %d (%+v), want 3（小写 todo/复数 TODOS/普通词 hack 不计入）", len(marks), marks)
	}
}
