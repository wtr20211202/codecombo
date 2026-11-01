package git

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ShelvePartial 单测（P-20261007-19）：pathspec 限定 stash push -u 的搁置语义。
// 四条关键性质：
//  1. 组内文件的变更（含未暂存与 untracked）入栈、工作区归零；
//  2. 无关变更（含用户手动 staged 的）一概不碰——原 --cached 形态的误入风险；
//  3. 消息带 `shelve: ` 标识（stash 面板徽标依据）；
//  4. 组内无变更时 created=false（refs/stash 指纹不变，如实回告不谎报）。
func shelveFixture(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	must := func(args ...string) string {
		out, err := execGit(repo, args...)
		if err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
		return out
	}
	must("init", "-q", "-b", "master")
	// 本机全局 autocrlf 会污染内容稳定性，仓库级显式关闭
	must("config", "core.autocrlf", "false")
	must("config", "user.email", "t@t")
	must("config", "user.name", "t")
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(repo, name), []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	write("a.txt", "base\n")
	write("b.txt", "base\n")
	write("c.txt", "base\n")
	must("add", ".")
	must("commit", "-q", "-m", "base")
	return repo
}

func shelveStatus(t *testing.T, repo string) string {
	t.Helper()
	out, err := execGit(repo, "status", "--porcelain")
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	return strings.TrimSpace(out)
}

func TestShelvePartial_GroupFilesOnly(t *testing.T) {
	repo := shelveFixture(t)
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(repo, name), []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	// a.txt 已暂存、b.txt 未暂存、new.txt untracked、c.txt 无变更；
	// 搁置组 = {a, b, new}（c.txt 在组内但无变更，pathspec 容忍）
	write("a.txt", "mod a\n")
	write("b.txt", "mod b\n")
	write("new.txt", "brand new\n")

	created, err := ShelvePartial(repo, []string{"a.txt", "b.txt", "new.txt", "c.txt"}, "login form")
	if err != nil {
		t.Fatalf("ShelvePartial: %v", err)
	}
	if !created {
		t.Fatal("created = false, want true")
	}

	// 组内文件工作区归零（a/b 回 base、new.txt 摘走），无关变更不在此列
	if st := shelveStatus(t, repo); st != "" {
		t.Fatalf("worktree not clean after shelve:\n%s", st)
	}

	// 条目消息带 shelve: 标识（面板徽标依据）
	stashes, err := GetStashes(repo)
	if err != nil || len(stashes) != 1 {
		t.Fatalf("GetStashes: %v, n=%d", err, len(stashes))
	}
	if !strings.Contains(stashes[0].Message, "shelve: login form") {
		t.Fatalf("stash message %q missing shelve marker", stashes[0].Message)
	}

	// 恢复（pop）后组内变更回来（untracked 亦然）
	if _, err := StashPop(repo, 0); err != nil {
		t.Fatalf("StashPop: %v", err)
	}
	st := shelveStatus(t, repo)
	for _, want := range []string{"a.txt", "b.txt", "new.txt"} {
		if !strings.Contains(st, want) {
			t.Fatalf("restored status missing %s:\n%s", want, st)
		}
	}
}

func TestShelvePartial_UnrelatedStagedUntouched(t *testing.T) {
	repo := shelveFixture(t)
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(repo, name), []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	// 用户手动 staged 的 unrelated.txt 与组内 b.txt；搁置组只含 b.txt
	write("unrelated.txt", "user staged this\n")
	write("b.txt", "mod b\n")
	if _, err := execGit(repo, "add", "unrelated.txt"); err != nil {
		t.Fatalf("add unrelated: %v", err)
	}

	if _, err := ShelvePartial(repo, []string{"b.txt"}, ""); err != nil {
		t.Fatalf("ShelvePartial: %v", err)
	}

	st := shelveStatus(t, repo)
	// unrelated 仍处于已暂存态（首列 A=新文件入索引未提交；首列 M 则为已跟踪
	// 文件的暂存修改）——原 --cached 形态会把它误入搁置条目
	if !strings.Contains(st, "A  unrelated.txt") {
		t.Fatalf("unrelated staged file affected:\n%s", st)
	}
	if strings.Contains(st, "b.txt") {
		t.Fatalf("group file b.txt should be shelved away:\n%s", st)
	}
	// 空消息落文件数兜底，shelve: 标识恒在
	stashes, err := GetStashes(repo)
	if err != nil || len(stashes) != 1 {
		t.Fatalf("GetStashes: %v, n=%d", err, len(stashes))
	}
	if !strings.Contains(stashes[0].Message, "shelve: 1 file(s)") {
		t.Fatalf("empty-message fallback missing: %q", stashes[0].Message)
	}
}

func TestShelvePartial_NoChangeCreatedFalse(t *testing.T) {
	repo := shelveFixture(t)
	// 组内文件全部无变更（tracked-but-clean）：git 是退出 0 的 no-op，
	// created=false 如实回告、不产生条目
	created, err := ShelvePartial(repo, []string{"a.txt", "b.txt"}, "")
	if err != nil {
		t.Fatalf("ShelvePartial: %v", err)
	}
	if created {
		t.Fatal("created = true, want false (no local changes)")
	}
	stashes, _ := GetStashes(repo)
	if len(stashes) != 0 {
		t.Fatalf("unexpected stash entries: %d", len(stashes))
	}
}

func TestShelvePartial_EmptyFilesNoop(t *testing.T) {
	repo := shelveFixture(t)
	created, err := ShelvePartial(repo, nil, "")
	if err != nil || created {
		t.Fatalf("empty files should noop: created=%v err=%v", created, err)
	}
}
