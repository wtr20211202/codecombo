package system

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/notification"
	"codecombo/server/store"
)

// 开工检查单晨报单测（P-20261005-219）：聚合体形状与各源计数语义是前端横幅卡
// 与 agent 晨间巡检的共同契约——date 当日锚/未读口径（未读未延后 + 挂起主卡
// 审批，并入条目不重复计）/未推送源 ahead 汇总与冻结排除在此固化。git 探测随
// 环境浮动，未推送源以自备迷你仓库钉一个 ahead=1 真实样本。

func gitCmd(t *testing.T, cwd string, args ...string) {
	t.Helper()
	full := append([]string{"-c", "user.name=t", "-c", "user.email=t@t.local"}, args...)
	cmd := exec.Command("git", full...)
	cmd.Dir = cwd
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
}

// makeAheadRepo bare + clone 工作区，工作区再落一笔未推送提交（ahead=1）
func makeAheadRepo(t *testing.T, dir string) string {
	t.Helper()
	// 工作区目录先建空壳：git 允许 clone 进既有空目录；bare init 也需要 cwd 存在
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	bare := dir + "-bare"
	gitCmd(t, dir, "init", "--bare", "-b", "main", bare)
	gitCmd(t, dir, "clone", bare, dir)
	gitCmd(t, dir, "commit", "--allow-empty", "-m", "root")
	gitCmd(t, dir, "push", "-u", "origin", "main")
	gitCmd(t, dir, "commit", "--allow-empty", "-m", "unpushed: 隔夜忘推")
	return dir
}

func TestMorningBriefDate(t *testing.T) {
	if got := morningBriefDate(time.Date(2026, 10, 15, 23, 59, 9, 0, time.UTC)); got != "2026-10-15" {
		t.Fatalf("morningBriefDate = %q, want 2026-10-15", got)
	}
}

func TestMorningBriefReportEmptyStore(t *testing.T) {
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })

	brief := MorningBriefReport()
	if brief.Date != morningBriefDate(time.Now()) {
		t.Fatalf("date = %q, want today %q", brief.Date, morningBriefDate(time.Now()))
	}
	// 空实例三源齐全且全零——「全零零打扰」的诚实值基线
	if brief.Unpushed == nil || brief.Unpushed.Count != 0 || len(brief.Unpushed.Projects) != 0 {
		t.Fatalf("unpushed = %+v, want zero-count empty list", brief.Unpushed)
	}
	if brief.RunningAgents == nil || brief.RunningAgents.Count != 0 {
		t.Fatalf("runningAgents = %+v, want zero", brief.RunningAgents)
	}
	if brief.Unread == nil || brief.Unread.Count != 0 || brief.Unread.Notifications != 0 || brief.Unread.Approvals != 0 {
		t.Fatalf("unread = %+v, want zeros", brief.Unread)
	}
}

func TestMorningBriefReportUnreadSemantics(t *testing.T) {
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	st := store.Get()

	// 未读 + 未延后 → 计入
	st.Notification.Add(notification.Notification{Type: "info", Category: "system", Title: "unread-a"})
	// 已读 → 不计
	read := notification.Notification{Type: "info", Category: "system", Title: "read"}
	st.Notification.Add(read)
	for _, n := range st.Notification.List(0) {
		if n.Title == "read" {
			st.Notification.MarkRead(n.ID)
		}
	}
	// 延后中（未到点）→ 不计（与前端徽标口径一致：到点重挂才回未读）
	st.Notification.Add(notification.Notification{Type: "info", Category: "system", Title: "snoozed"})
	for _, n := range st.Notification.List(0) {
		if n.Title == "snoozed" {
			if !st.Notification.Snooze(n.ID, time.Now().Add(time.Hour)) {
				t.Fatal("snooze failed")
			}
		}
	}

	// 挂起主卡审批 → 计入；并入条目（MergedInto 非空）→ 不重复计；已裁决 → 不计
	//（List(pending) 按状态过滤，denied/allowed 天然不在源集合内）
	mustSave := func(a store.AgentApproval) {
		t.Helper()
		if err := st.AgentApproval.Save(a); err != nil {
			t.Fatal(err)
		}
	}
	mustSave(store.AgentApproval{ID: store.NewAgentApprovalID(), Op: "op-a", Target: "t1", Status: store.ApprovalPending})
	mustSave(store.AgentApproval{ID: store.NewAgentApprovalID(), Op: "op-a", Target: "t2", Status: store.ApprovalPending, MergedInto: "sc_ap_main"})
	mustSave(store.AgentApproval{ID: store.NewAgentApprovalID(), Op: "op-b", Target: "t3", Status: store.ApprovalAllowed})
	mustSave(store.AgentApproval{ID: store.NewAgentApprovalID(), Op: "op-c", Target: "t4", Status: store.ApprovalDenied})

	brief := MorningBriefReport()
	if brief.Unread == nil {
		t.Fatal("unread source missing")
	}
	if brief.Unread.Notifications != 1 {
		t.Fatalf("notifications = %d, want 1（未读未延后才计）", brief.Unread.Notifications)
	}
	if brief.Unread.Approvals != 1 {
		t.Fatalf("approvals = %d, want 1（挂起主卡口径，并入条目不重复计）", brief.Unread.Approvals)
	}
	if brief.Unread.Count != 2 {
		t.Fatalf("unread.count = %d, want 2", brief.Unread.Count)
	}
}

func TestMorningBriefReportUnpushed(t *testing.T) {
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	st := store.Get()

	// 真实 ahead=1 样本 + 非 git 目录（探 0，诚实值）+ 冻结项目（跳过探测）
	aheadDir := makeAheadRepo(t, filepath.Join(t.TempDir(), "brief-ahead"))
	if err := st.Project.Create(config.ProjectConfig{ID: "p-ahead", Name: "ahead-one", Path: aheadDir}); err != nil {
		t.Fatal(err)
	}
	plain := t.TempDir()
	if err := st.Project.Create(config.ProjectConfig{ID: "p-plain", Name: "plain", Path: plain}); err != nil {
		t.Fatal(err)
	}
	if err := st.Project.Create(config.ProjectConfig{ID: "p-frozen", Name: "frozen", Path: aheadDir, Frozen: true}); err != nil {
		t.Fatal(err)
	}

	brief := MorningBriefReport()
	if brief.Unpushed == nil {
		t.Fatal("unpushed source missing")
	}
	if brief.Unpushed.Count != 1 {
		t.Fatalf("unpushed.count = %d, want 1（隔夜未推送提交）", brief.Unpushed.Count)
	}
	if len(brief.Unpushed.Projects) != 1 || brief.Unpushed.Projects[0].ID != "p-ahead" || brief.Unpushed.Projects[0].Ahead != 1 {
		t.Fatalf("unpushed.projects = %+v, want only p-ahead ahead=1（冻结与非 git 项目不进清单）", brief.Unpushed.Projects)
	}
}
