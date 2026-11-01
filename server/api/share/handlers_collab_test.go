package shareapi

// 协作通道管理面测试（P-20261024-1）：开关动作端点（collab/direct-input）、
// 收件清单与消费语义（drops/consume/delete）、直通握手 owner 半边的拒绝面。
// 复用 handlers_test.go 的 newAdminRouter 装配（临时 store + 种子项目）。

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/share"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

func newCollabRouter(t *testing.T) *gin.Engine {
	t.Helper()
	r := newAdminRouter(t)
	r.POST("/api/share/:token/collab", SetShareCollab)
	r.POST("/api/share/:token/direct-input", SetShareDirectInput)
	r.GET("/api/share/:token/drops", ListShareDrops)
	r.POST("/api/share/:token/drops/:id/consume", ConsumeShareDrop)
	r.DELETE("/api/share/:token/drops/:id", DeleteShareDrop)
	r.POST("/api/share/:token/direct/approve", ApproveShareDirect)
	r.POST("/api/share/:token/direct/revoke", RevokeShareDirect)
	r.GET("/api/share/:token/direct", GetShareDirect)
	return r
}

// seedDrop 预置一条素材（隔离区直写：本体 + sidecar；上传端点的单测在
// server/share 层已锁，这里只验管理面投影）
func seedDrop(t *testing.T, token, id, name, content string) (fileName, absPath string) {
	t.Helper()
	dir := filepath.Join(share.DropsRoot(), token)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir drop dir: %v", err)
	}
	fileName = id + "_" + name
	absPath = filepath.Join(dir, fileName)
	if err := os.WriteFile(absPath, []byte(content), 0o600); err != nil {
		t.Fatalf("write drop body: %v", err)
	}
	meta, _ := json.Marshal(map[string]any{
		"id": id, "fileName": fileName, "name": name,
		"size": len(content), "kind": "file", "at": time.Now(),
	})
	if err := os.WriteFile(absPath+".json", meta, 0o600); err != nil {
		t.Fatalf("write drop sidecar: %v", err)
	}
	return fileName, absPath
}

func TestSetShareCollabEndpoint(t *testing.T) {
	r := newCollabRouter(t)

	// 创建（file 形态缺省关）
	code, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt"}`)
	if code != http.StatusOK {
		t.Fatalf("create = %d", code)
	}
	token := out["data"].(map[string]any)["token"].(string)
	if out["data"].(map[string]any)["collab"] != false {
		t.Fatalf("new share must default collab off: %v", out)
	}

	// 开启：响应投影 collab=true，落库一致
	code, out = doJSON(r, http.MethodPost, "/api/share/"+token+"/collab", `{"collab":true}`)
	if code != http.StatusOK {
		t.Fatalf("collab on = %d: %v", code, out)
	}
	if out["data"].(map[string]any)["collab"] != true {
		t.Fatalf("collab projection = %v", out)
	}
	rec, err := store.Get().Share.Get(token)
	if err != nil || !rec.Collab {
		t.Fatalf("collab not persisted: %+v err=%v", rec, err)
	}

	// 关闭：回收（记录仍在，字段归零）
	code, out = doJSON(r, http.MethodPost, "/api/share/"+token+"/collab", `{"collab":false}`)
	if code != http.StatusOK || out["data"].(map[string]any)["collab"] != false {
		t.Fatalf("collab off = %d %v", code, out)
	}

	// 未知 token → 404
	if code, _ := doJSON(r, http.MethodPost, "/api/share/nope0123456789ab/collab", `{"collab":true}`); code != http.StatusNotFound {
		t.Fatalf("unknown token = %d, want 404", code)
	}
}

func TestSetShareDirectInputEndpoint(t *testing.T) {
	r := newCollabRouter(t)
	code, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt"}`)
	if code != http.StatusOK {
		t.Fatalf("create = %d", code)
	}
	token := out["data"].(map[string]any)["token"].(string)

	// 开启缺 confirm → 400（管理面摩擦是硬闸，agent/脚本不可静默开启）
	if code, _ := doJSON(r, http.MethodPost, "/api/share/"+token+"/direct-input", `{"on":true}`); code != http.StatusBadRequest {
		t.Fatalf("missing confirm = %d, want 400", code)
	}
	// file 形态（无会话锚点）→ 400（直通输入只对 terminal 直播可开）
	if code, _ := doJSON(r, http.MethodPost, "/api/share/"+token+"/direct-input", `{"on":true,"confirm":true}`); code != http.StatusBadRequest {
		t.Fatalf("non-terminal share = %d, want 400", code)
	}

	// terminal 形态（直通锚定会话）：经 store 直建记录（CreateTerminalLive
	// 需要存活会话，本测试只验开关面）
	created, err := store.Get().Share.Create(store.Share{
		Kind: store.ShareKindTerminal, TerminalID: "agent-x", Name: "live",
	})
	if err != nil {
		t.Fatalf("seed terminal share: %v", err)
	}
	tok2 := created.Token
	code, out = doJSON(r, http.MethodPost, "/api/share/"+tok2+"/direct-input", `{"on":true,"confirm":true}`)
	if code != http.StatusOK || out["data"].(map[string]any)["directInput"] != true {
		t.Fatalf("direct on = %d %v", code, out)
	}
	// 关闭（回收方向不需要 confirm）
	code, out = doJSON(r, http.MethodPost, "/api/share/"+tok2+"/direct-input", `{"on":false}`)
	if code != http.StatusOK || out["data"].(map[string]any)["directInput"] != false {
		t.Fatalf("direct off = %d %v", code, out)
	}
}

func TestShareDropsManagement(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	r := newCollabRouter(t)
	code, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt"}`)
	if code != http.StatusOK {
		t.Fatalf("create = %d", code)
	}
	token := out["data"].(map[string]any)["token"].(string)
	fileName, absPath := seedDrop(t, token, "1", "report.txt", "R")

	// 清单：绝对路径在主人侧在场（贴进会话动作链的取数点）
	code, out = doJSON(r, http.MethodGet, "/api/share/"+token+"/drops", "")
	if code != http.StatusOK {
		t.Fatalf("list drops = %d", code)
	}
	list := out["data"].([]any)
	if len(list) != 1 {
		t.Fatalf("drops = %v", out)
	}
	d0 := list[0].(map[string]any)
	if d0["id"] != "1" || d0["name"] != "report.txt" {
		t.Fatalf("drop projection = %v", d0)
	}
	if abs, _ := d0["absPath"].(string); abs == "" || !strings.HasSuffix(filepath.ToSlash(abs), "/"+fileName) {
		t.Fatalf("absPath wrong: %q (fileName=%s)", abs, fileName)
	}
	if _, err := os.Stat(absPath); err != nil {
		t.Fatalf("absPath not statable: %v", err)
	}

	// 消费标记：200 + 幂等（幂等性由 server/share 层锁定，这里验对外 200）
	if code, _ := doJSON(r, http.MethodPost, "/api/share/"+token+"/drops/1/consume", ""); code != http.StatusOK {
		t.Fatalf("consume = %d", code)
	}
	if code, _ := doJSON(r, http.MethodPost, "/api/share/"+token+"/drops/1/consume", ""); code != http.StatusOK {
		t.Fatalf("consume idempotent = %d", code)
	}
	// 未知素材 → 404
	if code, _ := doJSON(r, http.MethodPost, "/api/share/"+token+"/drops/nope/consume", ""); code != http.StatusNotFound {
		t.Fatalf("consume unknown = %d, want 404", code)
	}
	// 单删：幂等
	if code, _ := doJSON(r, http.MethodDelete, "/api/share/"+token+"/drops/1", ""); code != http.StatusOK {
		t.Fatalf("delete = %d", code)
	}
	if code, _ := doJSON(r, http.MethodDelete, "/api/share/"+token+"/drops/1", ""); code != http.StatusOK {
		t.Fatalf("delete idempotent = %d", code)
	}
	_, out = doJSON(r, http.MethodGet, "/api/share/"+token+"/drops", "")
	if len(out["data"].([]any)) != 0 {
		t.Fatalf("drops after delete = %v", out)
	}
	// 未知分享的清单 → 404
	if code, _ := doJSON(r, http.MethodGet, "/api/share/nope0123456789ab/drops", ""); code != http.StatusNotFound {
		t.Fatalf("unknown share drops = %d, want 404", code)
	}
}

func TestDirectApproveRejections(t *testing.T) {
	r := newCollabRouter(t)
	// 直通未开启的分享：批准 → 400
	code, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt"}`)
	if code != http.StatusOK {
		t.Fatalf("create = %d", code)
	}
	token := out["data"].(map[string]any)["token"].(string)
	if code, _ := doJSON(r, http.MethodPost, "/api/share/"+token+"/direct/approve", `{}`); code != http.StatusBadRequest {
		t.Fatalf("approve on non-direct share = %d, want 400", code)
	}
	// 未知分享 → 404
	if code, _ := doJSON(r, http.MethodPost, "/api/share/nope0123456789ab/direct/approve", `{}`); code != http.StatusNotFound {
		t.Fatalf("approve unknown = %d, want 404", code)
	}
	// terminal 分享 + 直通开启，但会话不存在 → 404（无可授权的源）
	created, err := store.Get().Share.Create(store.Share{
		Kind: store.ShareKindTerminal, TerminalID: "ghost", Name: "live2",
	})
	if err != nil {
		t.Fatalf("seed terminal share: %v", err)
	}
	tok2 := created.Token
	if code, _ := doJSON(r, http.MethodPost, "/api/share/"+tok2+"/direct-input", `{"on":true,"confirm":true}`); code != http.StatusOK {
		t.Fatalf("direct on = %d", code)
	}
	if code, _ := doJSON(r, http.MethodPost, "/api/share/"+tok2+"/direct/approve", `{}`); code != http.StatusNotFound {
		t.Fatalf("approve with dead session = %d, want 404", code)
	}
	// 状态投影：enabled=true，session.alive=false
	code, out = doJSON(r, http.MethodGet, "/api/share/"+tok2+"/direct", "")
	if code != http.StatusOK {
		t.Fatalf("direct status = %d", code)
	}
	data := out["data"].(map[string]any)
	if data["enabled"] != true {
		t.Fatalf("enabled projection = %v", data)
	}
	if sess, ok := data["session"].(map[string]any); !ok || sess["alive"] != false {
		t.Fatalf("session projection = %v", data)
	}
	// 收回幂等（无持权也成功；shareSvc 装配后 503 降级面消失）
	shareSvc = share.NewService(store.Get().Share, fakeRootsNoop{}, nil)
	t.Cleanup(func() { shareSvc = nil })
	if code, out2 := doJSON(r, http.MethodPost, "/api/share/"+tok2+"/direct/revoke", ""); code != http.StatusOK || out2["data"].(map[string]any)["had"] != false {
		t.Fatalf("revoke idempotent = %d %v", code, out2)
	}
}

// fakeRootsNoop ProjectRoots 空实现（直通路径不触项目根解析）
type fakeRootsNoop struct{}

func (fakeRootsNoop) RootOf(string) (string, error) { return "", os.ErrNotExist }
