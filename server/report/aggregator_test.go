package report

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/model"
	"codecombo/server/notification"
	"codecombo/server/store"
)

// ── git 仓库夹具 ──

// runGit 在 repo 内执行 git 命令（env 追加进程环境，供提交时间伪造）
func runGit(t *testing.T, repo string, env []string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = repo
	cmd.Env = append(os.Environ(), env...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// gitRepoFixture 初始化空仓库（user 配置就位）
func gitRepoFixture(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	runGit(t, repo, nil, "init", "-q")
	runGit(t, repo, nil, "config", "user.email", "t@t")
	runGit(t, repo, nil, "config", "user.name", "t")
	return repo
}

// commit 在 repo 落一个提交；date 非空时伪造作者/提交时间（ISO 8601）
func commit(t *testing.T, repo, name, msg, date string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(repo, name), []byte(msg), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, nil, "add", ".")
	var env []string
	if date != "" {
		env = []string{"GIT_AUTHOR_DATE=" + date, "GIT_COMMITTER_DATE=" + date}
	}
	runGit(t, repo, env, "commit", "-q", "-m", msg)
}

// ── 聚合：提交面（真实 git 仓库）──

// TestAggregateProject_CommitsFromGit 真实仓库聚合：当日计数、主题按新→旧、
// 前 5 条封顶、窗口外提交不计。旧提交先落（真实时间线上历史在前，HEAD 为
// 当日提交——git --since 的遍历截断以提交时间为界，HEAD 早于窗口会整体剪枝）
func TestAggregateProject_CommitsFromGit(t *testing.T) {
	repo := gitRepoFixture(t)
	commit(t, repo, "old.txt", "chore: old", "2020-01-15T12:00:00")
	for i := 0; i < 7; i++ {
		commit(t, repo, fmt.Sprintf("f%d.txt", i), fmt.Sprintf("feat: c%d", i), "")
	}

	l := Loaders{Commits: gitCommits}
	d := l.AggregateProject(config.ProjectConfig{ID: "p", Name: "r", Path: repo}, time.Now())

	if d.Commits != 7 {
		t.Fatalf("Commits = %d, want 7", d.Commits)
	}
	if len(d.CommitSubjects) != subjectLimit {
		t.Fatalf("subjects len = %d, want %d (封顶)", len(d.CommitSubjects), subjectLimit)
	}
	// git log 按 HEAD→父序输出，最后创建的 c6 最新
	if d.CommitSubjects[0] != "feat: c6" {
		t.Fatalf("subjects[0] = %q, want feat: c6", d.CommitSubjects[0])
	}
	if d.Empty() {
		t.Fatal("7 commits today should not be Empty")
	}
}

// TestAggregateProject_EmptyRepo 空仓库（无提交）：git log 报错按零值计，
// 项目判零事件
func TestAggregateProject_EmptyRepo(t *testing.T) {
	repo := gitRepoFixture(t)
	l := Loaders{Commits: gitCommits}
	d := l.AggregateProject(config.ProjectConfig{ID: "p", Name: "r", Path: repo}, time.Now())
	if d.Commits != 0 || !d.Empty() {
		t.Fatalf("empty repo should aggregate to zero events, got %+v", d)
	}
}

// ── 聚合：会话/命令/实例面（内存桩）──

func stubTime() time.Time { return time.Date(2026, 10, 2, 21, 5, 0, 0, time.Local) }

// TestAggregateProject_SessionsAndCmds 会话与命令按当日窗口过滤
func TestAggregateProject_SessionsAndCmds(t *testing.T) {
	now := stubTime()
	old := func() time.Time { return now.AddDate(0, 0, -1) }

	l := Loaders{
		ClaudeSessions: func(string) ([]store.ClaudeIndexEntry, error) {
			return []store.ClaudeIndexEntry{
				{ID: "today-1", LastAt: now.Add(-time.Hour)},
				{ID: "today-2", LastAt: now.Add(-2 * time.Hour)},
				{ID: "yesterday", LastAt: old()},
			}, nil
		},
		TerminalHistory: func(string) ([]store.HistoryEntry, error) {
			return []store.HistoryEntry{
				{Command: "go test", At: now.Add(-time.Minute)},
				{Command: "old", At: old()},
			}, nil
		},
	}
	d := l.AggregateProject(config.ProjectConfig{ID: "p", Name: "r", Path: "/x"}, now)
	if d.ClaudeSessions != 2 {
		t.Fatalf("ClaudeSessions = %d, want 2", d.ClaudeSessions)
	}
	if d.TerminalCmds != 1 {
		t.Fatalf("TerminalCmds = %d, want 1", d.TerminalCmds)
	}
}

// TestAggregateInstance 审批（进行中/当日已裁决）与部署（当日成败，取消不计）
func TestAggregateInstance(t *testing.T) {
	now := stubTime()
	today := now.Add(-time.Hour)
	old := now.AddDate(0, 0, -1)

	l := Loaders{
		Approvals: func() ([]store.AgentApproval, error) {
			return []store.AgentApproval{
				{Status: store.ApprovalPending, CreatedAt: old},                     // 未决即进行中（不限创建日）
				{Status: store.ApprovalAllowed, CreatedAt: old, ResolvedAt: &today}, // 当日裁决 → 完成
				{Status: store.ApprovalDenied, CreatedAt: old, ResolvedAt: &old},    // 往日裁决 → 不计
				{Status: store.ApprovalAllowed, CreatedAt: today},                   // 已消费缺裁决时间 → 退回创建日计
			}, nil
		},
		DeployTasks: func() ([]config.DeployTask, error) {
			return []config.DeployTask{
				{Status: config.TaskStatusCompleted, StartedAt: &today},
				{Status: config.TaskStatusFailed, StartedAt: &today},
				{Status: config.TaskStatusCancelled, StartedAt: &today}, // 取消不计成败
				{Status: config.TaskStatusRunning, StartedAt: &today},   // 运行中不计
				{Status: config.TaskStatusCompleted, StartedAt: &old},   // 窗口外不计
			}, nil
		},
	}
	inst := l.AggregateInstance(now)
	if inst.ApprovalsPending != 1 || inst.ApprovalsDone != 2 {
		t.Fatalf("approvals = pending %d / done %d, want 1 / 2", inst.ApprovalsPending, inst.ApprovalsDone)
	}
	if inst.DeploysOK != 1 || inst.DeploysFailed != 1 {
		t.Fatalf("deploys = ok %d / fail %d, want 1 / 1", inst.DeploysOK, inst.DeploysFailed)
	}
}

// TestAggregateInstance_Security 安全事件计数（P-20261003-51）：当日总数 +
// 分类小计（解锁失败=结果非 success、令牌变更=token 生命周期动作）；
// 窗口外不计，读取失败按零值计（尽力而为，不拖垮日报）
func TestAggregateInstance_Security(t *testing.T) {
	now := stubTime()
	today := now.Add(-time.Hour)
	old := now.AddDate(0, 0, -1)

	l := Loaders{
		Audit: func() ([]store.AuditEvent, error) {
			return []store.AuditEvent{
				{Action: store.AuditUnlock, Result: store.AuditResultSuccess, Time: today},       // 正常解锁：只计总数
				{Action: store.AuditUnlock, Result: store.AuditResultFailure, Time: today},       // 解锁失败（密码错）
				{Action: store.AuditUnlock, Result: store.AuditResultDenied, Time: today},        // 解锁失败（限流拒）
				{Action: store.AuditTokenCreate, Result: store.AuditResultSuccess, Time: today},  // 令牌变更
				{Action: store.AuditAgentRotated, Result: store.AuditResultSuccess, Time: today}, // 令牌变更（agent 侧）
				{Action: store.AuditCredSave, Result: store.AuditResultSuccess, Time: today},     // 其他安全事件：只计总数
				{Action: store.AuditUnlock, Result: store.AuditResultFailure, Time: old},         // 窗口外不计
			}, nil
		},
	}
	inst := l.AggregateInstance(now)
	if inst.SecEvents != 6 {
		t.Fatalf("SecEvents = %d, want 6（当日全部审计事件）", inst.SecEvents)
	}
	if inst.SecUnlockFail != 2 {
		t.Fatalf("SecUnlockFail = %d, want 2（密码错+限流拒，成功解锁不计）", inst.SecUnlockFail)
	}
	if inst.SecTokenChange != 2 {
		t.Fatalf("SecTokenChange = %d, want 2（API/agent token 同权）", inst.SecTokenChange)
	}

	fail := Loaders{Audit: func() ([]store.AuditEvent, error) { return nil, fmt.Errorf("boom") }}
	if inst := fail.AggregateInstance(now); inst.SecEvents != 0 || inst.SecUnlockFail != 0 || inst.SecTokenChange != 0 {
		t.Fatalf("audit loader error should zero-count, got %+v", inst)
	}
}

// ── Emit：零事件跳过 + 通知形状 ──

// fullLoaders 双项目桩：alpha 有全部事件，beta 零事件（判跳过）
func fullLoaders(now time.Time) Loaders {
	today := now.Add(-2 * time.Hour)
	old := now.AddDate(0, 0, -1)
	return Loaders{
		Projects: func() ([]config.ProjectConfig, error) {
			return []config.ProjectConfig{
				{ID: "p1", Name: "alpha", Path: "/a"},
				{ID: "p2", Name: "beta", Path: "/b"},
			}, nil
		},
		Commits: func(repoPath string, _, _ time.Time) ([]model.Commit, error) {
			if repoPath != "/a" {
				return nil, nil
			}
			return []model.Commit{
				{Message: "feat: one", Date: today},
				{Message: "fix: two", Date: today},
				{Message: "chore: old", Date: old},
			}, nil
		},
		ClaudeSessions: func(p string) ([]store.ClaudeIndexEntry, error) {
			if p != "/a" {
				return nil, nil
			}
			return []store.ClaudeIndexEntry{{ID: "s1", LastAt: today}}, nil
		},
		ClaudeTokens: func(p string, _, _ time.Time) (int64, error) {
			if p != "/a" {
				return 0, nil
			}
			return 2800, nil
		},
		TerminalHistory: func(id string) ([]store.HistoryEntry, error) {
			if id != "p1" {
				return nil, nil
			}
			return []store.HistoryEntry{{Command: "make", At: today}}, nil
		},
		Approvals: func() ([]store.AgentApproval, error) {
			return []store.AgentApproval{
				{Status: store.ApprovalPending, CreatedAt: old},
				{Status: store.ApprovalAllowed, CreatedAt: old, ResolvedAt: &today},
			}, nil
		},
		DeployTasks: func() ([]config.DeployTask, error) {
			return []config.DeployTask{
				{Status: config.TaskStatusCompleted, StartedAt: &today},
				{Status: config.TaskStatusFailed, StartedAt: &today},
			}, nil
		},
		Audit: func() ([]store.AuditEvent, error) {
			return []store.AuditEvent{
				{Action: store.AuditUnlock, Result: store.AuditResultSuccess, Time: today},      // 正常解锁
				{Action: store.AuditUnlock, Result: store.AuditResultFailure, Time: today},      // 解锁失败
				{Action: store.AuditTokenCreate, Result: store.AuditResultSuccess, Time: today}, // 令牌变更
			}, nil
		},
	}
}

func TestEmit_SkipsZeroEventProjects(t *testing.T) {
	now := stubTime()
	var got []notification.Notification
	n := Emit(now, fullLoaders(now), func(x notification.Notification) { got = append(got, x) }, nil)

	if n != 1 || len(got) != 1 {
		t.Fatalf("emit count = %d (captured %d), want 1——零事件的 beta 应跳过", n, len(got))
	}
}

func TestEmit_NotificationShape(t *testing.T) {
	now := stubTime()
	var got []notification.Notification
	Emit(now, fullLoaders(now), func(x notification.Notification) { got = append(got, x) }, nil)
	d := got[0]

	if d.Type != "info" || d.Category != notification.CategorySystem {
		t.Fatalf("type/category = %s/%s, want info/system（站内聚合不弹桌面通知）", d.Type, d.Category)
	}
	if d.ProjectID != "p1" || d.ProjectName != "alpha" {
		t.Fatalf("project = %s/%s, want p1/alpha", d.ProjectID, d.ProjectName)
	}
	if d.Action != "panel" || d.ActionPayload != "git" {
		t.Fatalf("action = %s:%s, want panel:git（直达提交历史）", d.Action, d.ActionPayload)
	}
	// 当日有审计事件 → 正文模板切到含安全事件行的 bodySec（P-20261003-51）
	if d.TitleKey != "report.daily.title" || d.BodyKey != DailyBodySecKey {
		t.Fatalf("i18n keys = %s / %s, want report.daily.title / %s", d.TitleKey, d.BodyKey, DailyBodySecKey)
	}
	// Body 承载语言中立明细：当日提交主题按新→旧，窗口外不计
	if d.Body != "feat: one\nfix: two" {
		t.Fatalf("Body = %q, want 当日提交主题两行", d.Body)
	}
	want := map[string]any{
		"name": "alpha", "commits": 2, "sessions": 1, "cmds": 1, "tokens": "2.8k",
		"approvalsDone": 1, "approvalsPending": 1, "deploysOk": 1, "deploysFail": 1,
		"secTotal": 3, "secUnlockFail": 1, "secTokenChange": 1,
	}
	if len(d.MsgParams) != len(want) {
		t.Fatalf("MsgParams = %v, want %v", d.MsgParams, want)
	}
	for k, v := range want {
		if d.MsgParams[k] != v {
			t.Errorf("MsgParams[%s] = %v, want %v", k, d.MsgParams[k], v)
		}
	}
}

// TestDailyNotification_SecurityLineKey 零安全事件沿用基础模板（零事件整行
// 省略——判定在键选择处完成，前端零改动）；小计随 MsgParams 透传
func TestDailyNotification_SecurityLineKey(t *testing.T) {
	d := Daily{ProjectID: "p", ProjectName: "alpha"}
	if k := DailyNotification(d, Instance{}).BodyKey; k != "report.daily.body" {
		t.Fatalf("zero-security BodyKey = %q, want report.daily.body（整行省略）", k)
	}
	n := DailyNotification(d, Instance{SecEvents: 2, SecUnlockFail: 1, SecTokenChange: 1})
	if n.BodyKey != DailyBodySecKey {
		t.Fatalf("with-security BodyKey = %q, want %s", n.BodyKey, DailyBodySecKey)
	}
	if n.MsgParams["secTotal"] != 2 || n.MsgParams["secUnlockFail"] != 1 || n.MsgParams["secTokenChange"] != 1 {
		t.Fatalf("sec params = %v, want 2/1/1", n.MsgParams)
	}
}

// TestDailyNotification_TruncatesSubjects 超长提交主题按 rune 截断留头
// （conventional 提交的数百字符尾注不淹没通知流），短主题原样保留
func TestDailyNotification_TruncatesSubjects(t *testing.T) {
	long := strings.Repeat("长", 120)
	short := "feat: ok"
	d := Daily{ProjectID: "p", ProjectName: "alpha", CommitSubjects: []string{long, short}}
	n := DailyNotification(d, Instance{})

	lines := strings.Split(n.Body, "\n")
	if len(lines) != 2 {
		t.Fatalf("Body lines = %d, want 2", len(lines))
	}
	want := strings.Repeat("长", subjectMaxLen-1) + "…"
	if lines[0] != want {
		t.Fatalf("long subject = %d runes, want %d + …", len([]rune(lines[0])), subjectMaxLen-1)
	}
	if lines[1] != short {
		t.Fatalf("short subject = %q, want %q", lines[1], short)
	}
}

func TestEmit_Guards(t *testing.T) {
	now := stubTime()
	if n := Emit(now, Loaders{}, func(notification.Notification) {}, nil); n != 0 {
		t.Fatalf("nil Projects loader should emit 0, got %d", n)
	}
	errLoaders := Loaders{Projects: func() ([]config.ProjectConfig, error) { return nil, fmt.Errorf("boom") }}
	if n := Emit(now, errLoaders, func(notification.Notification) {}, nil); n != 0 {
		t.Fatalf("projects error should emit 0, got %d", n)
	}
	emptyLoaders := Loaders{Projects: func() ([]config.ProjectConfig, error) { return nil, nil }}
	if n := Emit(now, emptyLoaders, func(notification.Notification) {}, nil); n != 0 {
		t.Fatalf("no projects should emit 0, got %d", n)
	}
	if n := Emit(now, fullLoaders(now), nil, nil); n != 0 {
		t.Fatalf("nil add should emit 0, got %d", n)
	}
}

// ── 聚合：token 消耗维度（P-20261002-139）──

// TestAggregateProject_ClaudeTokens 当日 token 消耗入聚合；加载窗口为当日
// [start, end)；加载失败按零值计（尽力而为，不拖垮日报）
func TestAggregateProject_ClaudeTokens(t *testing.T) {
	now := stubTime()
	var gotStart, gotEnd time.Time
	l := Loaders{
		ClaudeTokens: func(_ string, start, end time.Time) (int64, error) {
			gotStart, gotEnd = start, end
			return 2800, nil
		},
	}
	d := l.AggregateProject(config.ProjectConfig{ID: "p", Name: "r", Path: "/x"}, now)
	if d.ClaudeTokens != 2800 {
		t.Fatalf("ClaudeTokens = %d, want 2800", d.ClaudeTokens)
	}
	ws, we := dayWindow(now)
	if !gotStart.Equal(ws) || !gotEnd.Equal(we) {
		t.Fatalf("window = [%v, %v], want [%v, %v]", gotStart, gotEnd, ws, we)
	}

	fail := Loaders{ClaudeTokens: func(string, time.Time, time.Time) (int64, error) {
		return 0, fmt.Errorf("boom")
	}}
	if d := fail.AggregateProject(config.ProjectConfig{ID: "p", Name: "r", Path: "/x"}, now); d.ClaudeTokens != 0 {
		t.Fatalf("loader error should zero-count, got %d", d.ClaudeTokens)
	}
}

// TestFormatTokensCompact 紧凑口径与前端 fmtTokens 一致（日报正文与会话
// 列表徽标数字对得上）
func TestFormatTokensCompact(t *testing.T) {
	cases := map[int64]string{
		0: "0", 999: "999", 1000: "1k", 2800: "2.8k", 10000: "10k",
		99999: "100k", 150000: "150k", 1234567: "1.2M",
	}
	for in, want := range cases {
		if got := formatTokensCompact(in); got != want {
			t.Errorf("formatTokensCompact(%d) = %q, want %q", in, got, want)
		}
	}
}

// ── Emit：存档落档口（P-20261003-4）──

// TestEmit_Archive 发报时同步落档：与通知同批组装（先档后投），聚合事实与
// 通知 MsgParams 同源——tokens 存原始值、主题沿用展示截断、date 为当日
func TestEmit_Archive(t *testing.T) {
	now := stubTime()
	var got []store.DailyReport
	Emit(now, fullLoaders(now), func(notification.Notification) {}, func(r store.DailyReport) error {
		got = append(got, r)
		return nil
	})

	if len(got) != 1 {
		t.Fatalf("archived = %d 条, want 1（零事件的 beta 不落档）", len(got))
	}
	a := got[0]
	if a.ProjectID != "p1" || a.ProjectName != "alpha" {
		t.Fatalf("archived project = %s/%s, want p1/alpha", a.ProjectID, a.ProjectName)
	}
	if a.Date != now.Format(archiveDateFormat) {
		t.Fatalf("archived date = %s, want 当日 %s", a.Date, now.Format(archiveDateFormat))
	}
	if a.Commits != 2 || len(a.CommitSubjects) != 2 || a.CommitSubjects[0] != "feat: one" {
		t.Fatalf("archived commits = %d/%v, want 2 条主题新→旧", a.Commits, a.CommitSubjects)
	}
	if a.ClaudeSessions != 1 || a.ClaudeTokens != 2800 || a.TerminalCmds != 1 {
		t.Fatalf("archived facts = sessions %d tokens %d cmds %d, want 1/2800/1（tokens 原始值）",
			a.ClaudeSessions, a.ClaudeTokens, a.TerminalCmds)
	}
	if a.ApprovalsDone != 1 || a.ApprovalsPending != 1 || a.DeploysOK != 1 || a.DeploysFailed != 1 {
		t.Fatalf("archived instance facts = %+v, want 与通知同源快照", a)
	}
}

// TestEmit_ArchiveFailureNotBlocking 落档失败不阻断通知主链（与 webhook
// 同款尽力而为）：存档口报错时通知照发、计数不缺
func TestEmit_ArchiveFailureNotBlocking(t *testing.T) {
	now := stubTime()
	var got []notification.Notification
	n := Emit(now, fullLoaders(now), func(x notification.Notification) { got = append(got, x) },
		func(store.DailyReport) error { return fmt.Errorf("disk full") })

	if n != 1 || len(got) != 1 {
		t.Fatalf("emit = %d (通知 %d), want 落档失败不影响 1 条投递", n, len(got))
	}
}

// TestEmit_ArchiveOnlyAddNil add 未注入而存档口在（补历史档形态）：只落档
// 不投递；两口全空则直接 0
func TestEmit_ArchiveOnlyAddNil(t *testing.T) {
	now := stubTime()
	var got []store.DailyReport
	n := Emit(now, fullLoaders(now), nil, func(r store.DailyReport) error {
		got = append(got, r)
		return nil
	})
	if n != 1 || len(got) != 1 {
		t.Fatalf("archive-only emit = %d (落档 %d), want 1", n, len(got))
	}

	if n := Emit(now, fullLoaders(now), nil, nil); n != 0 {
		t.Fatalf("no sink should emit 0, got %d", n)
	}
}
