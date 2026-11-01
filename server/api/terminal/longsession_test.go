package terminal

import (
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"codecombo/server/filestore"
	"codecombo/server/notification"
	"codecombo/server/store"
	"codecombo/server/terminal"
)

// setupNotifyTest 构造 store 装配（通知入账走真实 store；出站口未装配时
// 仅落库不广播——单测只断言落库结果）
func setupNotifyTest(t *testing.T) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })
}

// longSessionNotifications 取通知中心内 titleKey 命中长会话模板的条目
func longSessionNotifications(t *testing.T) []notification.Notification {
	t.Helper()
	list := store.Get().Notification.List(0)
	out := make([]notification.Notification, 0, len(list))
	for _, n := range list {
		if n.TitleKey == longSessionTitleKey {
			out = append(out, n)
		}
	}
	return out
}

// TestLongSessionGate 退出提醒闸门真值表：agent 标识 / 纯 shell 不发 /
// 退出码与时长阈值判定（P-20261002-140 单测锚点）
func TestLongSessionGate(t *testing.T) {
	threshold := 5 * time.Minute
	long := threshold + time.Minute
	cases := []struct {
		name        string
		kind        string
		runtimeName string
		launched    bool
		exitCode    int
		elapsed     time.Duration
		want        bool
	}{
		{"agent+运行时长+正常退出", terminal.KindAgent, "claude", true, 0, long, true},
		{"阈值边界：恰等于阈值", terminal.KindAgent, "claude", true, 0, threshold, true},
		{"时长不足阈值", terminal.KindAgent, "claude", true, 0, threshold - time.Second, false},
		{"异常退出不打扰（完成提醒只认正常退出）", terminal.KindAgent, "claude", true, 1, long, false},
		{"纯 shell 一等选项不发", terminal.KindAgent, agentRuntimeShell, true, 0, long, false},
		{"选型降级（launched=false）不发", terminal.KindAgent, "", false, 0, long, false},
		{"项目终端不发（维持异常退出语义）", terminal.KindShell, "claude", true, 0, long, false},
	}
	for _, c := range cases {
		if got := longSessionGate(c.kind, c.runtimeName, c.launched, c.exitCode, c.elapsed, threshold); got != c.want {
			t.Fatalf("%s: longSessionGate = %v, want %v", c.name, got, c.want)
		}
	}
}

// TestLongSessionExitNotify 钩子主体全链：闸门通过入账（模板键/参数在位）、
// 纯 shell 与选型降级静默、P-15 已上报终态去重静默
func TestLongSessionExitNotify(t *testing.T) {
	setupNotifyTest(t)

	fire := func(sessionID string, createdAt time.Time, runtimeName string, launched bool) {
		s := &terminal.Session{ID: sessionID, Name: "会话" + sessionID, Kind: terminal.KindAgent, CreatedAt: createdAt}
		handleAgentSessionExit(s, runtimeName, launched, 0)
	}

	// ① agent 会话时长达标正常退出 → 入账一条，模板键与 MsgParams 在位
	base := time.Now().Add(-10 * time.Minute)
	fire("agent-ls-1", base, "claude", true)
	got := longSessionNotifications(t)
	if len(got) != 1 {
		t.Fatalf("expected 1 long-session notification, got %d", len(got))
	}
	if got[0].Type != "success" || got[0].Category != notification.CategoryTask {
		t.Fatalf("unexpected type/category: %s/%s", got[0].Type, got[0].Category)
	}
	if got[0].MsgParams["name"] != "会话agent-ls-1" {
		t.Fatalf("MsgParams name = %v", got[0].MsgParams["name"])
	}
	// MsgParams 经落库 JSON 往返，数值读回为 float64
	if m, ok := got[0].MsgParams["minutes"].(float64); !ok || m < 10 || m > 11 {
		t.Fatalf("MsgParams minutes = %v, want 10 or 11", got[0].MsgParams["minutes"])
	}

	// ② 纯 shell（runtimeName=shell）静默：同条件不入账
	fire("agent-ls-shell", base, agentRuntimeShell, true)
	// ③ 选型降级（launched=false）静默
	fire("agent-ls-degraded", base, "", false)

	// ④ P-15 去重：智能体已上报 done（SessionID 带运行时会话后缀的前缀形态）
	// → 退出钩子沉默
	if err := store.Get().AgentTask.Append(store.AgentTask{Type: "task.progress", Status: "done", SessionID: "agent-ls-15 uuid-1", At: base.Add(time.Second)}); err != nil {
		t.Fatal(err)
	}
	fire("agent-ls-15", base, "claude", true)

	if n := len(longSessionNotifications(t)); n != 1 {
		t.Fatalf("expected still 1 notification after shell/degraded/dedup cases, got %d", n)
	}
}

// TestLongSessionNotifyDisabledCategory 通知偏好关掉 task 类 → Add 入口拦截
func TestLongSessionNotifyDisabledCategory(t *testing.T) {
	setupNotifyTest(t)
	p := store.Get().Notification.GetPrefs()
	p.Enabled[notification.CategoryTask] = false
	if err := store.Get().Notification.SavePrefs(p); err != nil {
		t.Fatal(err)
	}
	notifyLongSessionDone("agent-ls-off", "off 会话", 10*time.Minute)
	if n := len(longSessionNotifications(t)); n != 0 {
		t.Fatalf("task category disabled: expected 0 notifications, got %d", n)
	}
}
