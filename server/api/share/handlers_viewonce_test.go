package shareapi

// 一次性查看（P-20261006-27）管理 API 契约：
// 创建面 viewOnce 同参（file/snippet 收、frozen/terminal/terminal-frozen 400
// 拒——定格留证与持续流语义均与「看一眼即焚」相斥）、列表投影 viewOnce/
// consumed（consumed 由服务端判——宽限窗常量单点在 store，前端不复制判定）。

import (
	"net/http"
	"testing"
	"time"

	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// TestCreateShareViewOnceOnceFlagAndRejection 文件分享创建：viewOnce 落库
// 并回投影；frozen 模式与 viewOnce 组合 400（可编程感知，不静默吞标志）
func TestCreateShareViewOnceOnceFlagAndRejection(t *testing.T) {
	r := newAdminRouter(t)

	// live + viewOnce：200，data.viewOnce=true
	code, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt","viewOnce":true}`)
	if code != http.StatusOK {
		t.Fatalf("create viewOnce status = %d, body = %v", code, out)
	}
	data, _ := out["data"].(map[string]any)
	if data["viewOnce"] != true {
		t.Fatalf("viewOnce flag missing in response: %v", data)
	}

	// frozen + viewOnce：400（互斥——定格留证与即焚相斥）
	code, out = doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt","mode":"frozen","viewOnce":true}`)
	if code != http.StatusBadRequest {
		t.Fatalf("frozen+viewOnce status = %d, want 400, body = %v", code, out)
	}

	// frozen 不带 viewOnce：不受影响（既有语义零变化）
	code, out = doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt","mode":"frozen"}`)
	if code != http.StatusOK {
		t.Fatalf("frozen create status = %d, body = %v", code, out)
	}
	if data, _ := out["data"].(map[string]any); data["viewOnce"] == true {
		t.Fatalf("frozen record must not carry viewOnce: %v", data)
	}
}

// TestCreateTerminalViewOnceRejected 直播/快照形态显式拒绝 viewOnce
// （持续流与定格语义不支持一次性，400 而非静默忽略——agent 可编程分支；
// 校验前置于会话反查，session 不存在也轮不到 404）
func TestCreateTerminalViewOnceRejected(t *testing.T) {
	gin.SetMode(gin.TestMode)
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	live := gin.New()
	live.POST("/api/share/terminal", CreateTerminalLive)
	frozen := gin.New()
	frozen.POST("/api/share/terminal-frozen", CreateTerminalFrozen)

	code, out := doJSON(live, http.MethodPost, "/api/share/terminal", `{"sessionId":"no-such","viewOnce":true}`)
	if code != http.StatusBadRequest {
		t.Fatalf("terminal live viewOnce status = %d, want 400, body = %v", code, out)
	}
	code, out = doJSON(frozen, http.MethodPost, "/api/share/terminal-frozen", `{"sessionId":"no-such","viewOnce":true}`)
	if code != http.StatusBadRequest {
		t.Fatalf("terminal-frozen viewOnce status = %d, want 400, body = %v", code, out)
	}
}

// TestCreateSnippetViewOnceAndListProjection 片段创建 viewOnce 同参 +
// 列表投影：viewOnce 恒显（开了才带）、consumed 只在失效后出现（服务端按
// 记录+宽限窗判）
func TestCreateSnippetViewOnceAndListProjection(t *testing.T) {
	r := newAdminRouter(t)

	code, out := doJSON(r, http.MethodPost, "/api/share/snippet", `{"content":"once-only body","viewOnce":true}`)
	if code != http.StatusOK {
		t.Fatalf("snippet create status = %d, body = %v", code, out)
	}
	data, _ := out["data"].(map[string]any)
	if data["viewOnce"] != true {
		t.Fatalf("snippet viewOnce flag missing: %v", data)
	}
	token, _ := data["token"].(string)

	// 未消费：列表带 viewOnce、不带 consumed
	code, out = doJSON(r, http.MethodGet, "/api/share", "")
	if code != http.StatusOK {
		t.Fatalf("list status = %d", code)
	}
	row := findRow(t, out, token)
	if row == nil || row["viewOnce"] != true {
		t.Fatalf("list row missing viewOnce: %v", row)
	}
	if _, has := row["consumed"]; has {
		t.Fatalf("fresh viewOnce row must not carry consumed: %v", row)
	}

	// 武装并快进窗外（直接落库 ViewedAt=宽限窗之前——e2e 不可达面在单测
	// 覆盖）：列表投影 consumed=true，访客侧由 server/share 矩阵锚定
	if err := store.Get().Share.MarkFirstView(token, time.Now().Add(-store.ViewOnceGrace-time.Minute)); err != nil {
		t.Fatalf("mark first view: %v", err)
	}
	code, out = doJSON(r, http.MethodGet, "/api/share", "")
	if code != http.StatusOK {
		t.Fatalf("list status = %d", code)
	}
	row = findRow(t, out, token)
	if row == nil || row["consumed"] != true {
		t.Fatalf("consumed projection missing after grace window: %v", row)
	}
}

// findRow 在列表响应 data 数组里按 token 找行
func findRow(t *testing.T, out map[string]any, token string) map[string]any {
	t.Helper()
	list, _ := out["data"].([]any)
	for _, it := range list {
		if row, ok := it.(map[string]any); ok && row["token"] == token {
			return row
		}
	}
	return nil
}

// TestShareLookupForwardsFirstViewArm 装配契约：访客面 Service 的武装能力
// 取自 optional interface 断言（armViewOnce），shareLookup 必须把
// MarkFirstView 转发到 store。缺这条转发时一次性分享在真实装配下永远不
// 武装——确认页 POST 之后 ViewedAt 仍为零，内容页继续回确认页（P-20261020-3
// 的 e2e 会红）；包内单测用 armingShares 桩覆盖状态机，发现不了装配层
// 断链，故此处用真 store 锚定转发本身。
func TestShareLookupForwardsFirstViewArm(t *testing.T) {
	st := store.New(filestore.New(t.TempDir()))
	sh, err := st.Share.Create(store.Share{
		ProjectID: "p1", Name: "once.txt", Path: "once.txt", ViewOnce: true,
	})
	if err != nil {
		t.Fatalf("create view-once share: %v", err)
	}
	// 编译期即要求该能力在位：删掉方法时本测试直接构建失败，而不是静默
	// 退化成「访客面不武装」
	var armer interface {
		MarkFirstView(token string, at time.Time) error
	} = shareLookup{st: st}

	at := time.Now().Truncate(time.Second)
	if err := armer.MarkFirstView(sh.Token, at); err != nil {
		t.Fatalf("mark first view via adapter: %v", err)
	}
	got, err := st.Share.Get(sh.Token)
	if err != nil {
		t.Fatalf("reload share: %v", err)
	}
	if got.ViewedAt.IsZero() || !got.ViewedAt.Equal(at) {
		t.Fatalf("adapter must persist ViewedAt, got %v want %v", got.ViewedAt, at)
	}
}
