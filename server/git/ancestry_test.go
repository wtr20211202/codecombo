package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestAheadBehindBetween 本地-远端对照的 behind 推算基元（P-20261004-34）：
// 对称差一次计量双向差集；对象不可见时 ok=false（诚实降级不当作 0 差集）
func TestAheadBehindBetween(t *testing.T) {
	dir := t.TempDir()
	run := func(args ...string) string {
		gitArgs := append([]string{
			"-c", "user.name=e2e", "-c", "user.email=e2e@test.local"}, args...)
		cmd := exec.Command("git", gitArgs...)
		cmd.Dir = dir // 显式锚定临时仓库（缺省 cwd 是测试进程目录）
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
		return strings.TrimSpace(string(out))
	}
	run("init")
	run("config", "core.autocrlf", "false")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("v1\n"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	run("add", ".")
	run("commit", "-m", "base")
	base := run("rev-parse", "HEAD")
	run("commit", "--allow-empty", "-m", "second")
	run("commit", "--allow-empty", "-m", "third")
	head := run("rev-parse", "HEAD")

	// base 在本地历史里：HEAD 比 base 多 2 个提交（remoteBehind 语义的一侧）
	aOnly, bOnly, ok := AheadBehindBetween(dir, "HEAD", base)
	if !ok || aOnly != 2 || bOnly != 0 {
		t.Fatalf("HEAD vs base: got aOnly=%d bOnly=%d ok=%v, want 2/0/true", aOnly, bOnly, ok)
	}

	// 同一引用：双向差集全零
	if aOnly, bOnly, ok = AheadBehindBetween(dir, "HEAD", head); !ok || aOnly != 0 || bOnly != 0 {
		t.Fatalf("HEAD vs HEAD: got %d/%d ok=%v, want 0/0/true", aOnly, bOnly, ok)
	}

	// 对象本地不存在（远端有本地未 fetch 的提交）：ok=false 诚实降级
	phantom := strings.Repeat("ab", 20)
	if aOnly, bOnly, ok = AheadBehindBetween(dir, "HEAD", phantom); ok {
		t.Fatalf("phantom ref: expected ok=false, got aOnly=%d bOnly=%d", aOnly, bOnly)
	}
}
