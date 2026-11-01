package notification

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

// 长会话提醒阈值归一化（P-20261002-140）：存量偏好零值回落默认、越界钳制
func TestClampLongSessionSec(t *testing.T) {
	cases := []struct {
		in   int
		want int
	}{
		{0, DefaultLongSessionNotifySec},     // 存量零值回落默认
		{-5, DefaultLongSessionNotifySec},    // 负值同上（部分合并回传零值场景）
		{1, minLongSessionNotifySec},         // 低于下限钳到下限
		{10, 10},                             // 边界内原样
		{300, 300},                           // 默认值原样
		{25 * 3600, maxLongSessionNotifySec}, // 超上限钳到 24h
	}
	for _, c := range cases {
		if got := ClampLongSessionSec(c.in); got != c.want {
			t.Fatalf("ClampLongSessionSec(%d) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestPrefsLongSessionThreshold(t *testing.T) {
	// 存量偏好（无该字段的零值）→ 默认 5 分钟
	if got := (Prefs{}).LongSessionThreshold(); got != 5*time.Minute {
		t.Fatalf("zero prefs threshold = %v, want 5m", got)
	}
	// 显式值 → duration 视图
	if got := (Prefs{LongSessionNotifySec: 60}).LongSessionThreshold(); got != time.Minute {
		t.Fatalf("60s threshold = %v, want 1m", got)
	}
	// 越界值 → 钳制视图
	if got := (Prefs{LongSessionNotifySec: 1}).LongSessionThreshold(); got != 10*time.Second {
		t.Fatalf("1s threshold = %v, want 10s floor", got)
	}
	// 默认偏好 → 300s
	if got := DefaultPrefs().LongSessionNotifySec; got != DefaultLongSessionNotifySec {
		t.Fatalf("DefaultPrefs longSessionNotifySec = %d, want %d", got, DefaultLongSessionNotifySec)
	}
}

// 项目×类别二维静音判定与清单归一（P-20261003-168）：命中二维组合才静音，
// 空 projectId/category 恒不静音；写入端归一去空项/去重/封顶
func TestPrefsProjectMute(t *testing.T) {
	p := Prefs{ProjectMutes: []ProjectMute{
		{ProjectID: "p1", Category: CategoryGit},
		{ProjectID: "p1", Category: CategoryTask},
		{ProjectID: "p2", Category: CategoryGit},
	}}
	if !p.IsProjectMuted("p1", CategoryGit) {
		t.Fatal("p1×git should be muted")
	}
	if !p.IsProjectMuted("p2", CategoryGit) {
		t.Fatal("p2×git should be muted")
	}
	// 同项目异类别 / 异项目同类别都不命中——二维是 AND 语义
	if p.IsProjectMuted("p1", CategoryClone) {
		t.Fatal("p1×clone should not be muted")
	}
	if p.IsProjectMuted("p3", CategoryGit) {
		t.Fatal("p3×git should not be muted")
	}
	// 存量偏好（零值清单）与空维度恒不静音
	if (Prefs{}).IsProjectMuted("p1", CategoryGit) {
		t.Fatal("empty mutes should not mute")
	}
	if p.IsProjectMuted("", CategoryGit) || p.IsProjectMuted("p1", "") {
		t.Fatal("empty project/category should never mute")
	}

	// 归一：空项剔除 + 去重保序
	got := NormalizeProjectMutes([]ProjectMute{
		{ProjectID: " a ", Category: " git "},
		{ProjectID: "", Category: "git"},
		{ProjectID: "a", Category: ""},
		{ProjectID: "a", Category: "git"},
		{ProjectID: "b", Category: "task"},
	})
	want := []ProjectMute{{ProjectID: "a", Category: "git"}, {ProjectID: "b", Category: "task"}}
	if len(got) != len(want) {
		t.Fatalf("NormalizeProjectMutes len = %d, want %d (%v)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("NormalizeProjectMutes[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}
	// 全空输入 → nil（omitempty 语义一致）
	if NormalizeProjectMutes([]ProjectMute{{}}) != nil {
		t.Fatal("all-empty input should normalize to nil")
	}
	if NormalizeProjectMutes(nil) != nil {
		t.Fatal("nil input should normalize to nil")
	}
	// 封顶：超出 ProjectMuteMax 的尾部裁掉
	many := make([]ProjectMute, 0, ProjectMuteMax+5)
	for i := 0; i < ProjectMuteMax+5; i++ {
		many = append(many, ProjectMute{ProjectID: fmt.Sprintf("p%d", i), Category: "git"})
	}
	if got := NormalizeProjectMutes(many); len(got) != ProjectMuteMax {
		t.Fatalf("capped len = %d, want %d", len(got), ProjectMuteMax)
	}
}

// 会话花费阈值归一化（P-20261003-157）：与长会话阈值不同，0 = 关（合法默认档）
// 而非回落默认开；低于下限钳到下限、超上限钳到上限
func TestClampSpendTokens(t *testing.T) {
	cases := []struct {
		in   int
		want int
	}{
		{0, 0},                        // 关（默认档，存量偏好零值即关）
		{-5, 0},                       // 负值同关
		{1, minSpendAlertTokens},      // 低于下限钳到下限
		{99_999, minSpendAlertTokens}, // 边界下
		{100_000, 100_000},            // 下限原样
		{5_000_000, 5_000_000},        // 边界内原样
		{2 * maxSpendAlertTokens, maxSpendAlertTokens}, // 超上限钳到上限
	}
	for _, c := range cases {
		if got := ClampSpendTokens(c.in); got != c.want {
			t.Fatalf("ClampSpendTokens(%d) = %d, want %d", c.in, got, c.want)
		}
	}
	// 存量偏好零值 = 关
	if got := (Prefs{}).ClaudeSpendAlertTokens; got != 0 {
		t.Fatalf("zero prefs spend tokens = %d, want 0 (off)", got)
	}
}

// 第二动作字段序列化兼容（P-20261005-150）：新生产方落两槽、旧记录无字段——
// omitempty 保证零值不落 JSON（旧读方零噪声），旧 JSON 缺字段反序列化零值安全
// （升级兼容纪律：无迁移、无清数据）
func TestNotificationSecondActionSerialization(t *testing.T) {
	// 新记录：两槽齐落
	full := Notification{ID: "n1", Action: "terminal", ActionPayload: "term-1",
		SecondAction: "agent-fix", SecondActionPayload: "sentinel:term-1"}
	b, err := json.Marshal(full)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{`"secondAction":"agent-fix"`, `"secondActionPayload":"sentinel:term-1"`} {
		if !strings.Contains(string(b), key) {
			t.Fatalf("marshal missing %s: %s", key, b)
		}
	}
	// 旧记录（字段出现前落盘）：无键 → 零值，读方不渲染副钮
	var old Notification
	if err := json.Unmarshal([]byte(`{"id":"n0","action":"terminal","actionPayload":"term-0"}`), &old); err != nil {
		t.Fatalf("unmarshal old: %v", err)
	}
	if old.SecondAction != "" || old.SecondActionPayload != "" {
		t.Fatalf("old record second action = %q/%q, want empty", old.SecondAction, old.SecondActionPayload)
	}
	// 未携第二动作的零值 marshal 不产生键（存量读方面零噪声）
	plain, err := json.Marshal(Notification{ID: "n2", Action: "panel", ActionPayload: "changes"})
	if err != nil {
		t.Fatalf("marshal plain: %v", err)
	}
	if strings.Contains(string(plain), "secondAction") {
		t.Fatalf("zero value must omit secondAction: %s", plain)
	}
}
