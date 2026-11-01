package git

import (
	"path/filepath"
	"testing"
)

// Pull 结果摘要计数（P-20261003-202）：
//   - countCommitsSince 按 before..HEAD 区间 rev-list --count 计量
//   - 空串基线（pull 前无 HEAD，零提交仓库）→ -1 无法计量
//   - 计数失败（基线 rev 已消失，如 pull 前后 rebase 改写历史且旧提交被 prune）
//     → -1 而非误报
//   - 端到端：真实 git pull（本地 bare 远端）后计数 = 远端多出的提交数
func TestCountCommitsSince(t *testing.T) {
	work, _ := setupUpstreamRepo(t)

	// 基线：与 upstream 同步，无新提交 → 0
	before := headCommitID(work)
	if before == "" {
		t.Fatal("headCommitID: empty for non-empty repo")
	}
	if n := countCommitsSince(work, before); n != 0 {
		t.Fatalf("synced: want 0, got %d", n)
	}

	// 本地连打 3 提交（模拟 pull 拉进 3 个）→ 3
	runGit(t, work, "commit", "--allow-empty", "-m", "n1")
	runGit(t, work, "commit", "--allow-empty", "-m", "n2")
	runGit(t, work, "commit", "--allow-empty", "-m", "n3")
	if n := countCommitsSince(work, before); n != 3 {
		t.Fatalf("after 3 commits: want 3, got %d", n)
	}

	// 空串基线（pull 前无 HEAD）→ -1
	if n := countCommitsSince(work, ""); n != -1 {
		t.Fatalf("empty baseline: want -1, got %d", n)
	}

	// 基线 rev 已失效（历史被改写且旧提交不可达）→ -1 不误报。
	// 注意不能用「40 位哈希追加字符」构造：git 的扩展 SHA 解析只读前 40 位，
	// 41 位串会被静默当原对象接受；翻转一位十六进制才是真不存在的对象名
	dead := before
	if dead[0] == 'f' {
		dead = "0" + dead[1:]
	} else {
		dead = "f" + dead[1:]
	}
	if n := countCommitsSince(work, dead); n != -1 {
		t.Fatalf("dead baseline: want -1, got %d", n)
	}

	// 零提交仓库：headCommitID 空
	empty := filepath.Join(t.TempDir(), "empty")
	runGit(t, "", "init", "-b", "main", empty)
	if id := headCommitID(empty); id != "" {
		t.Fatalf("empty repo: want empty head, got %q", id)
	}
}

// 端到端：work2 克隆远端后远端前进 2 提交，Pull(work2) 回执 NewCommits=2；
// 再拉一次（已最新）→ 0
func TestPullReportsNewCommitCount(t *testing.T) {
	work, remote := setupUpstreamRepo(t)

	// 第二个工作区克隆远端（本地路径远端无需凭据注入）
	work2 := filepath.Join(t.TempDir(), "work2")
	runGit(t, "", "clone", remote, work2)
	runGit(t, work2, "config", "user.email", "t@t")
	runGit(t, work2, "config", "user.name", "t")

	// 源仓库前进 2 提交并推送
	runGit(t, work, "commit", "--allow-empty", "-m", "p1")
	runGit(t, work, "commit", "--allow-empty", "-m", "p2")
	runGit(t, work, "push", "origin", "main")

	res, err := Pull(work2, "origin", "")
	if err != nil {
		t.Fatalf("pull: %v", err)
	}
	if res.NewCommits != 2 {
		t.Fatalf("pull after 2 remote commits: want NewCommits=2, got %d (output=%q)", res.NewCommits, res.Output)
	}
	if res.Output == "" {
		t.Fatal("pull: output should be preserved")
	}

	// 已最新再拉 → 0
	res, err = Pull(work2, "origin", "")
	if err != nil {
		t.Fatalf("second pull: %v", err)
	}
	if res.NewCommits != 0 {
		t.Fatalf("up-to-date pull: want NewCommits=0, got %d", res.NewCommits)
	}
}
