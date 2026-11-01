package agentcron

import (
	"strings"
	"testing"
	"time"

	"codecombo/server/store"
)

// 跨时区评估单测（P-20261005-217）：per-task timezone 字段的到期/错过判定、
// 下次运行预览与试跑时间戳。时区经 time.LoadLocation 解析（主程序内嵌
// time/tzdata，测试环境经 GOROOT zoneinfo / 系统 tzdata 均可加载）；锚点
// 时刻一律以「UTC 绝对时刻 + 任务时区壁钟」双向固定，防时区数据漂移翻车。

func tzOrDie(t *testing.T, name string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		t.Fatalf("LoadLocation(%q) failed: %v", name, err)
	}
	return loc
}

// evalInZone 带评估时区的任务（其余字段同 evalTask 惯例）
func evalInZone(hour, minute int, weekdays []int, lastRunAt time.Time, tz string) store.AgentCron {
	c := evalTask(hour, minute, weekdays, lastRunAt)
	c.Timezone = tz
	return c
}

func TestEvaluate_TaskTimezoneShiftsSlot(t *testing.T) {
	// 服务器 UTC、任务 Asia/Shanghai（UTC+8）：「每天 9 点」= UTC 01:00 到点
	// ——修复前按服务器本地（UTC）9 点评估，错 8 小时
	shanghai := tzOrDie(t, "Asia/Shanghai")
	// 2026-10-02T01:30:00Z = 上海壁钟 09:30（周五）
	nowUTC := time.Date(2026, 10, 2, 1, 30, 0, 0, time.UTC)
	if got := nowUTC.In(shanghai).Format("15:04 Monday"); got != "09:30 Friday" {
		t.Fatalf("test anchor drifted: %q", got)
	}

	// 窗口内：上海 09:00 槽点（= UTC 01:00）起 2 分钟内 → Due
	ev := Evaluate(evalInZone(9, 0, nil, time.Time{}, "Asia/Shanghai"), time.Date(2026, 10, 2, 1, 0, 30, 0, time.UTC))
	if !ev.Due || ev.Missed {
		t.Fatalf("UTC 01:00:30 should be Due for 09:00 Asia/Shanghai, got %+v", ev)
	}
	wantSlot := time.Date(2026, 10, 2, 9, 0, 0, 0, shanghai)
	if !ev.Slot.Equal(wantSlot) {
		t.Fatalf("slot = %v, want %v", ev.Slot, wantSlot)
	}

	// 服务器本地（UTC）的 9 点不再是到点：UTC 09:00 = 上海 17:00，早已越窗 → Missed
	ev = Evaluate(evalInZone(9, 0, nil, time.Time{}, "Asia/Shanghai"), time.Date(2026, 10, 2, 9, 0, 0, 0, time.UTC))
	if ev.Due || !ev.Missed {
		t.Fatalf("UTC 09:00 should be past-window Missed for 09:00 Asia/Shanghai, got %+v", ev)
	}

	// 反向：服务器上海、任务 UTC —— UTC 9 点槽 = 上海 17:00 到点
	ev = Evaluate(evalInZone(9, 0, nil, time.Time{}, "UTC"), time.Date(2026, 10, 2, 17, 0, 30, 0, shanghai))
	if !ev.Due || ev.Missed {
		t.Fatalf("Shanghai 17:00:30 should be Due for 09:00 UTC, got %+v", ev)
	}
}

func TestEvaluate_EmptyTimezoneIsServerLocal(t *testing.T) {
	// 空 timezone = 服务器本地（存量任务行为完全不变）：用本地时区锚点复验
	// 既有语义（与 cron_test.go 的本地用例同构，锚在 timezone 路径的分流上）
	now := time.Date(2026, 10, 2, 2, 0, 0, 0, time.Local)
	ev := Evaluate(evalInZone(2, 0, nil, time.Time{}, ""), now)
	if !ev.Due || ev.Missed {
		t.Fatalf("empty timezone must keep server-local semantics, got %+v", ev)
	}
	if !ev.Slot.Equal(now) {
		t.Fatalf("slot = %v, want local slot %v", ev.Slot, now)
	}
}

func TestEvaluate_WeekdayFollowsTaskTimezone(t *testing.T) {
	// 周几按任务时区日历：2026-10-02T16:30Z = 上海周六 00:30（UTC 仍是周五）。
	// 上海任务限定周五（5）→ 此刻已非生效日（双 false）；限定周六（6）→
	// 已越过周六 00:00 起的 9 点槽？——非也，周六 00:30 早于槽点 09:00，
	// 应为「未到点」双 false；两分支都不应因 UTC 周五而误判
	satEarlyShanghai := time.Date(2026, 10, 2, 16, 30, 0, 0, time.UTC)
	if got := satEarlyShanghai.In(time.UTC).Weekday(); got != time.Friday {
		t.Fatalf("test anchor drifted: UTC weekday %v", got)
	}

	ev := Evaluate(evalInZone(9, 0, []int{5}, time.Time{}, "Asia/Shanghai"), satEarlyShanghai)
	if ev.Due || ev.Missed {
		t.Fatalf("Shanghai Saturday should not match Friday-only task, got %+v", ev)
	}
	// 周六任务、周六 00:30（上海）——当日槽 09:00 未到
	ev = Evaluate(evalInZone(9, 0, []int{6}, time.Time{}, "Asia/Shanghai"), satEarlyShanghai)
	if ev.Due || ev.Missed {
		t.Fatalf("before-slot on a matching task-tz weekday should be pending, got %+v", ev)
	}
	// 周六 09:00:30（上海）= UTC 01:00:30 → 到点
	ev = Evaluate(evalInZone(9, 0, []int{6}, time.Time{}, "Asia/Shanghai"), time.Date(2026, 10, 3, 1, 0, 30, 0, time.UTC))
	if !ev.Due {
		t.Fatalf("Shanghai Saturday 09:00:30 should be Due, got %+v", ev)
	}
}

func TestEvaluate_LastRunAtDedupIsTimezoneAgnostic(t *testing.T) {
	// LastRunAt 是绝对时刻，与评估时区正交：上海 09:00 槽点（UTC 01:00）跑过
	// 之后，同槽不重跑（无论 now 落在窗口内多晚）
	shanghai := tzOrDie(t, "Asia/Shanghai")
	slotUTC := time.Date(2026, 10, 2, 1, 0, 0, 0, time.UTC)
	ev := Evaluate(evalInZone(9, 0, nil, slotUTC, "Asia/Shanghai"), slotUTC.Add(90*time.Second))
	if ev.Due || ev.Missed {
		t.Fatalf("already ran at the same absolute slot must dedupe, got %+v", ev)
	}
	// 昨日（上海日历）跑过不算今日：上海 10-02 09:00 跑过，now = 上海 10-03
	// 窗口内 → Due
	yesterdayShanghai := time.Date(2026, 10, 2, 9, 0, 0, 0, shanghai)
	ev = Evaluate(evalInZone(9, 0, nil, yesterdayShanghai, "Asia/Shanghai"),
		time.Date(2026, 10, 3, 1, 0, 30, 0, time.UTC))
	if !ev.Due {
		t.Fatalf("yesterday's Shanghai run must not dedupe today, got %+v", ev)
	}
}

func TestEvaluate_InvalidTimezoneFallsBackToLocal(t *testing.T) {
	// 非法时区名：保存口已拦，运行期兜底 = 服务器本地（旧语义），不崩调度
	now := time.Date(2026, 10, 2, 2, 0, 0, 0, time.Local)
	ev := Evaluate(evalInZone(2, 0, nil, time.Time{}, "Not/AZone"), now)
	if !ev.Due || ev.Missed {
		t.Fatalf("invalid timezone must fall back to server-local, got %+v", ev)
	}
}

func TestNextRunAt_TaskTimezone(t *testing.T) {
	shanghai := tzOrDie(t, "Asia/Shanghai")
	// 服务器 UTC 周五 03:00 = 上海周五 11:00；上海 09:00 已过 → 明日（上海周六）09:00
	now := time.Date(2026, 10, 2, 3, 0, 0, 0, time.UTC)
	next := NextRunAt(9, 0, nil, now.In(shanghai))
	want := time.Date(2026, 10, 3, 9, 0, 0, 0, shanghai)
	if !next.Equal(want) {
		t.Fatalf("next = %v, want %v", next, want)
	}
	if next.Format("-07:00") != "+08:00" {
		t.Fatalf("next must carry the task zone offset, got %q", next.Format("-07:00"))
	}
	// 上海周五 07:00（UTC 周四 23:00）：当日槽未到 → 今日 09:00（上海）
	now = time.Date(2026, 10, 1, 23, 0, 0, 0, time.UTC)
	next = NextRunAt(9, 0, nil, now.In(shanghai))
	want = time.Date(2026, 10, 2, 9, 0, 0, 0, shanghai)
	if !next.Equal(want) {
		t.Fatalf("next = %v, want %v", next, want)
	}
}

func TestEvaluate_DSTSpringForwardMissingSlot(t *testing.T) {
	// 纽约 2026-03-08 02:00 春令时交割：壁钟 02:30 不存在。Go 文档明确
	// 「交割两侧选哪侧不保证」（随平台 tz 数据实现）——故本测试只断言库无关
	// 不变量：解析出的槽点必落在交割当日的任务时区日历内、槽点窗口内照常
	// Due、同一绝对槽点跑过后窗口内不重跑（一致性，不漏判不双判）
	loc := tzOrDie(t, "America/New_York")
	slot := time.Date(2026, 3, 8, 2, 30, 0, 0, loc)
	wall := slot.In(loc)
	if wall.Year() != 2026 || wall.Month() != time.March || wall.Day() != 8 {
		t.Fatalf("normalized slot must stay on the transition day, got %v", wall)
	}
	ev := Evaluate(evalInZone(2, 30, nil, time.Time{}, "America/New_York"), slot.Add(30*time.Second))
	if !ev.Due || ev.Missed {
		t.Fatalf("normalized slot instant should be Due, got %+v", ev)
	}
	if !ev.Slot.Equal(slot) {
		t.Fatalf("slot = %v, want the same resolved instant %v", ev.Slot, slot)
	}
	// 该绝对槽点已跑：同槽去重（LastRunAt 绝对时刻语义跨交割成立）
	ev = Evaluate(evalInZone(2, 30, nil, slot, "America/New_York"), slot.Add(90*time.Second))
	if ev.Due || ev.Missed {
		t.Fatalf("ran slot must dedupe across the transition, got %+v", ev)
	}
}

func TestEvaluate_DSTFallBackAmbiguousSlot(t *testing.T) {
	// 纽约 2026-11-01 01:00 秋令时交割：壁钟 01:30 出现两次（EDT→EST）。
	// Go 文档同样不保证取哪次——断言库无关不变量：槽点落在交割日、首次
	// 判定 Due、该绝对槽点跑过后 +1h（第二次壁钟 01:30 或 02:30，无论解析
	// 取哪侧）都不得重跑——歧义壁钟的两个绝对时刻至多触发一次
	loc := tzOrDie(t, "America/New_York")
	slot := time.Date(2026, 11, 1, 1, 30, 0, 0, loc)
	wall := slot.In(loc)
	if wall.Year() != 2026 || wall.Month() != time.November || wall.Day() != 1 {
		t.Fatalf("ambiguous slot must stay on the transition day, got %v", wall)
	}
	ev := Evaluate(evalInZone(1, 30, nil, time.Time{}, "America/New_York"), slot.Add(time.Minute))
	if !ev.Due || ev.Missed {
		t.Fatalf("first evaluation should be Due, got %+v", ev)
	}
	// 该绝对槽点跑过后：第二次壁钟出现（+1h）不重跑
	ev = Evaluate(evalInZone(1, 30, nil, slot, "America/New_York"), slot.Add(90*time.Minute))
	if ev.Due || ev.Missed {
		t.Fatalf("second wall-clock occurrence must be deduped by absolute LastRunAt, got %+v", ev)
	}
}

func TestComposeLaunchArgs_FollowsTaskTimezone(t *testing.T) {
	// [scheduled] 后缀与 {date}/{time} 取任务时区壁钟（trigger 以
	// slot/now.In(任务时区) 传入）：上海槽点在服务器 UTC 语境下仍报上海时刻
	shanghai := tzOrDie(t, "Asia/Shanghai")
	slot := time.Date(2026, 10, 2, 9, 5, 0, 0, shanghai) // = UTC 01:05
	out := ComposeLaunchArgs("总结 {date} {time} 的改动", slot)
	if !strings.Contains(out, "总结 2026-10-02 09:05 的改动") {
		t.Fatalf("vars should expand in task-tz wall clock, got %q", out)
	}
	if !strings.Contains(out, "[scheduled 2026-10-02 09:05 +0800]") {
		t.Fatalf("scheduled stamp should carry task-tz offset, got %q", out)
	}
}
