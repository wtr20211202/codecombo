package git

import (
	"testing"

	"codecombo/server/model"
)

// P-20261005-215 首推判定：push 回执 NewBranch 以 push 前本地跟踪引用
// refs/remotes/<remote>/<目标分支> 缺失为准——首推新分支 true、再推 false、
// 改推改名目标按目标名判定（「创建 PR」入口只跟首推走，PR 已建场景不重复打扰）

func TestPushNewBranch_FirstPushThenRepush(t *testing.T) {
	work, _ := setupUpstreamRepo(t)
	runGit(t, work, "checkout", "-b", "feat-pr")
	runGit(t, work, "commit", "--allow-empty", "-m", "feat work")

	res, err := Push(work, model.PushRequest{Remote: "origin", Branch: "feat-pr"})
	if err != nil {
		t.Fatalf("first push feat-pr: %v", err)
	}
	if !res.NewBranch {
		t.Fatal("first push of a new branch: NewBranch = false, want true")
	}

	runGit(t, work, "commit", "--allow-empty", "-m", "more work")
	res, err = Push(work, model.PushRequest{Remote: "origin", Branch: "feat-pr"})
	if err != nil {
		t.Fatalf("repush feat-pr: %v", err)
	}
	if res.NewBranch {
		t.Fatal("repush of existing remote branch: NewBranch = true, want false")
	}
}

func TestPushNewBranch_TrackingMainDefaultsFalse(t *testing.T) {
	// setupUpstreamRepo 已 push -u origin main：克隆基线的主干分支推送恒非首推
	//（PR 已建/不需要 PR 的主干推送不展示入口）
	work, _ := setupUpstreamRepo(t)
	runGit(t, work, "commit", "--allow-empty", "-m", "c2")

	res, err := Push(work, model.PushRequest{})
	if err != nil {
		t.Fatalf("push main: %v", err)
	}
	if res.NewBranch {
		t.Fatal("push of tracked main: NewBranch = true, want false")
	}
}

func TestPushNewBranch_RenameTargetFollowsRemoteName(t *testing.T) {
	work, _ := setupUpstreamRepo(t)
	runGit(t, work, "checkout", "-b", "feat-local")
	runGit(t, work, "commit", "--allow-empty", "-m", "renamed push")

	// 本地 feat-local 改推为远端 feat-remote：首推判定按目标名 feat-remote
	res, err := Push(work, model.PushRequest{Remote: "origin", Branch: "feat-local", RemoteBranch: "feat-remote", SetUpstream: true})
	if err != nil {
		t.Fatalf("push feat-local:feat-remote: %v", err)
	}
	if !res.NewBranch {
		t.Fatal("push to renamed new remote branch: NewBranch = false, want true")
	}
	if !trackingRefExists(work, "origin", "feat-remote") {
		t.Fatal("post-push fetch should have created refs/remotes/origin/feat-remote")
	}
	if trackingRefExists(work, "origin", "feat-local") {
		t.Fatal("refs/remotes/origin/feat-local should not exist (never pushed under this name)")
	}
}

func TestTrackingRefExists_ProbeSemantics(t *testing.T) {
	work, _ := setupUpstreamRepo(t)
	if !trackingRefExists(work, "origin", "main") {
		t.Fatal("main pushed with -u: tracking ref should exist")
	}
	if trackingRefExists(work, "origin", "never-pushed") {
		t.Fatal("never-pushed branch: tracking ref should be absent")
	}
	// 畸形目标名（含 .. 等非法 ref 字符）：rev-parse 失败按「无」处理，不 panic 不误报存在
	if trackingRefExists(work, "origin", "../escape") {
		t.Fatal("malformed ref must not report exists")
	}
}
