package watch

import (
	"path/filepath"
	"testing"
)

// 生效断言：构建产物/依赖目录必须在监听排除清单内（这些目录的事件风暴
// 是多大型项目场景的主要 inotify 与广播开销来源）
func TestSkipDirs_CoversBuildArtifacts(t *testing.T) {
	for _, dir := range []string{"target", "vendor", "bin", "build", "out", ".next", ".nuxt", "__pycache__", ".gradle", "node_modules", ".git"} {
		if !skipDirs[dir] {
			t.Errorf("skipDirs missing %q", dir)
		}
	}
}

func TestIndex_AddRemoveEntry(t *testing.T) {
	rw := &RepoWatcher{}
	rw.addIndexEntry("p1", `D:\work\proj1`)
	rw.addIndexEntry("p2", `D:\work\proj2`)

	if got := rw.findProjectID(filepath.Join(`D:\work\proj1`, "src", "a.go")); got != "p1" {
		t.Fatalf("findProjectID proj1 = %q", got)
	}

	// 重复添加幂等
	rw.addIndexEntry("p1", `D:\work\proj1`)
	rw.projMu.RLock()
	n := len(rw.projIdx)
	rw.projMu.RUnlock()
	if n != 2 {
		t.Fatalf("index size after duplicate add = %d, want 2", n)
	}

	rw.removeIndexEntry("p1")
	if got := rw.findProjectID(filepath.Join(`D:\work\proj1`, "src", "a.go")); got != "" {
		t.Fatalf("after remove, findProjectID = %q, want empty", got)
	}
	if got := rw.findProjectID(filepath.Join(`D:\work\proj2`, "main.go")); got != "p2" {
		t.Fatalf("other project should be untouched, got %q", got)
	}
}

// 生效断言：运行期 TrackProject 后事件能关联到项目（修复"启动后添加的项目
// 永远不被监听"缺陷的索引侧验证）
func TestTrackProject_IndexVisibleAfterRuntimeAdd(t *testing.T) {
	rw := &RepoWatcher{}
	if got := rw.findProjectID(filepath.Join(`D:\late\proj`, "x.ts")); got != "" {
		t.Fatalf("pre-track lookup should be empty, got %q", got)
	}
	_ = rw.TrackProject("late", `D:\late\proj`)
	if got := rw.findProjectID(filepath.Join(`D:\late\proj`, "x.ts")); got != "late" {
		t.Fatalf("post-track lookup = %q, want late", got)
	}
	rw.UntrackProject("late", `D:\late\proj`)
	if got := rw.findProjectID(filepath.Join(`D:\late\proj`, "x.ts")); got != "" {
		t.Fatalf("post-untrack lookup = %q, want empty", got)
	}
}

// 嵌套项目最长前缀归属（P-20261005-170 e2e 实败②）：仓库根作项目 + 仓库内
// 临时目录也注册成项目时，子树事件必须归最具体的内层项目——「索引序首个前缀
// 命中即返回」让后建的内层项目永远拿不到自己子树的事件（归因账整账落空），
// 且归属随建序漂移。同函数顺带钉前缀边界：兄弟同前缀目录不互串
func TestFindProjectID_LongestPrefixWins(t *testing.T) {
	idx := []projIndex{
		{id: "outer", path: "D:/work/repo", len: len("D:/work/repo")},
		{id: "inner", path: "D:/work/repo/.sc-tmp/probe", len: len("D:/work/repo/.sc-tmp/probe")},
	}
	// 内层子树归内层（先序命中 outer 也不行）
	if got := findProjectIDFast("D:/work/repo/.sc-tmp/probe/a.txt", idx); got != "inner" {
		t.Fatalf("nested file = %q, want inner", got)
	}
	// 内层根自身事件同归内层
	if got := findProjectIDFast("D:/work/repo/.sc-tmp/probe", idx); got != "inner" {
		t.Fatalf("nested root = %q, want inner", got)
	}
	// 外层其余子树归外层
	if got := findProjectIDFast("D:/work/repo/src/a.go", idx); got != "outer" {
		t.Fatalf("outer file = %q, want outer", got)
	}
	// 前缀边界：兄弟目录（repo-x）不归 repo
	if got := findProjectIDFast("D:/work/repo-x/a.go", idx); got != "" {
		t.Fatalf("sibling dir = %q, want empty", got)
	}
	if got := findProjectIDFast("D:/work/repo/.sc-tmp/probe-x/a.go", idx); got != "outer" {
		t.Fatalf("sibling of inner = %q, want outer", got)
	}
	// 索引序无关性：内外层倒序装配结果不变
	reversed := []projIndex{idx[1], idx[0]}
	if got := findProjectIDFast("D:/work/repo/.sc-tmp/probe/a.txt", reversed); got != "inner" {
		t.Fatalf("reversed index nested file = %q, want inner", got)
	}
}
