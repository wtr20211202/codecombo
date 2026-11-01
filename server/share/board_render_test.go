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
			err := renderTermPage(&b, fixedToken("render2"), "zh", "live", "", false, false)
			return b.String(), err
		},
		"term-frozen": func() (string, error) {
			var b strings.Builder
			err := renderTermFrozenPage(&b, fixedToken("render3"), "zh", "frozen", "", false)
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

// TestTermPageCollabBootAndAssets 协作位挂载回归（P-20261024-1）：开关随 boot
// 下发的字段名（collab/directInput）与 collabpage.go 消费端（SC.collab/
// SC.directInput）必须同键——boot 字段改名而消费端漏跟时直通位整体不挂载
//（e2e 曾因此假败：cl-root/cl-drop 在而 cl-direct-request 永不出现），渲染级
// 断言把「开关开 → 页面含协作位资产与 boot 键」钉死在单测层
func TestTermPageCollabBootAndAssets(t *testing.T) {
	var b strings.Builder
	if err := renderTermPage(&b, fixedToken("render4"), "zh", "live", "", true, true); err != nil {
		t.Fatalf("render: %v", err)
	}
	out := b.String()
	for _, want := range []string{
		`"collab":true`,      // boot 下发键（消费端 SC.collab 同名）
		`"directInput":true`, // boot 下发键（消费端 SC.directInput 同名——回归锚）
		"mountCollab",        // 协作位脚本已注入
		"cl-direct-request",  // 直通位申请按钮 testid（wantDirect 分支产物）
		"cl-drop",            // 上传位拖放区 testid（wantUpload 分支产物）
		"!!SC.directInput",   // 消费端键名与 boot 键对账（曾因读 SC.direct 恒
		// undefined 致直通位永不挂载、e2e 假败——键名漂移在这里红）
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("term-live page (collab+direct on) missing %q", want)
		}
	}
	// 旧 bug 形态守卫：消费端不得出现裸 SC.direct 读取（!!SC.direct; 与
	// !!SC.directInput; 可区分——direct 后是词字符时不构成前者）
	if strings.Contains(out, "!!SC.direct;") {
		t.Fatalf("collab script reads nonexistent boot key SC.direct (must be SC.directInput)")
	}
	// 双关（存量语义）：协作资产仍注入模板但 boot 为假——页面脚本首行即退，
	// 零协作位（资产注入是静态共享，不等于挂载；挂载由 boot 门控）
	var c strings.Builder
	if err := renderTermPage(&c, fixedToken("render5"), "zh", "live", "", false, false); err != nil {
		t.Fatalf("render off: %v", err)
	}
	out = c.String()
	if strings.Contains(out, `"collab":true`) || strings.Contains(out, `"directInput":true`) {
		t.Fatalf("term-live page (switches off) boot must omit both flags")
	}
}
