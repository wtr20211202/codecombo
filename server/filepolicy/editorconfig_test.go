package filepolicy

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseEditorConfig(t *testing.T) {
	content := "# 顶层注释\n" +
		"; 分号注释也认\r\n" +
		"root = true\r\n" +
		"\r\n" +
		"[*.go]\r\n" +
		"indent_style = tab\r\n" +
		"tab_width : 8\r\n" + // 冒号分隔同样合法（INI 子集）
		"charset = utf-8\n" + // 子集外键：解析接受，生效面忽略
		"indent_style = tab\r" // 同节重复键：后者胜（值相同，验证不炸）
	f := ParseEditorConfig(content)
	if !f.root {
		t.Fatalf("root = false, want true")
	}
	if len(f.sections) != 1 {
		t.Fatalf("sections = %d, want 1", len(f.sections))
	}
	if f.globals["charset"] != "" {
		t.Fatalf("顶层 charset 不应落 globals")
	}
	if f.sections[0].selector != "*.go" {
		t.Fatalf("selector = %q, want *.go", f.sections[0].selector)
	}
	if f.sections[0].props["tab_width"] != "8" {
		t.Fatalf("tab_width = %q, want 8（冒号分隔）", f.sections[0].props["tab_width"])
	}
}

func TestParseEditorConfigColonValueAndCommentOnly(t *testing.T) {
	f := ParseEditorConfig("just a line without kv\n[unterminated\n")
	if len(f.sections) != 0 || len(f.globals) != 0 {
		t.Fatalf("坏行应静默跳过: globals=%v sections=%v", f.globals, f.sections)
	}
}

func TestMatchSectionTwoTiers(t *testing.T) {
	cases := []struct {
		selector string
		relPath  string
		want     bool
	}{
		{"*", "anything.txt", true},
		{"*", "deep/dir/file.go", true},
		{"**", "x.go", true},
		{"*.go", "main.go", true},
		{"*.go", "pkg/deep/main.go", true}, // 后缀档不分层
		{"*.go", "main.gopher", false},     // 后缀必须整段命中
		{"*.go", "go", false},
		{"**.test.ts", "src/a/b.test.ts", true},
		{"**/Makefile", "tools/gen/Makefile", true},
		{"Makefile", "Makefile", true},      // 精确档：相对路径全等
		{"Makefile", "sub/Makefile", false}, // 精确档不跨层（跨层请写 **/Makefile）
		{"a?.txt", "ab.txt", false},         // 复杂模式整节忽略（降级默认节）
		{"a[0-9].txt", "a1.txt", false},
		{"*.{md,txt}", "a.md", false},
		{"src/*.go", "src/a.go", false}, // 含路径分隔不在两档内
	}
	for _, c := range cases {
		if got := matchSection(c.selector, c.relPath); got != c.want {
			t.Errorf("matchSection(%q, %q) = %v, want %v", c.selector, c.relPath, got, c.want)
		}
	}
}

func TestEffectiveEditorConfigOverlay(t *testing.T) {
	// 顶层打底 + 命中节按文件顺序覆盖（后者胜）
	f := ParseEditorConfig(
		"root = true\n" +
			"indent_style = space\n" +
			"indent_size = 2\n" +
			"[*.md]\n" +
			"indent_size = 4\n" +
			"[*.go]\n" +
			"indent_style = tab\n" +
			"tab_width = 8\n" +
			"[*]\n" + // 后置 [*] 命中一切，但未重申各键 → 不覆盖前节已定值
			"end_of_line = lf\n")
	if got := EffectiveEditorConfig(f, "main.go"); got != (EditorConfig{IndentStyle: "tab", IndentSize: 2, TabWidth: 8, EndOfLine: "lf"}) {
		t.Fatalf("main.go = %+v", got)
	}
	if got := EffectiveEditorConfig(f, "README.md"); got != (EditorConfig{IndentStyle: "space", IndentSize: 4, EndOfLine: "lf"}) {
		t.Fatalf("README.md = %+v", got)
	}
	if got := EffectiveEditorConfig(f, "app.js"); got != (EditorConfig{IndentStyle: "space", IndentSize: 2, EndOfLine: "lf"}) {
		t.Fatalf("app.js = %+v", got)
	}
}

func TestEffectiveEditorConfigIndentSizeTab(t *testing.T) {
	// indent_size=tab：规范关键字语义 = 沿用 tab_width
	f := ParseEditorConfig("[*]\nindent_style = tab\nindent_size = tab\ntab_width = 3\n")
	if got := EffectiveEditorConfig(f, "x.go"); got != (EditorConfig{IndentStyle: "tab", TabWidth: 3}) {
		t.Fatalf("indent_size=tab 且有 tab_width = %+v, want IndentSize 缺省/TabWidth 3", got)
	}
	f2 := ParseEditorConfig("[*]\nindent_size = tab\n")
	if got := EffectiveEditorConfig(f2, "x.go"); got != (EditorConfig{}) {
		t.Fatalf("indent_size=tab 无 tab_width = %+v, want 全缺省", got)
	}
}

func TestEffectiveEditorConfigInvalidValuesIgnored(t *testing.T) {
	f := ParseEditorConfig("[*]\n" +
		"indent_style = spaces\n" + // 未知枚举 → 不落键
		"indent_size = 0\n" + // 越界 → 不落键
		"tab_width = 101\n" + // 越界上界 → 不落键
		"indent_size = abc\n" + // 非法 → 不落键
		"end_of_line = auto\n") // 未知枚举 → 不落键
	if got := EffectiveEditorConfig(f, "x.txt"); got != (EditorConfig{}) {
		t.Fatalf("非法值应全部按未约定处理 = %+v", got)
	}
}

func TestEffectiveEditorConfigNil(t *testing.T) {
	if got := EffectiveEditorConfig(nil, "x.txt"); got != (EditorConfig{}) {
		t.Fatalf("nil 文件 = %+v, want 零值", got)
	}
}

func TestEditorConfigFor(t *testing.T) {
	root := t.TempDir()
	if _, ok := EditorConfigFor(root, "a.go"); ok {
		t.Fatalf("无 .editorconfig 应 found=false")
	}
	if _, ok := EditorConfigFor("", "a.go"); ok {
		t.Fatalf("空根应 found=false")
	}
	// 目录形态同名文件：按无配置处理
	if err := os.MkdirAll(filepath.Join(root, ".editorconfig"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, ok := EditorConfigFor(root, "a.go"); ok {
		t.Fatalf(".editorconfig 为目录应 found=false")
	}
	if err := os.RemoveAll(filepath.Join(root, ".editorconfig")); err != nil {
		t.Fatal(err)
	}

	content := "root = true\n[*.go]\nindent_style = tab\ntab_width = 8\n"
	if err := os.WriteFile(filepath.Join(root, ".editorconfig"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	ec, ok := EditorConfigFor(root, "pkg/main.go")
	if !ok || ec != (EditorConfig{IndentStyle: "tab", TabWidth: 8}) {
		t.Fatalf("EditorConfigFor = %+v ok=%v", ec, ok)
	}

	// 反斜杠相对路径（Windows 调用方形态）归一后同键命中
	if ec, _ := EditorConfigFor(root, `pkg\main.go`); ec != (EditorConfig{IndentStyle: "tab", TabWidth: 8}) {
		t.Fatalf("反斜杠归一 = %+v", ec)
	}

	// 空文件：按无配置处理（无有效约定可下发，与缺失同语义）
	if err := os.WriteFile(filepath.Join(root, ".editorconfig"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := EditorConfigFor(root, "a.go"); ok {
		t.Fatalf("空文件应 found=false")
	}

	// 超限：按无配置处理（防同名超大文件拖慢打开链）
	if err := os.WriteFile(filepath.Join(root, ".editorconfig"), make([]byte, editorconfigMaxBytes+1), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := EditorConfigFor(root, "a.go"); ok {
		t.Fatalf("超限文件应 found=false")
	}
}
