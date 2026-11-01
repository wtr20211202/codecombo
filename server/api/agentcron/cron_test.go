package agentcron

import (
	"strings"
	"testing"
	"time"

	"codecombo/server/store"
)

// 纯调度逻辑单测（P-20261002-43）：到期判定/错过判定/周几集合/下次运行预览/
// launchArgs 组装。全部本地时区纯函数，无存储依赖

func evalTask(hour, minute int, weekdays []int, lastRunAt time.Time) store.AgentCron {
	return store.AgentCron{
		ID: "sc_cron_x", Name: "t", Hour: hour, Minute: minute,
		Weekdays: weekdays, Enabled: true, LastRunAt: lastRunAt,
	}
}

func TestEvaluate_DueWithinWindow(t *testing.T) {
	// 槽点 02:00，巡检落在窗口 [02:00, 02:02) 内 → 到点
	slot := time.Date(2026, 10, 2, 2, 0, 0, 0, time.Local)
	for _, now := range []time.Time{
		slot,
		slot.Add(30 * time.Second),
		slot.Add(2*time.Minute - time.Second),
	} {
		ev := Evaluate(evalTask(2, 0, nil, time.Time{}), now)
		if !ev.Due || ev.Missed {
			t.Fatalf("now=%v expect Due, got %+v", now, ev)
		}
		if !ev.Slot.Equal(slot) {
			t.Fatalf("slot = %v, want %v", ev.Slot, slot)
		}
	}
}

func TestEvaluate_BeforeSlot(t *testing.T) {
	now := time.Date(2026, 10, 2, 1, 59, 59, 0, time.Local)
	ev := Evaluate(evalTask(2, 0, nil, time.Time{}), now)
	if ev.Due || ev.Missed {
		t.Fatalf("not yet due, got %+v", ev)
	}
}

func TestEvaluate_AlreadyRanToday(t *testing.T) {
	// 今日已跑（LastRunAt >= 今日槽点）→ 双 false：当日去重，跨重启语义
	slot := time.Date(2026, 10, 2, 2, 0, 0, 0, time.Local)
	for _, last := range []time.Time{slot, slot.Add(time.Minute), slot.Add(3 * time.Hour)} {
		ev := Evaluate(evalTask(2, 0, nil, last), slot.Add(10*time.Minute))
		if ev.Due || ev.Missed {
			t.Fatalf("already ran at %v, got %+v", last, ev)
		}
	}
	// 昨日跑过不算今日已跑
	yesterday := slot.AddDate(0, 0, -1)
	ev := Evaluate(evalTask(2, 0, nil, yesterday), slot.Add(30*time.Second))
	if !ev.Due {
		t.Fatalf("yesterday run should not dedupe today, got %+v", ev)
	}
}

func TestEvaluate_MissedPastWindow(t *testing.T) {
	// 越过到期窗口 → Missed（是否补跑由任务 MissCatchUp 决定，此处不判定）
	slot := time.Date(2026, 10, 2, 2, 0, 0, 0, time.Local)
	for _, now := range []time.Time{
		slot.Add(2 * time.Minute),
		slot.Add(2*time.Minute + time.Second),
		slot.Add(8 * time.Hour),
	} {
		ev := Evaluate(evalTask(2, 0, nil, time.Time{}), now)
		if ev.Due || !ev.Missed {
			t.Fatalf("now=%v expect Missed, got %+v", now, ev)
		}
	}
}

func TestWeekdayMatch(t *testing.T) {
	if !WeekdayMatch(nil, time.Sunday) || !WeekdayMatch([]int{}, time.Friday) {
		t.Fatal("empty weekday set means every day")
	}
	weekdays := []int{1, 3, 5} // 周一/周三/周五
	if !WeekdayMatch(weekdays, time.Monday) || !WeekdayMatch(weekdays, time.Wednesday) || !WeekdayMatch(weekdays, time.Friday) {
		t.Fatal("member days should match")
	}
	if WeekdayMatch(weekdays, time.Saturday) || WeekdayMatch(weekdays, time.Sunday) {
		t.Fatal("non-member days should not match")
	}
}

func TestNextRunAt(t *testing.T) {
	// 当日晚些时候
	now := time.Date(2026, 10, 2, 1, 0, 0, 0, time.Local) // 周五
	next := NextRunAt(2, 30, nil, now)
	want := time.Date(2026, 10, 2, 2, 30, 0, 0, time.Local)
	if !next.Equal(want) {
		t.Fatalf("next = %v, want %v", next, want)
	}
	// 当日已过 → 明日
	next = NextRunAt(1, 0, nil, now)
	want = time.Date(2026, 10, 3, 1, 0, 0, 0, time.Local)
	if !next.Equal(want) {
		t.Fatalf("next = %v, want %v", next, want)
	}
	// 仅周一：周五 → 下周一
	next = NextRunAt(9, 0, []int{1}, now)
	want = time.Date(2026, 10, 5, 9, 0, 0, 0, time.Local)
	if !next.Equal(want) {
		t.Fatalf("next = %v, want next Monday %v", next, want)
	}
	// 精确等于槽点 → 视为已过，取下一次
	exact := time.Date(2026, 10, 2, 2, 30, 0, 0, time.Local)
	next = NextRunAt(2, 30, nil, exact)
	want = time.Date(2026, 10, 3, 2, 30, 0, 0, time.Local)
	if !next.Equal(want) {
		t.Fatalf("next = %v, want %v", next, want)
	}
}

func TestComposeLaunchArgs(t *testing.T) {
	slot := time.Date(2026, 10, 2, 2, 0, 0, 0, time.Local)
	out := ComposeLaunchArgs("审查当日改动\n并出报告", slot)
	if strings.ContainsAny(out, "\n\r") {
		t.Fatalf("launch args must be single line, got %q", out)
	}
	if !strings.HasPrefix(out, "审查当日改动 并出报告 ") {
		t.Fatalf("prompt should be normalized to single line prefix, got %q", out)
	}
	if !strings.HasSuffix(out, "[scheduled 2026-10-02 02:00 "+slot.Format("-0700")+"]") {
		t.Fatalf("scheduled stamp missing, got %q", out)
	}
}

// ============== 运行时变量注入（P-20261003-167） ==============

func TestComposeLaunchArgs_Vars(t *testing.T) {
	// 2026-10-07 = 周三（Wednesday，与 TestNextRunAt 的 2026-10-02 周五锚互推一致）
	slot := time.Date(2026, 10, 7, 9, 5, 0, 0, time.Local)
	out := ComposeLaunchArgs("总结 {date}（{weekday}）的提交，截至 {time}", slot)
	if !strings.Contains(out, "总结 2026-10-07（Wednesday）的提交，截至 09:05") {
		t.Fatalf("three known vars should expand, got %q", out)
	}
	if strings.ContainsAny(out, "{}") {
		t.Fatalf("known tokens must be fully consumed, got %q", out)
	}
	// 值取槽点（非 now）：换一个槽点日期，{date} 跟随槽点
	other := slot.AddDate(0, 0, 1)
	out = ComposeLaunchArgs("{date}", other)
	if !strings.Contains(out, "2026-10-08") || strings.Contains(out, "2026-10-07") {
		t.Fatalf("{date} should follow the slot, got %q", out)
	}
}

func TestComposeLaunchArgs_UnknownVarsPassThrough(t *testing.T) {
	slot := time.Date(2026, 10, 7, 9, 5, 0, 0, time.Local)
	// 未知 token / 未知前缀（{dated} 不得被 {date} 规则部分替换）/ 空白 token /
	// 空 token / 孤立 { 全部原样透传：agent 读到未识别占位符即知模板笔误
	in := "{user} {dated} {dated} { } {} {unclosed"
	out := ComposeLaunchArgs(in, slot)
	for _, want := range []string{"{user}", "{dated}", "{ }", "{}", "{unclosed"} {
		if !strings.Contains(out, want) {
			t.Fatalf("unknown token %q must pass through verbatim, got %q", want, out)
		}
	}
	// 正文无已知变量：日期只在尾部 [scheduled] 后缀出现一次（后缀本就携带
	// 槽点日期，属既有语义，不算展开）
	if got := strings.Count(out, "2026-10-07"); got != 1 {
		t.Fatalf("date should appear only in the scheduled stamp, got %d occurrences: %q", got, out)
	}
	// 无 { 的 prompt 走快路径，行为与既有（单行化 + 后缀）完全一致
	out = ComposeLaunchArgs("审查当日改动", slot)
	if !strings.Contains(out, "审查当日改动 [scheduled 2026-10-07 09:05 ") {
		t.Fatalf("var-free prompt must keep existing shape, got %q", out)
	}
}

func TestComposeLaunchArgs_VarExpansionQuota(t *testing.T) {
	// 配额计注（P-20261003-167）：500 字节配额按存储态模板计（cronPromptMax
	// 保存口），展开发生在触发时且单枚增量有界——本测试锚定各枚展开值字节
	// 上限，防变量集/格式膨胀悄悄放大注入面配额口径
	slot := time.Date(2026, 10, 7, 9, 5, 0, 0, time.Local)
	// 单枚形态锚定：{date} → 10B（较 token 本身 +4B 为最坏增量）、{time} → 5B
	if out := ComposeLaunchArgs("{date}", slot); out != "2026-10-07 [scheduled 2026-10-07 09:05 "+slot.Format("-0700")+"]" {
		t.Fatalf("{date} exact composition drifted, got %q", out)
	}
	if v, ok := promptVar("time", slot); !ok || v != "09:05" || len(v) != 5 {
		t.Fatalf("{time} = %q, want fixed 5-byte HH:mm", v)
	}
	// {weekday} 全周最宽 ≤9B（Wednesday/Saturday/Sunday… 英文全名）
	sunday := time.Date(2026, 10, 4, 0, 0, 0, 0, time.Local)
	for d := 0; d < 7; d++ {
		day := sunday.AddDate(0, 0, d)
		if v, ok := promptVar("weekday", day); !ok || len(v) > 9 || v != day.Weekday().String() {
			t.Fatalf("weekday expansion %q (day %v) exceeds 9-byte bound or drifted", v, day.Weekday())
		}
	}
	// 配额满模板（498B，全由最坏增量枚 {date} 填充）展开后总量可预估：
	// 498 + 83×4（展开增量）+ 35（[scheduled] 后缀）——增量有界即注记成立
	tpl := strings.Repeat("{date}", 83)
	if len(tpl) > cronPromptMax {
		t.Fatalf("template itself must satisfy the stored-prompt quota")
	}
	out := ComposeLaunchArgs(tpl, slot)
	if want := len(tpl) + 83*4 + 35; len(out) != want {
		t.Fatalf("expanded length = %d, want bounded %d", len(out), want)
	}
}

// ============== 依赖链纯函数（P-20261003-124） ==============

func TestAfterModeAccepts(t *testing.T) {
	// 两档判定：success（默认/空值）= 仅父成功触发；always = 完成即触发
	cases := []struct {
		mode, status string
		want         bool
	}{
		{"", resultDone, true},
		{"", resultFailed, false},
		{store.CronAfterSuccess, resultDone, true},
		{store.CronAfterSuccess, resultFailed, false},
		{store.CronAfterAlways, resultDone, true},
		{store.CronAfterAlways, resultFailed, true},
		// 启动失败（error:）= 父任务从未执行，两档都不触发
		{store.CronAfterAlways, resultError + ": boom", false},
		{"", resultError + ": boom", false},
		// 非终态（launched / 空）不触发
		{"", resultLaunched, false},
		{store.CronAfterAlways, "", false},
	}
	for _, tc := range cases {
		if got := AfterModeAccepts(tc.mode, tc.status); got != tc.want {
			t.Fatalf("AfterModeAccepts(%q, %q) = %v, want %v", tc.mode, tc.status, got, tc.want)
		}
	}
}

func TestChainHasCycle(t *testing.T) {
	sched := store.AgentCron{ID: "A", Name: "定时", Trigger: store.CronTriggerSchedule}
	afterB := store.AgentCron{ID: "B", Name: "依赖A", Trigger: store.CronTriggerAfter, AfterCronID: "A"}
	afterC := store.AgentCron{ID: "C", Name: "依赖B", Trigger: store.CronTriggerAfter, AfterCronID: "B"}

	// 合法链：C→B→A(schedule)，新增 D→C 不成环
	valid := []store.AgentCron{sched, afterB, afterC}
	if ChainHasCycle(valid, "D", "C") {
		t.Fatal("D→C→B→A should not be a cycle")
	}

	// 指向自身（编辑任务选自己为父）
	if !ChainHasCycle(valid, "B", "B") {
		t.Fatal("self parent should be a cycle")
	}

	// 二环样例：把 A 也改为依赖 B（A→B 与 B→A 互指）——编辑 A 时上溯即回自身
	twoCycle := []store.AgentCron{
		{ID: "A", Trigger: store.CronTriggerAfter, AfterCronID: "B"},
		{ID: "B", Trigger: store.CronTriggerAfter, AfterCronID: "A"},
	}
	if !ChainHasCycle(twoCycle, "A", "B") {
		t.Fatal("A→B→A should be a cycle")
	}

	// 三环样例（经编辑逐步成环的终态）：C→B→C，编辑 B 时沿链两步回到自身
	threeCycle := []store.AgentCron{
		{ID: "B", Trigger: store.CronTriggerAfter, AfterCronID: "C"},
		{ID: "C", Trigger: store.CronTriggerAfter, AfterCronID: "B"},
	}
	if !ChainHasCycle(threeCycle, "B", "C") {
		t.Fatal("B→C→B should be a cycle")
	}

	// 脏数据里与 self 无关的既有环也要拒（visited 兜底防上溯死循环）
	if !ChainHasCycle(twoCycle, "X", "A") {
		t.Fatal("pre-existing cycle not involving self should be rejected")
	}

	// 父不存在：环检测不越权判存在性（false——存在性由 validateChain 另行报错）
	if ChainHasCycle(valid, "D", "missing") {
		t.Fatal("missing parent is not a cycle concern")
	}
	// 空父指向 = 定时任务保存，无环可言
	if ChainHasCycle(valid, "A", "") {
		t.Fatal("empty parent should short-circuit to false")
	}
}
