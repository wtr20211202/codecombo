package fsattr

import (
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"
	"codecombo/server/terminal"
)

// 归因引擎单测（P-20261005-170）：窗归属（含 D 后宽容尾）、重叠歧义全列、
// 编辑器标记优先与一次性消费、未归因诚实账、跨项目不串扰、范围过滤
// （skipDirs/原子写临时件）、相对路径换算、Record 全链落盘。会话清单走
// sessionsProvider 注入缝（裸构造会话直接挂窗数据，不起真实 PTY）。

// fakeSession 测试用会话投影（sessionsProvider 注入形态）：窗数据闭包直喂，
// 不经真实 PTY/探测器
func fakeSession(id, projectID, dir string, windows []terminal.CmdWindow) sessionRef {
	return sessionRef{ID: id, Name: id, ProjectID: projectID, Path: dir, windows: func() []terminal.CmdWindow { return windows }}
}

// withSessions 替换会话清单注入缝并收尾还原（测试串行，无并发互扰）
func withSessions(t *testing.T, sessions []sessionRef) {
	t.Helper()
	old := sessionsProvider
	sessionsProvider = func() []sessionRef { return sessions }
	t.Cleanup(func() { sessionsProvider = old })
}

// TestWindowCovers 窗归属判定：窗内命中 / 窗前不命中 / D 后宽容尾命中 /
// 宽容尾之外不命中 / Open 窗无上界命中
func TestWindowCovers(t *testing.T) {
	start := time.Now()
	end := start.Add(100 * time.Millisecond)
	closed := terminal.CmdWindow{Start: start, End: end, ExitCode: 0}
	open := terminal.CmdWindow{Start: start, Open: true}

	cases := []struct {
		name string
		w    terminal.CmdWindow
		at   time.Time
		want bool
	}{
		{"inside", closed, start.Add(50 * time.Millisecond), true},
		{"at-start", closed, start, true},
		{"before-start", closed, start.Add(-time.Millisecond), false},
		{"just-after-end", closed, end.Add(tailTolerance - 10*time.Millisecond), true},
		{"at-tail-edge", closed, end.Add(tailTolerance), true},
		{"beyond-tail", closed, end.Add(tailTolerance + 10*time.Millisecond), false},
		{"open-window-later", open, start.Add(time.Hour), true},
		{"open-window-before", open, start.Add(-time.Millisecond), false},
	}
	for _, tc := range cases {
		if got := windowCovers(tc.w, tc.at); got != tc.want {
			t.Fatalf("%s: windowCovers want %v got %v", tc.name, tc.want, got)
		}
	}
}

// TestBuildEventCommandAttribution 命令归因：事件落在窗内 → source=command，
// 会话名/命令摘要/窗时刻入账，相对路径换算正确
func TestBuildEventCommandAttribution(t *testing.T) {
	ws := []terminal.CmdWindow{{Start: time.Now().Add(-time.Second), Open: true, Command: "echo hi > f.txt"}}
	withSessions(t, []sessionRef{fakeSession("fsa-a", "proj-1", "D:/w/demo", ws)})
	at := ws[0].Start.Add(50 * time.Millisecond)

	ev := BuildEvent("proj-1", "D:/w/demo", "D:/w/demo/f.txt", "write", at)
	if ev.Source != store.FSAttributionCommand {
		t.Fatalf("want command attribution, got %q", ev.Source)
	}
	if ev.Path != "f.txt" || ev.Op != "write" {
		t.Fatalf("path/op want f.txt|write, got %q|%q", ev.Path, ev.Op)
	}
	if len(ev.Attributions) != 1 || ev.Attributions[0].TerminalID != "fsa-a" {
		t.Fatalf("want one attribution to fsa-a, got %+v", ev.Attributions)
	}
	if ev.Attributions[0].Command != "echo hi > f.txt" {
		t.Fatalf("command summary mismatch: %q", ev.Attributions[0].Command)
	}
	if !ev.Attributions[0].Running || ev.Overlap {
		t.Fatalf("single open window: running=true overlap=false, got running=%v overlap=%v",
			ev.Attributions[0].Running, ev.Overlap)
	}
}

// TestBuildEventOverlapMultiSession 多会话并行同项目重叠窗：归因全列 + 重叠标注
// （歧义如实呈现，不武断裁决）
func TestBuildEventOverlapMultiSession(t *testing.T) {
	shared := time.Now().Add(-time.Second)
	ws := []terminal.CmdWindow{
		{Start: shared, End: shared.Add(100 * time.Millisecond), ExitCode: 0},
	}
	withSessions(t, []sessionRef{
		fakeSession("fsa-a", "proj-1", "D:/w/demo", ws),
		fakeSession("fsa-b", "proj-1", "D:/w/demo", []terminal.CmdWindow{{Start: shared.Add(10 * time.Millisecond), End: shared.Add(110 * time.Millisecond)}}),
	})
	ev := BuildEvent("proj-1", "D:/w/demo", "D:/w/demo/g.txt", "write", shared.Add(50*time.Millisecond))
	if ev.Source != store.FSAttributionCommand || len(ev.Attributions) != 2 {
		t.Fatalf("overlapping windows must all be listed, got source=%q n=%d", ev.Source, len(ev.Attributions))
	}
	if !ev.Overlap {
		t.Fatalf("multi-window ambiguity must be flagged overlap")
	}
}

// TestBuildEventEditorMarkWins 编辑器标记优先：API 写路径恰逢他会长命令在跑
// 时归「编辑器」不归命令窗（自环过滤语义）；标记一次性消费，防 TTL 内重复
// 命中掩盖后续外部写
func TestBuildEventEditorMarkWins(t *testing.T) {
	ws := []terminal.CmdWindow{{Start: time.Now().Add(-time.Second), Open: true, Command: "npm run build"}}
	withSessions(t, []sessionRef{fakeSession("fsa-a", "proj-1", "D:/w/demo", ws)})

	abs := "D:/w/demo/saved.ts"
	NoteAPIWrite(abs)
	ev := BuildEvent("proj-1", "D:/w/demo", abs, "rename", time.Now())
	if ev.Source != store.FSAttributionEditor {
		t.Fatalf("editor mark must win over command window, got %q", ev.Source)
	}
	if len(ev.Attributions) != 0 {
		t.Fatalf("editor events carry no command attributions, got %+v", ev.Attributions)
	}

	ev2 := BuildEvent("proj-1", "D:/w/demo", abs, "write", time.Now())
	if ev2.Source != store.FSAttributionCommand {
		t.Fatalf("consumed mark must fall back to command attribution, got %q", ev2.Source)
	}
}

// TestBuildEventUnattributed 无窗无标记 = 未归因（诚实账，不虚构）
func TestBuildEventUnattributed(t *testing.T) {
	withSessions(t, []sessionRef{fakeSession("fsa-idle", "proj-1", "D:/w/demo", nil)})
	ev := BuildEvent("proj-1", "D:/w/demo", "D:/w/demo/x.go", "create", time.Now())
	if ev.Source != store.FSAttributionUnattributed {
		t.Fatalf("want unattributed, got %q", ev.Source)
	}
}

// TestBuildEventForeignProject 他项目会话的窗不错挂到本项目事件（会话 ProjectID
// 归属闸）
func TestBuildEventForeignProject(t *testing.T) {
	ws := []terminal.CmdWindow{{Start: time.Now().Add(-time.Second), Open: true}}
	withSessions(t, []sessionRef{fakeSession("fsa-other", "proj-2", "D:/w/other", ws)})
	ev := BuildEvent("proj-1", "D:/w/demo", "D:/w/demo/y.go", "write", time.Now())
	if ev.Source != store.FSAttributionUnattributed {
		t.Fatalf("foreign session window must not attribute, got %q", ev.Source)
	}
}

// TestSessionInProjectDirFallback 无主会话（ProjectID 空）按创建目录兜底归属
func TestSessionInProjectDirFallback(t *testing.T) {
	if !sessionInProject("D:/w/demo/sub", "", "p1", "D:/w/demo") {
		t.Fatalf("session dir under root must fall back into project")
	}
	if sessionInProject("D:/w/elsewhere", "", "p1", "D:/w/demo") {
		t.Fatalf("session dir outside root must not match")
	}
	if sessionInProject("D:/w/demo", "other", "p1", "D:/w/demo") {
		t.Fatalf("non-empty foreign ProjectID must not dir-match")
	}
}

// TestRelPath 相对路径换算：根外/根自身返回空串，嵌套正常剥前缀；Windows
// 宿主的反斜杠/混合形态同尺归一（前缀匹配与 watcher findProjectIDFast 同
// ToSlash 口径）。生产输入恒为同宿主形态（项目根与 watcher 事件同源本机
// fs），Linux 下 `\` 是合法文件名字符且原生 fs 永不产生——反斜杠归一断言
// 是 Windows 专属语义，按 GOOS 门控（跨平台硬跑会 false-fail，wsl-verify 实测）
func TestRelPath(t *testing.T) {
	if got := relPath("D:/w/demo", "D:/w/demo/a/b.ts"); got != "a/b.ts" {
		t.Fatalf("relPath nested want a/b.ts, got %q", got)
	}
	if got := relPath("D:/w/demo", "D:/w/demo"); got != "" {
		t.Fatalf("root itself must map to empty, got %q", got)
	}
	if got := relPath("D:/w/demo", "D:/other/x"); got != "" {
		t.Fatalf("outside root must map to empty, got %q", got)
	}
	if runtime.GOOS == "windows" {
		// 反斜杠根（原生形态）与混合形态（配置面正斜杠根 × 原生反斜杠事件）
		// 都经 ToSlash 归一到同一分隔符尺度
		if got := relPath(`D:\w\demo`, `D:\w\demo\a.ts`); got != "a.ts" {
			t.Fatalf("backslash roots must normalize, got %q", got)
		}
		if got := relPath("D:/w/demo", `D:\w\demo\a.ts`); got != "a.ts" {
			t.Fatalf("mixed separator forms must normalize, got %q", got)
		}
	}
}

// TestRecordable 范围过滤：skipDirs 子树与原子写临时件不入账（装依赖类副作用
// 如实声明不在界内），根下普通源文件入账
func TestRecordable(t *testing.T) {
	if recordable("D:/w/demo/node_modules/pkg/index.js") {
		t.Fatalf("node_modules subtree must be skipped")
	}
	if recordable("D:/w/demo/f.ts.sc-tmp-abc123") {
		t.Fatalf("atomic-write tmp files must be skipped")
	}
	if !recordable("D:/w/demo/src/main.go") {
		t.Fatalf("source files must be recorded")
	}
}

// TestRecordEndToEnd Record 全链：范围过滤 → 引擎判定 → 车道 1 落盘可查
// （真 filestore 文档仓，TempDir 隔离；全局 Store 换入换出）
func TestRecordEndToEnd(t *testing.T) {
	ws := []terminal.CmdWindow{{Start: time.Now().Add(-time.Second), Open: true, Command: "go test ./..."}}
	withSessions(t, []sessionRef{fakeSession("fsa-e2e", "proj-rec", "D:/w/rec", ws)})

	st := store.New(filestore.New(filepath.Join(t.TempDir(), "data")))
	old := store.Get()
	store.SetDefault(st)
	t.Cleanup(func() { store.SetDefault(old) })

	at := ws[0].Start.Add(50 * time.Millisecond)
	// node_modules 命中不落账；临时件不落账；源文件命中落账且归因命令
	Record("proj-rec", "D:/w/rec", "D:/w/rec/node_modules/x.js", "write", at)
	Record("proj-rec", "D:/w/rec", "D:/w/rec/main.go.sc-tmp-1a2b", "create", at)
	Record("proj-rec", "D:/w/rec", "D:/w/rec/main.go", "write", at)

	events, err := st.FSAttribution.Query("proj-rec", "", 10)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("want exactly 1 recorded event, got %d", len(events))
	}
	if events[0].Path != "main.go" || events[0].Source != store.FSAttributionCommand {
		t.Fatalf("recorded event mismatch: %+v", events[0])
	}
	if len(events[0].Attributions) != 1 || events[0].Attributions[0].Command != "go test ./..." {
		t.Fatalf("attribution mismatch: %+v", events[0].Attributions)
	}
}
