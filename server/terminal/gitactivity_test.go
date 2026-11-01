package terminal

import (
	"strings"
	"testing"
	"time"
)

// TUI git 写活动嗅探（P-20261004-81）单测：模式命中（commit/push/switch 三族 +
// ANSI 噪声 + 跨包到达）/ 滑窗滚动 / 内容键去重与防抖 / 定向归属（载荷携
// 会话与项目、无项目归属短路）。用例经 collectGitActivity 挂 OnGitActivity
// 收集命中，测试结束复位——portdetect/sentinel 测试同款手法

// collectGitActivity 挂钩子收集命中，返回收集切片指针
func collectGitActivity(t *testing.T) *[]GitActivityHit {
	t.Helper()
	hits := &[]GitActivityHit{}
	prev := OnGitActivity
	OnGitActivity = func(hit GitActivityHit) {
		*hits = append(*hits, hit)
	}
	t.Cleanup(func() { OnGitActivity = prev })
	return hits
}

func TestGitActivity_PatternHits(t *testing.T) {
	hits := collectGitActivity(t)
	cases := []struct {
		name      string
		chunks    []string // 依次 feed 的输出片段（可拆块模拟跨包到达）
		wantKind  string
		wantRef   string
		wantCount int
	}{
		{
			name:      "commit 摘要行（裸输出）",
			chunks:    []string{"[main abc1234] Add feature\n"},
			wantKind:  GitActivityCommit,
			wantRef:   "main",
			wantCount: 1,
		},
		{
			name:      "commit root-commit 变体",
			chunks:    []string{"[main (root-commit) abc1234] Initial commit\n"},
			wantKind:  GitActivityCommit,
			wantRef:   "main",
			wantCount: 1,
		},
		{
			name:      "commit detached HEAD 变体",
			chunks:    []string{"[detached HEAD abc1234] wip\n"},
			wantKind:  GitActivityCommit,
			wantRef:   "detached HEAD",
			wantCount: 1,
		},
		{
			name:      "commit 摘要行（TUI 着色：SGR 割裂行首）",
			chunks:    []string{"\x1b[?25l\x1b[33mmain\x1b[0m\x1b[36mabc1234\x1b[0m\n"},
			wantKind:  "",
			wantRef:   "",
			wantCount: 0, // 伪装样本：缺 `] ` 结构不咬，防 TUI 重绘噪声误报
		},
		{
			name:      "commit 摘要行（真实着色形态：括号在颜色外）",
			chunks:    []string{"\x1b[1m[\x1b[36mfeature/x\x1b[0m def5678] do thing\x1b[0m\n"},
			wantKind:  GitActivityCommit,
			wantRef:   "feature/x",
			wantCount: 1,
		},
		{
			name:      "行中 [文字 hex] 形不咬（行首锚定）",
			chunks:    []string{"see [issue abc1234] for details\n"},
			wantKind:  "",
			wantRef:   "",
			wantCount: 0,
		},
		{
			name:      "push 引用区间行",
			chunks:    []string{"To github.com:foo/bar.git\n   abc1234..def5678  main -> main\n"},
			wantKind:  GitActivityPush,
			wantRef:   "main",
			wantCount: 1,
		},
		{
			name:      "push force 区间（三点 + forced update）",
			chunks:    []string{" + abc1234...def5678  main -> main (forced update)\n"},
			wantKind:  GitActivityPush,
			wantRef:   "main",
			wantCount: 1,
		},
		{
			name:      "fetch 推进远端跟踪引用（origin/x 目的地）",
			chunks:    []string{"   abc1234..def5678  main -> origin/main\n"},
			wantKind:  GitActivityPush,
			wantRef:   "origin/main",
			wantCount: 1,
		},
		{
			name:      "Everything up-to-date 不咬（无变化无刷新）",
			chunks:    []string{"Everything up-to-date\n"},
			wantKind:  "",
			wantRef:   "",
			wantCount: 0,
		},
		{
			name:      "switch 已有分支",
			chunks:    []string{"Switched to branch 'main'\n"},
			wantKind:  GitActivitySwitch,
			wantRef:   "main",
			wantCount: 1,
		},
		{
			name:      "switch 新建分支",
			chunks:    []string{"Switched to a new branch 'feature/go'\n"},
			wantKind:  GitActivitySwitch,
			wantRef:   "feature/go",
			wantCount: 1,
		},
		{
			name:      "跨包到达：commit 行拆在两次 feed 之间（滑窗聚合命中）",
			chunks:    []string{"[main abc", "1234] split line\n"},
			wantKind:  GitActivityCommit,
			wantRef:   "main",
			wantCount: 1,
		},
		{
			name:      "TUI 重绘噪声包裹（CSI 帧内嵌摘要行）",
			chunks:    []string{"\x1b[2J\x1b[H\x1b[38;5;244m~ \x1b[0m\n\x1b[32m[main abc1234]\x1b[0m real msg\n"},
			wantKind:  GitActivityCommit,
			wantRef:   "main",
			wantCount: 1,
		},
		{
			name:      "无预筛字符的输出（纯文本进度）整表跳过",
			chunks:    []string{"building 42%\ncompiling done 100\n"},
			wantKind:  "",
			wantRef:   "",
			wantCount: 0,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			*hits = nil
			d := newGitActivityDetector("term-1", "proj-1")
			for _, chunk := range tc.chunks {
				d.feed([]byte(chunk))
			}
			if len(*hits) != tc.wantCount {
				t.Fatalf("命中数 = %d, 期望 %d（hits=%+v）", len(*hits), tc.wantCount, *hits)
			}
			if tc.wantCount == 0 {
				return
			}
			h := (*hits)[0]
			if h.Kind != tc.wantKind || h.Ref != tc.wantRef {
				t.Fatalf("kind/ref = %q/%q, 期望 %q/%q", h.Kind, h.Ref, tc.wantKind, tc.wantRef)
			}
			// 定向归属：载荷携会话与项目（agent 据此感知「别的会话动了仓库」）
			if h.SessionID != "term-1" || h.ProjectID != "proj-1" {
				t.Fatalf("归属 = %q/%q, 期望 term-1/proj-1", h.SessionID, h.ProjectID)
			}
			if h.At.IsZero() {
				t.Fatal("At 未落时刻")
			}
		})
	}
}

func TestGitActivity_DedupAndDebounce(t *testing.T) {
	hits := collectGitActivity(t)
	d := newGitActivityDetector("term-1", "proj-1")
	d.debounce = 50 * time.Millisecond // 单测注入短窗口验证过期再报（sentinel 同款）

	d.feed([]byte("[main abc1234] c1\n"))
	if len(*hits) != 1 {
		t.Fatalf("首次命中应广播，实际 %d", len(*hits))
	}
	// 同一命中行驻留滑窗，后续任意输出重扫命中：内容键相同 → 不重播
	d.feed([]byte("TUI redraw noise ...\r\n"))
	if len(*hits) != 1 {
		t.Fatalf("同键重扫不应重播，实际 %d", len(*hits))
	}
	// 防抖窗内不同键（伪摘要行连发）→ 间隔闸压住
	d.feed([]byte("[main def5678] c2\n"))
	if len(*hits) != 1 {
		t.Fatalf("防抖窗内不同键不应广播，实际 %d", len(*hits))
	}
	// 防抖过期：新键广播
	time.Sleep(60 * time.Millisecond)
	d.feed([]byte("more noise\n"))
	if len(*hits) != 2 {
		t.Fatalf("防抖过期后新键应广播，实际 %d", len(*hits))
	}
	if (*hits)[1].Kind != GitActivityCommit || (*hits)[1].Ref != "main" {
		t.Fatalf("第二次命中 kind/ref = %q/%q", (*hits)[1].Kind, (*hits)[1].Ref)
	}
}

func TestGitActivity_NewestMatchWins(t *testing.T) {
	hits := collectGitActivity(t)
	d := newGitActivityDetector("term-1", "proj-1")
	d.debounce = 0 // 同块多事件场景：关闭间隔闸，专验「最新者胜」

	// 旧 commit 行与新 push 行同窗：push 更新（偏移更大）→ 只广播 push
	d.feed([]byte("[main abc1234] c1\n pushed: abc1234..def5678  main -> main\n"))
	if len(*hits) != 1 {
		t.Fatalf("同块多事件只广播最新一次，实际 %d（%+v）", len(*hits), *hits)
	}
	if (*hits)[0].Kind != GitActivityPush {
		t.Fatalf("应广播最新的 push，实际 %q", (*hits)[0].Kind)
	}
}

func TestGitActivity_SlidingWindowEviction(t *testing.T) {
	hits := collectGitActivity(t)
	d := newGitActivityDetector("term-1", "proj-1")
	d.debounce = 0

	// 命中行被大流量输出挤出滑窗后不再重扫命中（保尾部裁剪）
	d.feed([]byte("[main abc1234] c1\n"))
	filler := strings.Repeat("x", gitActivityWindowCap)
	d.feed([]byte(filler))
	if len(*hits) != 1 {
		t.Fatalf("仅首个命中应广播，实际 %d", len(*hits))
	}
	if strings.Contains(string(d.window), "abc1234") {
		t.Fatal("旧命中行应已被挤出滑窗")
	}
}

func TestGitActivity_NoProjectNoBroadcast(t *testing.T) {
	hits := collectGitActivity(t)
	// 无项目归属会话（纯 shell / 免项目 agent 会话）：feed 短路，不产生回调
	d := newGitActivityDetector("term-shell", "")
	d.feed([]byte("[main abc1234] c1\n"))
	if len(*hits) != 0 {
		t.Fatalf("无项目归属不应广播，实际 %d", len(*hits))
	}
}

func TestGitActivity_NilCallbackNoPanic(t *testing.T) {
	prev := OnGitActivity
	OnGitActivity = nil
	t.Cleanup(func() { OnGitActivity = prev })
	d := newGitActivityDetector("term-1", "proj-1")
	d.feed([]byte("[main abc1234] c1\n")) // 匹配照跑、命中不发布，不 panic
}

func TestGitActivity_OSCTitleNotMatched(t *testing.T) {
	// OSC 内容不参与匹配（P-20261005-8）：终端标题携带 push 区间行文案，
	// 修复前（滑窗只剥 CSI）标题原文留在匹配面会误报 push；修复后 OSC 整段
	// 剥除不触发。OSC 133 标记残片剥除后，紧随其后的摘要行恢复行首锚定、
	// 照常命中（修复前残片顶掉 \A 锚定反而漏报）
	hits := collectGitActivity(t)
	d := newGitActivityDetector("term-1", "proj-1")

	d.feed([]byte("\x1b]0;pushed abc1234..def5678  main -> main\x07"))
	if len(*hits) != 0 {
		t.Fatalf("OSC 标题不应触发 git 活动嗅探，得到 %v", *hits)
	}

	d.feed([]byte("\x1b]133;D;0\x07[main abc1234] Add feature\n"))
	if len(*hits) != 1 || (*hits)[0].Kind != GitActivityCommit || (*hits)[0].Ref != "main" {
		t.Fatalf("OSC 133 标记剥除后 commit 行应照常命中，得到 %v", *hits)
	}
}
