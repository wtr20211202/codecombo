package git

import (
	"strings"
	"testing"

	"codecombo/server/model"
)

// Push 的 force-with-lease 透传与 lease 语义（P-20261003-213 推送弹层暴露该选项）：
//   - 分叉但远端仍停在本地跟踪位（reword/rebase 后的典型形态）→ --force-with-lease
//     推送成功且远端真实改写（覆盖推送的正路）
//   - 远端已越过本地跟踪位（他人新推、本地未 fetch）→ lease 保护拒绝（stale info），
//     远端不动；默认无旗标 push 同场景同样拒绝（UI 默认关不可达的服务端镜像）
//   - Force 优先于 ForceWithLease（remote.go if/else 惯例）：同时携带时裸 force
//     生效、lease 不拦
func TestPushForceWithLease(t *testing.T) {
	work, remote := setupUpstreamRepo(t)
	remoteHead := func() string {
		out, err := execGit(remote, "rev-parse", "main")
		if err != nil {
			t.Fatalf("rev-parse remote main: %v", err)
		}
		return strings.TrimSpace(out)
	}
	localHead := func() string {
		out, err := execGit(work, "rev-parse", "HEAD")
		if err != nil {
			t.Fatalf("rev-parse local HEAD: %v", err)
		}
		return strings.TrimSpace(out)
	}

	// —— 场景一：reword 分叉（ahead1/behind1，远端仍在跟踪位）→ lease 推送成功 ——
	runGit(t, work, "commit", "--amend", "-m", "c1 rewored")
	if _, ahead, behind, err := GetRepoHeadTracking(work); err != nil || ahead != 1 || behind != 1 {
		t.Fatalf("precondition: ahead=%d behind=%d err=%v", ahead, behind, err)
	}
	if _, err := Push(work, model.PushRequest{Branch: "main", ForceWithLease: true}); err != nil {
		t.Fatalf("lease push with remote at tracking ref: %v", err)
	}
	if remoteHead() != localHead() {
		t.Fatalf("lease push: remote %s not rewritten to local %s", remoteHead(), localHead())
	}

	// —— 场景二：远端越过跟踪位（他人新推，本地未 fetch）→ lease 拒绝 ——
	// 先把本地拉回与远端同步，再造「本地有独立提交 + 远端被他人推进」的分叉
	if _, err := Push(work, model.PushRequest{}); err != nil {
		t.Fatalf("sync push: %v", err)
	}
	other := t.TempDir() + "/other"
	runGit(t, "", "clone", "--quiet", remote, other)
	runGit(t, other, "config", "user.email", "t@t")
	runGit(t, other, "config", "user.name", "t")
	if err := writeFile(other+"/b.txt", "by other\n"); err != nil {
		t.Fatal(err)
	}
	runGit(t, other, "add", "-A")
	runGit(t, other, "commit", "-m", "c2 by other")
	runGit(t, other, "push", "--quiet", "origin", "main")
	if err := writeFile(work+"/c.txt", "local only\n"); err != nil {
		t.Fatal(err)
	}
	runGit(t, work, "add", "-A")
	runGit(t, work, "commit", "-m", "c3 local only")
	// 本地跟踪 ref 未 fetch 仍停在 c1'：ahead1/behind0——「本地不知道远端被推进」
	// 的 stale info 形态正是 lease 要拦的（behind 要 fetch 后才可见）
	if _, ahead, behind, err := GetRepoHeadTracking(work); err != nil || ahead != 1 || behind != 0 {
		t.Fatalf("diverged precondition: ahead=%d behind=%d err=%v", ahead, behind, err)
	}
	staleRemoteHead := remoteHead()
	if _, err := Push(work, model.PushRequest{Branch: "main", ForceWithLease: true}); err == nil {
		t.Fatal("lease push with stale remote tracking: want error, got nil")
	}
	if remoteHead() != staleRemoteHead {
		t.Fatalf("rejected lease push must not move remote: %s -> %s", staleRemoteHead, remoteHead())
	}

	// —— 场景三：默认无旗标（UI 默认关）同场景同样拒绝，远端不动 ——
	if _, err := Push(work, model.PushRequest{Branch: "main"}); err == nil {
		t.Fatal("plain push non-fast-forward: want error, got nil")
	}
	if remoteHead() != staleRemoteHead {
		t.Fatalf("rejected plain push must not move remote: %s -> %s", staleRemoteHead, remoteHead())
	}

	// —— 场景四：Force 与 ForceWithLease 同时携带 → 裸 force 优先（lease 不拦）——
	if _, err := Push(work, model.PushRequest{Branch: "main", Force: true, ForceWithLease: true}); err != nil {
		t.Fatalf("force precedence push: %v", err)
	}
	if remoteHead() != localHead() {
		t.Fatalf("force precedence: remote %s != local %s", remoteHead(), localHead())
	}
}
