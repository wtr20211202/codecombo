package shareapi

// 冻结分享原地刷新（P-20261005-177）handler 流：同 token 换内容（已分发链接
// 全部继续有效）、TTL 重置、敏感扫描对新副本跑一遍（命中未确认拦下且旧副本
// 保留）、体积护栏拒绝保旧副本、非 frozen 记录 400、目标已删 404 保旧副本

import (
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

// refreshFrozen 播种一条 note.txt 冻结分享并返回记录（各用例共用起点）
func refreshFrozen(t *testing.T, r *gin.Engine) map[string]any {
	t.Helper()
	code, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt","mode":"frozen"}`)
	if code != http.StatusOK {
		t.Fatalf("seed frozen create status = %d, body = %v", code, out)
	}
	data, _ := out["data"].(map[string]any)
	if data == nil {
		t.Fatalf("seed create missing data: %v", out)
	}
	return data
}

func TestRefreshShareHappyPath(t *testing.T) {
	r := newFrozenRouter(t)
	seeded := refreshFrozen(t, r)
	token, _ := seeded["token"].(string)

	// 项目内继续改：刷新前访客读到的仍是旧定格内容
	p, err := store.Get().Project.GetByID("p1")
	if err != nil {
		t.Fatalf("get project: %v", err)
	}
	if err := os.WriteFile(filepath.Join(p.Path, "note.txt"), []byte("changed-v2"), 0o644); err != nil {
		t.Fatal(err)
	}
	snap := filepath.Join(share.SnapshotsRoot(), frozenNative("p1", "note.txt"), "note.txt")
	if b, err := os.ReadFile(snap); err != nil || string(b) != "hello" {
		t.Fatalf("pre-refresh copy wrong: %v %q", err, b)
	}

	code, out := doJSON(r, http.MethodPost, "/api/share/"+token+"/refresh", "")
	if code != http.StatusOK {
		t.Fatalf("refresh status = %d, body = %v", code, out)
	}
	data, _ := out["data"].(map[string]any)
	if data == nil {
		t.Fatalf("refresh missing data: %v", out)
	}
	// token 不变（保 token 换内容的分发友好语义——外发链接继续有效）
	if data["token"] != token {
		t.Fatalf("token changed on refresh: %v vs %v", data["token"], token)
	}
	if data["frozen"] != true {
		t.Fatalf("frozen flag lost: %v", out)
	}
	// 副本内容已换新
	if b, err := os.ReadFile(snap); err != nil || string(b) != "changed-v2" {
		t.Fatalf("refreshed copy wrong: %v %q", err, b)
	}
	// 大小快照随新副本刷新（幂等创建分支既有语义）
	if s, _ := data["size"].(float64); int(s) != len("changed-v2") {
		t.Fatalf("size = %v, want %d", data["size"], len("changed-v2"))
	}
	// TTL 重置：新 30 天保留窗口（±1 分钟容差）
	expiresAt, _ := time.Parse(time.RFC3339, toString(data["expiresAt"]))
	if d := time.Until(expiresAt); d > store.FrozenTTL || d < store.FrozenTTL-time.Minute {
		t.Fatalf("ttl after refresh = %v, want ~%v", d, store.FrozenTTL)
	}
	// 暂存目录不残留
	if _, err := os.Stat(filepath.Join(share.SnapshotsRoot(), frozenNative("p1", "note.txt")+".staging")); !os.IsNotExist(err) {
		t.Fatal("staging dir must be gone after promote")
	}
}

func TestRefreshShareGuardKeepsOldCopy(t *testing.T) {
	r := newFrozenRouter(t)
	seeded := refreshFrozen(t, r)
	token, _ := seeded["token"].(string)

	// 源文件膨胀过单份护栏（截断到目标大小，不真写 200MB）
	p, err := store.Get().Project.GetByID("p1")
	if err != nil {
		t.Fatalf("get project: %v", err)
	}
	f, err := os.Create(filepath.Join(p.Path, "note.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(share.MaxFrozenBytes + 1); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()

	code, out := doJSON(r, http.MethodPost, "/api/share/"+token+"/refresh", "")
	if code != http.StatusRequestEntityTooLarge {
		t.Fatalf("guard status = %d, body = %v", code, out)
	}
	if msg, _ := out["error"].(string); !strings.Contains(msg, "share too large to freeze") {
		t.Fatalf("stable marker missing: %v", out)
	}
	// 旧副本原样（拒绝刷新绝不弄瞎既有链——访客面继续读旧定格内容）
	snap := filepath.Join(share.SnapshotsRoot(), frozenNative("p1", "note.txt"), "note.txt")
	if b, err := os.ReadFile(snap); err != nil || string(b) != "hello" {
		t.Fatalf("old copy must survive rejected refresh: %v %q", err, b)
	}
	// 暂存半成品不留盘
	if _, err := os.Stat(filepath.Join(share.SnapshotsRoot(), frozenNative("p1", "note.txt")+".staging")); !os.IsNotExist(err) {
		t.Fatal("rejected refresh must roll back staging")
	}
	// 记录未被动过（大小仍为旧副本的 5 字节）
	code2, out2 := doJSON(r, http.MethodGet, "/api/share", "")
	if code2 != http.StatusOK {
		t.Fatalf("list status = %d", code2)
	}
	list, _ := out2["data"].([]any)
	if len(list) != 1 {
		t.Fatalf("list len = %d", len(list))
	}
	row, _ := list[0].(map[string]any)
	if s, _ := row["size"].(float64); int(s) != len("hello") {
		t.Fatalf("size after rejected refresh = %v, want unchanged", row["size"])
	}
}

func TestRefreshShareScanGate(t *testing.T) {
	r := newFrozenRouter(t)
	p, err := store.Get().Project.GetByID("p1")
	if err != nil {
		t.Fatalf("get project: %v", err)
	}
	// 干净目录播种冻结链
	if err := os.MkdirAll(filepath.Join(p.Path, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(p.Path, "docs", "a.md"), []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	code, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"docs","mode":"frozen"}`)
	if code != http.StatusOK {
		t.Fatalf("create status = %d, body = %v", code, out)
	}
	data, _ := out["data"].(map[string]any)
	token, _ := data["token"].(string)

	// 源里混入敏感文件后刷新：命中拦下（不给 data），旧副本原样、暂存丢弃
	if err := os.WriteFile(filepath.Join(p.Path, "docs", ".env"), []byte("K=1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(p.Path, "docs", "a.md"), []byte("v2"), 0o644); err != nil {
		t.Fatal(err)
	}
	code2, out2 := doJSON(r, http.MethodPost, "/api/share/"+token+"/refresh", "")
	if code2 != http.StatusOK {
		t.Fatalf("blocked refresh status = %d, body = %v", code2, out2)
	}
	if _, has := out2["data"]; has {
		t.Fatalf("scan hit must not refresh: %v", out2)
	}
	warnings, _ := out2["warnings"].([]any)
	if len(warnings) == 0 {
		t.Fatalf("warnings missing: %v", out2)
	}
	snapA := filepath.Join(share.SnapshotsRoot(), frozenNative("p1", "docs"), "docs", "a.md")
	if b, err := os.ReadFile(snapA); err != nil || string(b) != "v1" {
		t.Fatalf("old copy must survive blocked refresh: %v %q", err, b)
	}
	if _, err := os.Stat(filepath.Join(share.SnapshotsRoot(), frozenNative("p1", "docs"), "docs", ".env")); !os.IsNotExist(err) {
		t.Fatal("unconfirmed refresh must not leak new sensitive file")
	}
	// override 二次请求：新副本顶上（含被确认暴露的敏感文件——创建语义同款）
	code3, out3 := doJSON(r, http.MethodPost, "/api/share/"+token+"/refresh", `{"override":true}`)
	if code3 != http.StatusOK {
		t.Fatalf("override refresh status = %d, body = %v", code3, out3)
	}
	if d, _ := out3["data"].(map[string]any); d == nil || d["token"] != token {
		t.Fatalf("override refresh broken: %v", out3)
	}
	if b, err := os.ReadFile(snapA); err != nil || string(b) != "v2" {
		t.Fatalf("override refresh must swap content: %v %q", err, b)
	}
	if _, err := os.Stat(filepath.Join(share.SnapshotsRoot(), frozenNative("p1", "docs"), "docs", ".env")); err != nil {
		t.Fatalf("confirmed copy must keep scanned content: %v", err)
	}
}

func TestRefreshShareRejects(t *testing.T) {
	r := newFrozenRouter(t)

	// 未知 token → 404
	if code, _ := doJSON(r, http.MethodPost, "/api/share/zzzzzzzzzzzzzzzz/refresh", ""); code != http.StatusNotFound {
		t.Fatalf("unknown token status = %d", code)
	}

	// live 记录 → 400（活视图随项目漂移，无刷新语义）
	code, _ := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt"}`)
	if code != http.StatusOK {
		t.Fatalf("live create status = %d", code)
	}
	live, err := store.Get().Share.List()
	if err != nil || len(live) == 0 {
		t.Fatalf("list live share: %v", err)
	}
	var liveToken string
	for _, s := range live {
		if !s.Frozen {
			liveToken = s.Token
		}
	}
	if code, _ := doJSON(r, http.MethodPost, "/api/share/"+liveToken+"/refresh", ""); code != http.StatusBadRequest {
		t.Fatalf("live refresh status = %d, want 400", code)
	}

	// 目标已删 → 404 且旧副本保留（既有访客面继续服务定格内容）
	seeded := refreshFrozen(t, r)
	token, _ := seeded["token"].(string)
	p, err := store.Get().Project.GetByID("p1")
	if err != nil {
		t.Fatalf("get project: %v", err)
	}
	if err := os.Remove(filepath.Join(p.Path, "note.txt")); err != nil {
		t.Fatal(err)
	}
	if code, _ := doJSON(r, http.MethodPost, "/api/share/"+token+"/refresh", ""); code != http.StatusNotFound {
		t.Fatalf("deleted target status = %d, want 404", code)
	}
	snap := filepath.Join(share.SnapshotsRoot(), frozenNative("p1", "note.txt"), "note.txt")
	if b, rerr := os.ReadFile(snap); rerr != nil || string(b) != "hello" {
		t.Fatalf("old copy must survive failed refresh: %v %q", rerr, b)
	}

	// 非法请求体 → 400
	if code, _ := doJSON(r, http.MethodPost, "/api/share/"+token+"/refresh", `{"override":"yes"}`); code != http.StatusBadRequest {
		t.Fatalf("bad body status = %d", code)
	}
}
