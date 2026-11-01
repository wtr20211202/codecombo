package agentchain

import (
	"encoding/json"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"codecombo/server/api/opschannel"
	terminalapi "codecombo/server/api/terminal"
	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 触发引擎单测（P-20261004-38 ②③）：终态触发/档位/冷却重入/深度上限/源会话
// 存活校验/竞态与 chain.triggered 广播、审计、通知入账。launch/alive/now 全部
// 换桩，store 用真实 filestore（读改写路径一并覆盖）。

type engineEnv struct {
	e        *engine
	launched []string // 桩 launch 收到的 launchArgs（顺序即触发序）
	aliveIDs map[string]bool
	// launchedIDs 链拉起的会话 ID（桩 launch 产出——真实形态里这些会话在终端
	// 管理器在册即存活；aliveIDs 同键可显式翻 false 模拟会话关闭）
	launchedIDs []string
	now         time.Time
}

func newEnv(t *testing.T, seedNow time.Time) *engineEnv {
	t.Helper()
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	gin.SetMode(gin.TestMode)
	env := &engineEnv{
		aliveIDs: map[string]bool{"agent-A": true, "agent-B": true, "agent-C": true},
		now:      seedNow,
	}
	env.e = newEngine(
		func(name, runtime, dir, launchArgs string) (*terminalapi.AgentLaunch, error) {
			env.launched = append(env.launched, launchArgs)
			id := "agent-N" + strconv.Itoa(len(env.launched))
			env.launchedIDs = append(env.launchedIDs, id)
			return &terminalapi.AgentLaunch{ID: id, Name: "next-" + strconv.Itoa(len(env.launched)), Runtime: runtime}, nil
		},
		func(sessionID string) bool {
			if alive, ok := env.aliveIDs[sessionID]; ok {
				return alive
			}
			for _, id := range env.launchedIDs {
				if id == sessionID {
					return true
				}
			}
			return false
		},
	)
	env.e.now = func() time.Time { return env.now }
	return env
}

// withDefault 把引擎挂为包级装配（观察者入口经此取引擎）
func (env *engineEnv) withDefault(t *testing.T) {
	t.Helper()
	setDefaultEngine(env.e)
	t.Cleanup(func() { setDefaultEngine(nil) })
}

func (env *engineEnv) advance(d time.Duration) { env.now = env.now.Add(d) }

// fireChain 按真实流触发：引擎 fire 自身已在锁内重读链定义，这里只透传 ID
// （与 onTaskResult 同一口径）
func (env *engineEnv) fireChain(t *testing.T, id, terminalID, status, task, step string) bool {
	t.Helper()
	return env.e.fire(id, terminalID, status, task, step)
}

func report(terminalID, status, task, step string) {
	taskEventObserver(opschannel.Event{
		Type: opschannel.EventTaskProgress,
		Payload: map[string]any{
			"terminalId": terminalID, "status": status, "task": task, "step": step,
		},
	})
}

func mustCreateChain(t *testing.T, source, template string, onFailure bool) *store.AgentChain {
	t.Helper()
	ch, err := store.Get().AgentChain.Create(store.AgentChain{
		SourceTerminalID: source,
		PromptTemplate:   template,
		OnFailure:        onFailure,
		Runtime:          "shell",
	})
	if err != nil {
		t.Fatal(err)
	}
	return ch
}

// TestFire_DoneTriggersWithPlaceholders done 触发 + 占位符渲染 + 三面入账
// （链运行期事实 / chain.triggered 广播 / 审计 / 通知）
func TestFire_DoneTriggersWithPlaceholders(t *testing.T) {
	env := newEnv(t, time.Now())
	ch := mustCreateChain(t, "agent-A",
		"上一棒任务：{prevTask}（{prevStatus}），步骤：{prevStep}，请继续修复失败项", false)

	// chain.triggered 广播捕获（观察者同步分发，事件返回即达）
	triggered := make(chan map[string]any, 1)
	unsub := opschannel.AddObserver(func(ev opschannel.Event) {
		if ev.Type == opschannel.EventChainTriggered {
			b, _ := json.Marshal(ev.Payload)
			m := map[string]any{}
			_ = json.Unmarshal(b, &m)
			triggered <- m
		}
	})
	defer unsub()

	if !env.fireChain(t, ch.ID, "agent-A", "done", "跑测试", "3 个用例失败") {
		t.Fatal("done must fire the chain")
	}
	if len(env.launched) != 1 {
		t.Fatalf("launched %d times, want 1", len(env.launched))
	}
	if got := env.launched[0]; !strings.Contains(got, "上一棒任务：跑测试（done），步骤：3 个用例失败") {
		t.Fatalf("placeholders not rendered: %q", got)
	}
	if env.e.depthOf("agent-N1") != 2 {
		t.Fatalf("next session depth = %d, want 2", env.e.depthOf("agent-N1"))
	}

	// 广播载荷
	select {
	case m := <-triggered:
		if m["chainId"] != ch.ID || m["sourceTerminalId"] != "agent-A" || m["status"] != "done" || m["sessionId"] != "agent-N1" {
			t.Fatalf("chain.triggered payload mismatch: %v", m)
		}
	default:
		t.Fatal("chain.triggered not broadcast")
	}

	// 链运行期事实
	got, _ := store.Get().AgentChain.Get(ch.ID)
	if got.TriggerCount != 1 || got.LastSessionID != "agent-N1" || got.LastStatus != "launched" {
		t.Fatalf("chain facts not recorded: %+v", got)
	}

	// 审计入账
	events, _, err := store.Get().Audit.List(10, 0)
	if err != nil || len(events) == 0 {
		t.Fatalf("audit entries = %d, err %v", len(events), err)
	}
	if events[0].Action != store.AuditAgentChainTrigger || events[0].Result != store.AuditResultSuccess {
		t.Fatalf("audit entry mismatch: %+v", events[0])
	}

	// 通知入账（Action 直达下一棒）
	notifs := store.Get().Notification.List(10)
	if len(notifs) == 0 || notifs[0].Action != "terminal" || notifs[0].ActionPayload != "agent-N1" {
		t.Fatalf("notification not landed: %+v", notifs)
	}
	if notifs[0].TitleKey != "agentchain.notify.triggered.title" {
		t.Fatalf("notification titleKey = %q", notifs[0].TitleKey)
	}
}

// TestFire_FailedGate onFailure 档位：failed 默认不触发；开档触发
func TestFire_FailedGate(t *testing.T) {
	env := newEnv(t, time.Now())
	strict := mustCreateChain(t, "agent-A", "继续 {prevStatus}", false)
	always := mustCreateChain(t, "agent-A", "无论成败继续 {prevStatus}", true)

	if env.fireChain(t, strict.ID, "agent-A", "failed", "t", "s") {
		t.Fatal("onFailure=false must not fire on failed")
	}
	if !env.fireChain(t, always.ID, "agent-A", "failed", "t", "s") {
		t.Fatal("onFailure=true must fire on failed")
	}
	if len(env.launched) != 1 || !strings.Contains(env.launched[0], "无论成败继续 failed") {
		t.Fatalf("launch mismatch: %v", env.launched)
	}
	// done 对两档都触发
	if !env.fireChain(t, strict.ID, "agent-A", "done", "t", "s") {
		t.Fatal("onFailure=false must fire on done")
	}
}

// TestFire_DeadSourceInert 修正项：链源会话关闭/重启后链自动失效——触发匹配前
// 存活校验，死链不误触发、不记账
func TestFire_DeadSourceInert(t *testing.T) {
	env := newEnv(t, time.Now())
	ch := mustCreateChain(t, "agent-A", "继续", false)
	env.aliveIDs["agent-A"] = false // 源会话已关闭

	if env.fireChain(t, ch.ID, "agent-A", "done", "t", "s") {
		t.Fatal("dead source must not fire")
	}
	if len(env.launched) != 0 {
		t.Fatalf("dead source launched: %v", env.launched)
	}
	got, _ := store.Get().AgentChain.Get(ch.ID)
	if got.TriggerCount != 0 {
		t.Fatalf("dead source must not record trigger facts: %+v", got)
	}
}

// TestFire_Cooldown 同链冷却：终态抖动重入（冷却窗口内的第二次 done）不重复
// 拉起；窗口外再次完成照常接续
func TestFire_Cooldown(t *testing.T) {
	env := newEnv(t, time.Now())
	ch := mustCreateChain(t, "agent-A", "继续 {prevTask}", false)

	if !env.fireChain(t, ch.ID, "agent-A", "done", "任务一", "") {
		t.Fatal("first done must fire")
	}
	// 抖动重入：30 秒后的第二次 done（冷却窗口内）
	env.advance(30 * time.Second)
	if env.fireChain(t, ch.ID, "agent-A", "done", "任务一", "") {
		t.Fatal("in-cooldown re-entry must not fire")
	}
	// 窗口外：用户又派了新活，照常接续
	env.advance(31 * time.Second)
	if !env.fireChain(t, ch.ID, "agent-A", "done", "任务二", "") {
		t.Fatal("post-cooldown done must fire")
	}
	if len(env.launched) != 2 {
		t.Fatalf("launched %d times, want 2", len(env.launched))
	}
	if !strings.Contains(env.launched[1], "任务二") {
		t.Fatalf("second launch should carry fresh context: %q", env.launched[1])
	}
}

// TestFire_DepthCap 全局链深度上限：按真实接力形态——B/C 都是链拉起的会话，
// 用户在其上再建链即可续棒。A(1)→B(2)→C(3) 合法，C 的完成不可再接（第 4 棒被拒）
func TestFire_DepthCap(t *testing.T) {
	env := newEnv(t, time.Now())
	chainA := mustCreateChain(t, "agent-A", "A→next", false)

	// A done → B（深度 2，链拉起）
	if !env.fireChain(t, chainA.ID, "agent-A", "done", "", "") {
		t.Fatal("A must fire")
	}
	if env.e.depthOf("agent-N1") != 2 {
		t.Fatalf("B depth = %d, want 2", env.e.depthOf("agent-N1"))
	}
	// 用户在 B（agent-N1）上建链：B done → C（深度 3）
	chainB := mustCreateChain(t, "agent-N1", "B→next", false)
	if !env.fireChain(t, chainB.ID, "agent-N1", "done", "", "") {
		t.Fatal("B must fire（深度 2 < 上限 3）")
	}
	if env.e.depthOf("agent-N2") != 3 {
		t.Fatalf("C depth = %d, want 3", env.e.depthOf("agent-N2"))
	}
	// 用户在 C（agent-N2）上建链：C done → 拒（深度已到上限）
	chainC := mustCreateChain(t, "agent-N2", "C→next", false)
	if env.fireChain(t, chainC.ID, "agent-N2", "done", "", "") {
		t.Fatal("depth cap must stop the relay")
	}
	if len(env.launched) != 2 {
		t.Fatalf("launched %d times, want 2", len(env.launched))
	}
}

// TestObserver_PayloadGates 观察者入口载荷闸：非 task.progress / 非终态 /
// 缺 terminalId 静默；终态进入触发链
func TestObserver_PayloadGates(t *testing.T) {
	env := newEnv(t, time.Now())
	env.withDefault(t)
	mustCreateChain(t, "agent-A", "继续", false)

	// 非本链事件 / running 中间态 / 缺 terminalId：全部静默
	taskEventObserver(opschannel.Event{Type: "notify", Payload: map[string]any{"terminalId": "agent-A", "status": "done"}})
	report("agent-A", "running", "t", "s")
	report("", "done", "t", "s")
	if len(env.launched) != 0 {
		t.Fatalf("gated events must not launch: %v", env.launched)
	}

	// 引擎未装配（模块停机）时观察者空转不 panic
	setDefaultEngine(nil)
	report("agent-A", "done", "t", "s")
}

// TestFire_ConcurrentReentry 触发竞态：同源终态并发到达（ops-notify 并发
// HTTP），闸判定与记账同锁串行——只拉起一次（编排器注记：触发竞态以单测钉死）
func TestFire_ConcurrentReentry(t *testing.T) {
	env := newEnv(t, time.Now())
	ch := mustCreateChain(t, "agent-A", "继续", false)

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			env.e.onTaskResult("agent-A", "done", "t", "s")
		}()
	}
	wg.Wait()
	if len(env.launched) != 1 {
		t.Fatalf("concurrent same-source events launched %d times, want 1", len(env.launched))
	}
	got, _ := store.Get().AgentChain.Get(ch.ID)
	if got.TriggerCount != 1 {
		t.Fatalf("trigger count = %d, want 1", got.TriggerCount)
	}
}

// TestFire_LaunchFailed 发起失败：error 记账 + 失败审计 + 失败通知；冷却照记
// （防失败风暴重入）
func TestFire_LaunchFailed(t *testing.T) {
	env := newEnv(t, time.Now())
	ch := mustCreateChain(t, "agent-A", "继续", false)
	env.e.launch = func(name, runtime, dir, launchArgs string) (*terminalapi.AgentLaunch, error) {
		return nil, errString("runtime claude is not installed")
	}

	if env.fireChain(t, ch.ID, "agent-A", "done", "", "") {
		t.Fatal("launch failure must not count as fired")
	}
	got, _ := store.Get().AgentChain.Get(ch.ID)
	if got.TriggerCount != 1 || got.LastStatus != "error: runtime claude is not installed" {
		t.Fatalf("failure facts not recorded: %+v", got)
	}
	events, _, _ := store.Get().Audit.List(10, 0)
	if len(events) != 1 || events[0].Result != store.AuditResultFailure {
		t.Fatalf("failure audit missing: %+v", events)
	}
	notifs := store.Get().Notification.List(10)
	if len(notifs) != 1 || notifs[0].TitleKey != "agentchain.notify.failed.title" {
		t.Fatalf("failure notification missing: %+v", notifs)
	}
	// 冷却照记：窗口内同源再报 done 不再重试（防失败风暴）
	if env.fireChain(t, ch.ID, "agent-A", "done", "", "") {
		t.Fatal("in-cooldown retry after launch failure must be gated")
	}
}

// TestExpandPrompt_Quota 配额收敛：占位符渲染 + 超配额时变量值裁剪、模板正文
// 与 status 保真
func TestExpandPrompt_Quota(t *testing.T) {
	// 基本渲染
	got := ExpandPrompt("任务：{prevTask}（{prevStatus}）步骤：{prevStep}", "跑测试", "done", "3 失败")
	if got != "任务：跑测试（done）步骤：3 失败" {
		t.Fatalf("render mismatch: %q", got)
	}
	// 未知占位符透传
	if got := ExpandPrompt("未知 {nope} 原样", "t", "done", "s"); !strings.Contains(got, "{nope}") {
		t.Fatalf("unknown placeholder must pass through: %q", got)
	}
	// 超配额：长任务名被裁、模板正文与 done 保真、总长 ≤500
	longTask := strings.Repeat("长", 600)
	out := ExpandPrompt("上一棒：{prevTask}（{prevStatus}）请继续", longTask, "done", "")
	if len(out) > 500 {
		t.Fatalf("expanded prompt = %d bytes, want <= 500", len(out))
	}
	if !strings.Contains(out, "（done）请继续") {
		t.Fatalf("template/status must survive fit: %q", out)
	}
	if !strings.Contains(out, "…") {
		t.Fatalf("truncated value should be marked: %q", out)
	}
	// 单行化：多行模板/值折叠空格（launchArgs 经 PTY 注入，换行=回车提交）
	if got := ExpandPrompt("行一\n行二 {prevTask}", "a\nb", "done", ""); strings.Contains(got, "\n") {
		t.Fatalf("must be single-line: %q", got)
	}
}

// TestValidateChainPayload 创建校验：必填/字节上限/运行时白名单/目录存在性
func TestValidateChainPayload(t *testing.T) {
	cases := []struct {
		mutate func(*store.AgentChain)
		want   string
	}{
		{func(c *store.AgentChain) { c.SourceTerminalID = "" }, "sourceTerminalId is required"},
		{func(c *store.AgentChain) { c.PromptTemplate = "" }, "promptTemplate is required"},
		{func(c *store.AgentChain) { c.PromptTemplate = strings.Repeat("x", 501) }, "promptTemplate too long (max 500 bytes)"},
		{func(c *store.AgentChain) { c.Runtime = "nope" }, "unknown runtime"},
		{func(c *store.AgentChain) { c.Dir = "Z:/definitely/not/exist" }, "dir does not exist"},
	}
	for i, tc := range cases {
		ch := store.AgentChain{SourceTerminalID: "agent-1", PromptTemplate: "p"}
		tc.mutate(&ch)
		if got := validateChainPayload(&ch); got != tc.want {
			t.Fatalf("case %d: got %q, want %q", i, got, tc.want)
		}
	}
	// 合法形态零报错
	ch := store.AgentChain{SourceTerminalID: "agent-1", PromptTemplate: "p", Runtime: "auto"}
	if got := validateChainPayload(&ch); got != "" {
		t.Fatalf("valid payload rejected: %q", got)
	}
}

// TestSourceSessionName 元数据缺失降级：无 meta 显示会话 ID（通知文案不谎称）
func TestSourceSessionName(t *testing.T) {
	_ = newEnv(t, time.Now()) // 顺带装配 store
	if got := sourceSessionName("agent-ghost"); got != "agent-ghost" {
		t.Fatalf("fallback = %q, want raw id", got)
	}
	if err := store.Get().AgentSession.Save(store.AgentSessionMeta{
		ID: "agent-A", Name: "跑测试的会话",
	}); err != nil {
		t.Fatal(err)
	}
	if got := sourceSessionName("agent-A"); got != "跑测试的会话" {
		t.Fatalf("name = %q, want meta name", got)
	}
}

// errString 轻量 error（errors.New 别名，免 import 面）
type errString string

func (e errString) Error() string { return string(e) }
