package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// GetWorktreeNumstat 单测（P-20261003-219 变更树「复制变更摘要」数据面）：
// numstat 解析（含二进制与重命名两种路径形态）+ 真实 fixture 仓库全链
//（tracked 增删 + 未跟踪文本/二进制补计 + 未跟踪数量上限）。

func TestParseNumstatFiles(t *testing.T) {
	out := strings.Join([]string{
		"3\t1\tweb/src/a.ts",
		"-\t-\tassets/logo.png",
		"5\t0\told.txt => new.txt",
		"2\t2\tdir/{old.md => new.md}",
		"1\t1\tpre/{o.txt => n.txt}/post",
		"",
	}, "\n")
	files := parseNumstatFiles(out)
	if len(files) != 5 {
		t.Fatalf("条数 = %d, want 5", len(files))
	}
	if files[0].Path != "web/src/a.ts" || files[0].Additions != 3 || files[0].Deletions != 1 {
		t.Errorf("普通条目解析错: %+v", files[0])
	}
	if !files[1].Binary || files[1].Additions != 0 || files[1].Deletions != 0 {
		t.Errorf("二进制条目应记 Binary 不数行: %+v", files[1])
	}
	if files[2].Path != "new.txt" || files[2].Additions != 5 {
		t.Errorf("重命名条目应取 => 右侧新路径: %+v", files[2])
	}
	if files[3].Path != "dir/new.md" {
		t.Errorf("pre/{old => new} 形态应补回 pre 前缀: %+v", files[3])
	}
	if files[4].Path != "pre/n.txt/post" {
		t.Errorf("pre/{old => new}post 形态应补回前后缀: %+v", files[4])
	}
}

// numstatFixture 最小仓库：基线提交后 1 个文件改动（+2/-1）+ 未跟踪文本
// （3 行）与未跟踪二进制（首 8KB 含 NUL）各一
func newNumstatFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
			"GIT_TERMINAL_PROMPT=0")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(name)), []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	run("init")
	run("config", "core.autocrlf", "false") // 三平台行尾语义对齐（e2e 同款口径）
	run("config", "user.name", "t")
	run("config", "user.email", "t@t")
	write("tracked.txt", "l1\nl2\n")
	run("add", ".")
	run("commit", "-m", "base")
	write("tracked.txt", "l1\nl2x\nl3\nl4\n") // +2 -1
	write("untracked.txt", "a\nb\nc\n")       // +3（全文新增）
	write("untracked.bin", "PNG\x00data")     // 二进制不数行
	return dir
}

func TestGetWorktreeNumstat(t *testing.T) {
	dir := newNumstatFixture(t)
	files := GetWorktreeNumstat(dir)
	byPath := make(map[string]NumstatFile, len(files))
	for _, f := range files {
		byPath[f.Path] = f
	}
	tracked, ok := byPath["tracked.txt"]
	if !ok {
		t.Fatalf("tracked.txt 缺席: %+v", files)
	}
	if tracked.Additions != 3 || tracked.Deletions != 1 {
		t.Errorf("tracked.txt = +%d -%d, want +3 -1", tracked.Additions, tracked.Deletions)
	}
	ut, ok := byPath["untracked.txt"]
	if !ok {
		t.Fatalf("untracked.txt 缺席（untracked 不补计会让「N 文件 M 行」失真）: %+v", files)
	}
	if ut.Binary || ut.Additions != 3 || ut.Deletions != 0 {
		t.Errorf("untracked.txt = +%d -%d binary=%v, want +3 -0", ut.Additions, ut.Deletions, ut.Binary)
	}
	ub, ok := byPath["untracked.bin"]
	if !ok || !ub.Binary {
		t.Errorf("untracked.bin 应按二进制记 Binary: %+v", ub)
	}
}

// 空仓库（无 HEAD）不失败：tracked 空表、untracked 照常补计——「宁缺毋失败」
func TestGetWorktreeNumstatEmptyRepo(t *testing.T) {
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t",
			"GIT_TERMINAL_PROMPT=0")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init")
	run("config", "core.autocrlf", "false")
	if err := os.WriteFile(filepath.Join(dir, "only.txt"), []byte("x\ny\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	files := GetWorktreeNumstat(dir)
	if len(files) != 1 || files[0].Path != "only.txt" || files[0].Additions != 2 {
		t.Fatalf("空仓库应只余 untracked 补计: %+v", files)
	}
}

// 未跟踪补计上限：超出 numstatUntrackedMaxFiles 的文件不再计数（仍会在 status
// 清单里，只是不计行数）——防依赖目录漏 ignore 把点击取数拖成全盘扫描
func TestGetWorktreeNumstatUntrackedCap(t *testing.T) {
	dir := newNumstatFixture(t)
	if err := os.MkdirAll(filepath.Join(dir, "bulk"), 0o755); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < numstatUntrackedMaxFiles+5; i++ {
		name := filepath.Join(dir, filepath.FromSlash("bulk/f"+strconv.Itoa(i)+".txt"))
		if err := os.WriteFile(name, []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	files := GetWorktreeNumstat(dir)
	untrackedCount := 0
	for _, f := range files {
		if strings.HasPrefix(f.Path, "bulk/") {
			untrackedCount++
			if f.Additions != 1 {
				t.Errorf("计数档内的 untracked 应有行数: %+v", f)
			}
		}
	}
	if untrackedCount > numstatUntrackedMaxFiles {
		t.Errorf("untracked 补计 %d 超上限 %d", untrackedCount, numstatUntrackedMaxFiles)
	}
}
