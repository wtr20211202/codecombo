package share

// 三形态访客页的留言区挂载回归（P-20261006-13）：共享资产 guestboard.go
// 经 {{.BoardCSS}}/{{.BoardJS}} 注入 page/termpage/termpagefrozen 三模板——
// 任一页漏接注入点（新页复制旧模板忘挂、重构删字段）即红

import (
	"strings"
	"testing"
	"time"
)

func TestGuestBoardAssetsInjectedAllPages(t *testing.T) {
	for name, fn := range map[string]func() (string, error){
		"file": func() (string, error) {
			var b strings.Builder
			err := renderSharePage(&b, fixedToken("render1"), "zh", "", false, time.Time{}, time.Time{}, pageMeta{}, false)
			return b.String(), err
		},
		"term-live": func() (string, error) {
			var b strings.Builder
			err := renderTermPage(&b, fixedToken("render2"), "zh", "live", "", false, false, false, false)
			return b.String(), err
		},
		"term-frozen": func() (string, error) {
			var b strings.Builder
			err := renderTermFrozenPage(&b, fixedToken("render3"), "zh", "frozen", "", false, false)
			return b.String(), err
		},
	} {
		out, err := fn()
		if err != nil {
			t.Fatalf("%s: render: %v", name, err)
		}
		for _, want := range []string{"gb-root", "mountGuestBoard", "gbTitle", "/s/' + SC.token + '/messages"} {
			if !strings.Contains(out, want) {
				t.Fatalf("%s page missing board asset %q", name, want)
			}
		}
	}
}

// TestTermPageCollabBootAndAssets 协作/输入位挂载回归（P-20261024-1，
// P-20261121-1 统一收编适配）：开关随 boot 下发的字段名（collab/guestInput/
// writable）与消费端（SC.collab/SC.guestInput/SC.writable）必须同键——boot
// 字段改名而消费端漏跟时对应位整体不挂载（e2e 曾因此假败），渲染级断言把
// 「开关开 → 页面含协作/输入位资产与 boot 键」钉死在单测层
func TestTermPageCollabBootAndAssets(t *testing.T) {
	var b strings.Builder
	// collab 开 + 申请通道开（缺省在场）+ 开放直入开
	if err := renderTermPage(&b, fixedToken("render4"), "zh", "live", "", true, true, false, true); err != nil {
		t.Fatalf("render: %v", err)
	}
	out := b.String()
	for _, want := range []string{
		`"collab":true`,     // boot 下发键（消费端 SC.collab 同名）
		`"guestInput":true`, // boot 下发键（申请通道缺省开——反向极性投影）
		`"writable":true`,   // boot 下发键（开放直入开关）
		"mountCollab",       // 协作位脚本已注入
		"mountWritable",     // 访客输入位脚本已注入（双模式合一）
		"wr-request",        // 申请批准路径申请按钮 testid（hold 模式产物）
		"cl-drop",           // 上传位拖放区 testid（素材上行产物）
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("term-live page (collab+input on) missing %q", want)
		}
	}
	// 直通位退役守卫（P-20261121-1）：旧 SC.directInput 键与 cl-direct-* testid
	// 不得再出现在页面（词表/UI 随统一收编迁 wr*）
	if strings.Contains(out, "directInput") || strings.Contains(out, "cl-direct-") {
		t.Fatalf("retired direct-input boot key / testid must be gone from term-live page")
	}
	// 全关（存量语义）：协作/输入资产仍注入模板但 boot 为假——页面脚本首行
	// 即退，零协作/输入位（资产注入是静态共享，不等于挂载；挂载由 boot 门控）
	var c strings.Builder
	if err := renderTermPage(&c, fixedToken("render5"), "zh", "live", "", false, false, false, false); err != nil {
		t.Fatalf("render off: %v", err)
	}
	out = c.String()
	if strings.Contains(out, `"collab":true`) || strings.Contains(out, `"guestInput":true`) || strings.Contains(out, `"writable":true`) {
		t.Fatalf("term-live page (switches off) boot must omit all flags")
	}
}
