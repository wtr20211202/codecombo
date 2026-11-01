package git

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// templateRepoFixture 建最小仓库并写入 commit.template 配置（值可空表示不配置）。
// 隔离 GIT_CONFIG_GLOBAL/SYSTEM/NOSYSTEM：commit.template 经 config --get 按
// system/global/local 合并读取，测试机全局配置若恰有该键会让「未配置」用例
// 偶发翻红——三个 env 全钉死到空文件/1 才是确定性夹具
func templateRepoFixture(t *testing.T, configValue string) string {
	t.Helper()
	empty := filepath.Join(t.TempDir(), "empty.config")
	if err := os.WriteFile(empty, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GIT_CONFIG_GLOBAL", empty)
	t.Setenv("GIT_CONFIG_SYSTEM", empty)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")

	repo := t.TempDir()
	if _, err := execGit(repo, "init", "-q"); err != nil {
		t.Fatalf("git init: %v", err)
	}
	if configValue != "" {
		if _, err := execGit(repo, "config", "commit.template", configValue); err != nil {
			t.Fatalf("git config: %v", err)
		}
	}
	return repo
}

// 未配置：返回空串（常态静默，非错误）
func TestGetCommitTemplateUnset(t *testing.T) {
	repo := templateRepoFixture(t, "")
	if got := GetCommitTemplate(repo); got != "" {
		t.Fatalf("want empty, got %q", got)
	}
}

// 配置为空串：同未配置
func TestGetCommitTemplateEmptyValue(t *testing.T) {
	repo := templateRepoFixture(t, " ")
	if got := GetCommitTemplate(repo); got != "" {
		t.Fatalf("want empty, got %q", got)
	}
}

// 仓库内相对路径（团队规范载体最常见形态：模板随仓库提交在根下）→ 读出内容
func TestGetCommitTemplateRepoRelative(t *testing.T) {
	repo := templateRepoFixture(t, ".gitmessage")
	tpl := filepath.Join(repo, ".gitmessage")
	content := "# type(scope): subject\n\n# body: why over what\n"
	if err := os.WriteFile(tpl, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := GetCommitTemplate(repo); got != content {
		t.Fatalf("want %q, got %q", content, got)
	}
}

// 相对路径 .. 穿越：拒绝读仓外文件，返回空串（防恶意仓库借模板探仓外内容）
func TestGetCommitTemplateRejectsTraversal(t *testing.T) {
	repo := templateRepoFixture(t, "../outside-secret.txt")
	secret := filepath.Join(filepath.Dir(repo), "outside-secret.txt")
	if err := os.WriteFile(secret, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := GetCommitTemplate(repo); got != "" {
		t.Fatalf("want empty (traversal rejected), got %q", got)
	}
}

// 指向的文件缺失：静默空串（不报错打断提交流程）
func TestGetCommitTemplateMissingFile(t *testing.T) {
	repo := templateRepoFixture(t, "no-such-template.txt")
	if got := GetCommitTemplate(repo); got != "" {
		t.Fatalf("want empty, got %q", got)
	}
}

// ~/ 前缀展开为当前用户 home（HOME/USERPROFILE 双设覆盖 win/unix 取法）
func TestGetCommitTemplateHomeExpansion(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	repo := templateRepoFixture(t, "~/.sc-commit-template")
	content := "home template body\n"
	if err := os.WriteFile(filepath.Join(home, ".sc-commit-template"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := GetCommitTemplate(repo); got != content {
		t.Fatalf("want %q, got %q", content, got)
	}
}

// 绝对路径直接使用（团队共享模板路径形态）
func TestGetCommitTemplateAbsolutePath(t *testing.T) {
	repo := templateRepoFixture(t, "")
	tpl := filepath.Join(t.TempDir(), "team-template.txt")
	content := "absolute team template\n"
	if err := os.WriteFile(tpl, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := execGit(repo, "config", "commit.template", tpl); err != nil {
		t.Fatal(err)
	}
	if got := GetCommitTemplate(repo); got != content {
		t.Fatalf("want %q, got %q", content, got)
	}
}

// 超限截断到 64KB 封顶（防误配置把大文件整读进响应）
func TestGetCommitTemplateTruncatesOversize(t *testing.T) {
	repo := templateRepoFixture(t, "big-template.txt")
	big := strings.Repeat("a", maxCommitTemplateBytes+1024)
	if err := os.WriteFile(filepath.Join(repo, "big-template.txt"), []byte(big), 0o644); err != nil {
		t.Fatal(err)
	}
	got := GetCommitTemplate(repo)
	if len(got) != maxCommitTemplateBytes {
		t.Fatalf("want truncated to %d bytes, got %d", maxCommitTemplateBytes, len(got))
	}
}

// 二进制内容（含 NUL 字节）不是合法模板：静默空串
func TestGetCommitTemplateSkipsBinary(t *testing.T) {
	repo := templateRepoFixture(t, "blob.bin")
	if err := os.WriteFile(filepath.Join(repo, "blob.bin"), []byte{'a', 0x00, 'b'}, 0o644); err != nil {
		t.Fatal(err)
	}
	if got := GetCommitTemplate(repo); got != "" {
		t.Fatalf("want empty (binary skipped), got %q", got)
	}
}
