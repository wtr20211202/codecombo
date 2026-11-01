package git

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 合并预演（P-20261005-174）：merge-tree --write-tree 输出解析钉死 + 三形态
//（冲突/干净/删除-修改）端到端 + 版本护栏一致性。仓库夹具复用同包
// branch_tracking_batch_test.go 的 runGit/writeFile 帮手

// initMergeRepo 造一个 main + feature 分叉仓库：conflict.txt 双方同改（内容冲突）、
// del.txt feature 侧删除 main 侧修改（删除-修改）、extra.txt feature 侧独有新增
// （干净并入）
func initMergeRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	runGit(t, dir, "init", "-q", "-b", "main")
	runGit(t, dir, "config", "core.autocrlf", "false")
	write := func(name, content string) {
		if err := writeFile(filepath.Join(dir, name), content); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	write("conflict.txt", "base\n")
	write("del.txt", "a\nb\n")
	write("keep.txt", "untouched\n")
	runGit(t, dir, "add", "-A")
	runGit(t, dir, "commit", "-qm", "base")

	runGit(t, dir, "checkout", "-qb", "feature")
	write("conflict.txt", "base\nfeature side\n")
	if err := os.Remove(filepath.Join(dir, "del.txt")); err != nil {
		t.Fatalf("remove del.txt: %v", err)
	}
	write("extra.txt", "extra\n")
	runGit(t, dir, "add", "-A")
	runGit(t, dir, "commit", "-qm", "feature")

	runGit(t, dir, "checkout", "-q", "main")
	write("conflict.txt", "base\nmain side\n")
	write("del.txt", "a\nb\nmain edit\n")
	runGit(t, dir, "add", "-A")
	runGit(t, dir, "commit", "-qm", "main")
	return dir
}

func TestMergePreviewConflict(t *testing.T) {
	dir := initMergeRepo(t)
	res, err := MergePreview(dir, "feature")
	if err != nil {
		t.Fatalf("MergePreview: %v", err)
	}
	if res.Clean {
		t.Fatal("expected conflicted preview")
	}
	if res.TreeOID == "" {
		t.Fatal("treeOid must be present even on conflict")
	}
	byPath := map[string]MergePreviewConflictFile{}
	for _, cf := range res.Conflicts {
		byPath[cf.Path] = cf
	}
	if len(res.Conflicts) != 2 {
		t.Fatalf("expected 2 conflicted files (conflict.txt + del.txt), got %v", res.Conflicts)
	}
	content := byPath["conflict.txt"]
	if content.Status != "both-modified" {
		t.Errorf("conflict.txt status = %q, want both-modified", content.Status)
	}
	if content.HunkCount != 1 {
		t.Errorf("conflict.txt hunkCount = %d, want 1", content.HunkCount)
	}
	if !strings.Contains(content.Ours, "main side") || !strings.Contains(content.Theirs, "feature side") {
		t.Errorf("hunk preview wrong: ours=%q theirs=%q", content.Ours, content.Theirs)
	}
	del := byPath["del.txt"]
	if del.Status != "deleted-by-them" {
		t.Errorf("del.txt status = %q, want deleted-by-them (deleted in source)", del.Status)
	}
	if del.HunkCount != 0 || del.Ours != "" || del.Theirs != "" {
		t.Errorf("modify/delete must carry no section summary, got %+v", del)
	}
	// 干净计数：合成面变更里 conflict.txt 带标记入 diff、del.txt 双方一致不入、
	// extra.txt 干净并入 → cleanCount = 1
	if res.CleanCount != 1 {
		t.Errorf("cleanCount = %d, want 1", res.CleanCount)
	}
	// 工作区零副作用：预演不动 main 侧文件、不产 status 脏面
	if _, err := os.Stat(filepath.Join(dir, "del.txt")); err != nil {
		t.Fatalf("worktree must be untouched by preview: %v", err)
	}
	if out, err := execGit(dir, "status", "--porcelain"); err != nil || strings.TrimSpace(out) != "" {
		t.Fatalf("worktree dirty after preview: %q err=%v", out, err)
	}
}

func TestMergePreviewClean(t *testing.T) {
	dir := initMergeRepo(t)
	// 干净分支：从 main 另起只追加独立变更的侧支，预演视角回到 main
	runGit(t, dir, "checkout", "-qb", "cleanfeat")
	if err := writeFile(filepath.Join(dir, "clean.txt"), "c1\nc2\n"); err != nil {
		t.Fatalf("write clean.txt: %v", err)
	}
	runGit(t, dir, "add", "-A")
	runGit(t, dir, "commit", "-qm", "clean")
	runGit(t, dir, "checkout", "-q", "main")

	res, err := MergePreview(dir, "cleanfeat")
	if err != nil {
		t.Fatalf("MergePreview: %v", err)
	}
	if !res.Clean {
		t.Fatalf("expected clean preview, got conflicts %v", res.Conflicts)
	}
	if len(res.Conflicts) != 0 {
		t.Fatalf("clean preview must carry empty conflict array, got %v", res.Conflicts)
	}
	if res.Stat == nil {
		t.Fatal("clean preview must carry stat")
	}
	if res.Stat.Files != 1 || res.Stat.Insertions != 2 || res.Stat.Deletions != 0 {
		t.Errorf("stat = %+v, want 1 file +2/-0", res.Stat)
	}
	if res.CleanCount != 1 {
		t.Errorf("cleanCount = %d, want 1", res.CleanCount)
	}
}

func TestMergePreviewAlreadyContains(t *testing.T) {
	dir := initMergeRepo(t)
	// source 已包含在 HEAD（落后分支）：合成面零变更，预演绿态零 stat
	res, err := MergePreview(dir, "main~1")
	if err != nil {
		t.Fatalf("MergePreview: %v", err)
	}
	if !res.Clean {
		t.Fatalf("expected clean preview for ancestor ref, got %v", res.Conflicts)
	}
	if res.Stat == nil || res.Stat.Files != 0 {
		t.Errorf("ancestor ref stat = %+v, want 0 files", res.Stat)
	}
}

func TestMergePreviewRejectsOptionLikeRef(t *testing.T) {
	dir := initMergeRepo(t)
	if _, err := MergePreview(dir, "--all"); err == nil {
		t.Fatal("option-like ref must be rejected (validateRef)")
	}
}

func TestParseMergeTreeEntries(t *testing.T) {
	out := strings.Join([]string{
		"5a1f..tree..oid",
		"100644 aaa111 1\tconflict.txt",
		"100644 bbb222 2\tconflict.txt",
		"100644 ccc333 3\tconflict.txt",
		"100755 ddd444 1\tdir with space/del.txt",
		"100755 eee555 2\tdir with space/del.txt",
		"", // 段间分隔
		"1", "conflict.txt", "CONFLICT (contents)", "CONFLICT (content): ...",
	}, "\x00") + "\x00"

	treeOid, entries := parseMergeTreeEntries(out)
	if treeOid != "5a1f..tree..oid" {
		t.Errorf("treeOid = %q", treeOid)
	}
	if len(entries) != 5 {
		t.Fatalf("entries = %d, want 5（informational 段必须止步于分隔符）", len(entries))
	}
	if entries[2].stage != 3 || entries[2].path != "conflict.txt" || entries[2].blob != "ccc333" {
		t.Errorf("entry[2] = %+v", entries[2])
	}
	if entries[4].path != "dir with space/del.txt" || entries[4].mode != "100755" {
		t.Errorf("entry[4] = %+v（含空格路径不得被拆散）", entries[4])
	}
}

func TestParseMergeTreeEntriesCleanOutput(t *testing.T) {
	// 干净形态：只有 tree oid 一个 NUL 结尾字段
	treeOid, entries := parseMergeTreeEntries("abc123\x00")
	if treeOid != "abc123" || len(entries) != 0 {
		t.Errorf("clean parse = %q, %d entries", treeOid, len(entries))
	}
	// 异常行跳过不 panic
	treeOid, entries = parseMergeTreeEntries("abc123\x00garbage-no-tab\x00100644 x\x00")
	if treeOid != "abc123" || len(entries) != 0 {
		t.Errorf("garbage-tolerant parse = %q, %d entries", treeOid, len(entries))
	}
}

func TestConflictStatusFromStages(t *testing.T) {
	cases := []struct {
		stages map[int]bool
		want   string
	}{
		{map[int]bool{1: true, 2: true, 3: true}, "both-modified"},
		{map[int]bool{2: true, 3: true}, "both-added"},
		{map[int]bool{1: true, 2: true}, "deleted-by-them"},
		{map[int]bool{1: true, 3: true}, "deleted-by-us"},
		{map[int]bool{2: true}, "both-modified"}, // 未知组合保守按内容冲突
	}
	for _, tc := range cases {
		if got := conflictStatusFromStages(tc.stages); got != tc.want {
			t.Errorf("stages %v = %q, want %q", tc.stages, got, tc.want)
		}
	}
}

func TestSupportsMergeTree(t *testing.T) {
	// 本机 git 是全仓库测试前置依赖（execGit 全家桶），版本探测必成：
	// 断言与 gitVersionAtLeast 对同一输出判定一致（防两处解析漂移）
	out, err := GitVersionOutput()
	if err != nil {
		t.Fatalf("git --version: %v", err)
	}
	if got, want := SupportsMergeTree(), gitVersionAtLeast(out, 2, MergeTreeMinMinor); got != want {
		t.Errorf("SupportsMergeTree() = %v, want %v (git version output %q)", got, want, out)
	}
}

func TestTruncateRunes(t *testing.T) {
	long := strings.Repeat("汉", mergePreviewMaxRunes+10)
	got := truncateRunes(long)
	if got == long {
		t.Fatal("long text must be truncated")
	}
	if !strings.HasSuffix(got, "…") {
		t.Errorf("truncated text must end with ellipsis, got %q", got)
	}
	if r := []rune(got); len(r) != mergePreviewMaxRunes+1 {
		t.Errorf("truncated runes = %d, want %d (+ellipsis)", len(r), mergePreviewMaxRunes+1)
	}
	short := strings.Repeat("a", 10)
	if truncateRunes(short) != short {
		t.Error("short text must pass through unchanged")
	}
}
