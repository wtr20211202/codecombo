package share

import (
	"strings"
	"testing"
	"time"
)

// 访客页族拖拽导航守卫注入对账（P-20261122-20）：P-20261122-14 的守卫只生在
// 可写页 mountWritable 内且 writable/guestInput 双关早退——只读直播/定格/回放/
// 会话/文件页拖入本地文件仍被浏览器缺省导航到 file://（整页替换、视图丢失）。
// 本测试钉五页族都经 dragguard.go 单一事实源注入 scDragGuard（恰一次），且
// 直播页的注册点带 !SC.collab 闸 + 既有提示词表键；其余四页无协作位恒注册。
func TestDragGuardWireFivePages(t *testing.T) {
	type page struct {
		name   string
		render func() (string, error)
		want   []string
	}
	pages := []page{
		{
			name: "live-readonly",
			render: func() (string, error) {
				var b strings.Builder
				err := renderTermPage(&b, fixedToken("draglv1"), "zh", "live", "", false, false, false, false)
				return b.String(), err
			},
			// 直播页唯一注册点：collab 开时零注册（收件箱 drop 唯一语义），提示
			// 复用既有词表键（不新增字典项）
			want: []string{"scDragGuard({ enabled: !SC.collab, tip: t('wrDragNoUpload') });"},
		},
		{
			name: "terminal-frozen",
			render: func() (string, error) {
				var b strings.Builder
				err := renderTermFrozenPage(&b, fixedToken("dragfz1"), "zh", "frozen", "", false, false)
				return b.String(), err
			},
			want: []string{"scDragGuard();"},
		},
		{
			name: "cast",
			render: func() (string, error) {
				var b strings.Builder
				err := renderCastPage(&b, fixedToken("dragcs1"), "zh", "cast", "")
				return b.String(), err
			},
			want: []string{"scDragGuard();"},
		},
		{
			name: "session",
			render: func() (string, error) {
				var b strings.Builder
				err := renderSessionPage(&b, fixedToken("dragss1"), "zh", "session", "")
				return b.String(), err
			},
			want: []string{"scDragGuard();"},
		},
		{
			name: "file",
			render: func() (string, error) {
				var b strings.Builder
				err := renderSharePage(&b, fixedToken("dragfl1"), "zh", "", false,
					time.Time{}, time.Time{}, pageMeta{}, false)
				return b.String(), err
			},
			want: []string{"scDragGuard();"},
		},
	}
	shared := []string{
		"function scDragGuard(opts){",
		"if (opts.enabled === false) return;",  // collab 闸短路在注册之前
		"Array.from(ty).indexOf('Files') >= 0", // 仅 Files 载荷
		"document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });",
		"document.addEventListener('drop', (e) => {",
		"data-testid', 'drag-tip'", // 守卫自有提示面（与 .pu-tip 分桶）
	}
	for _, p := range pages {
		out, err := p.render()
		if err != nil {
			t.Fatalf("%s: render: %v", p.name, err)
		}
		for _, marker := range append(append([]string{}, shared...), p.want...) {
			if !strings.Contains(out, marker) {
				t.Fatalf("%s: missing drag-guard wire %q", p.name, marker)
			}
		}
		// 共享件恰注入一次：双注入 = 双监听（同一次投放双 preventDefault/双提示）
		if n := strings.Count(out, "function scDragGuard(opts){"); n != 1 {
			t.Fatalf("%s: guard helper must be injected exactly once, got %d", p.name, n)
		}
		// 注册点也恰一次（直播页用带 opts 的形态，其余四页无参形态）
		if n := strings.Count(out, "scDragGuard("); n != 2 { // 1 次函数声明 + 1 次调用
			t.Fatalf("%s: guard must be defined once and called once, got %d occurrences", p.name, n)
		}
	}
}

// 守卫的边界纪律（P-20261122-20）：提示与守卫分离——本件不引用各页词典 t()
// （直播页经 opts.tip 传既有键），缺省提示是依 SC.lang 的单源 zh/en 两串（不
// 往五页字典各拷一份）；且只读 types 表判定，绝不读文件字节（dataTransfer.files
// 不得出现——那是上传链的入口不是导航守卫的）。
func TestDragGuardSelfContained(t *testing.T) {
	for _, want := range []string{
		"SC.lang === 'zh'",
		"拖入的文件不会发送",
		"Dropped files are not sent",
	} {
		if !strings.Contains(guestDragGuardJS, want) {
			t.Fatalf("drag guard helper missing %q (built-in single-source tip)", want)
		}
	}
	if strings.Contains(guestDragGuardJS, "SC.dict") {
		t.Fatal("drag guard helper must not read per-page dict (tip comes via opts.tip)")
	}
	if strings.Contains(guestDragGuardJS, "dataTransfer.files") {
		t.Fatal("drag guard must only read dataTransfer.types — never file bytes")
	}
}
