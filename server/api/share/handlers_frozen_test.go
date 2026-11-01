package shareapi

// 冻结分享（P-20261003-320）handler 流：创建即复制（副本落 artifacts 车道 2）、
// 敏感扫描对副本本身（命中拦下且半成品副本丢弃）、override 二次请求放行、
// 护栏拒绝（快照库总量触顶 413）、撤销即删副本、非法 mode 400

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/share"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// newFrozenRouter 复用 newAdminRouter 的项目/路由播种，另把数据目录隔离进
// 临时目录（快照副本绝不写真实用户目录），并在项目根补一个带敏感文件的目录
func newFrozenRouter(t *testing.T) *gin.Engine {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	r := newAdminRouter(t)
	p, err := store.Get().Project.GetByID("p1")
	if err != nil {
		t.Fatalf("get project: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(p.Path, "secretdir"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(p.Path, "secretdir", ".env"), []byte("TOKEN=1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(p.Path, "secretdir", "app.py"), []byte("print('hi')"), 0o644); err != nil {
		t.Fatal(err)
	}
	return r
}

// frozenNative 冻结记录的快照目录名（测试内与生产同公式重算）
func frozenNative(projectID, rel string) string {
	return store.FrozenNativeToken(config.MasterKey(), projectID, rel)
}

func TestCreateShareFrozenHappyPath(t *testing.T) {
	r := newFrozenRouter(t)

	code, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt","mode":"frozen"}`)
	if code != http.StatusOK {
		t.Fatalf("status = %d, body = %v", code, out)
	}
	data, _ := out["data"].(map[string]any)
	if data == nil || data["frozen"] != true {
		t.Fatalf("frozen flag missing in response: %v", out)
	}
	// 默认 30 天 TTL（解析 expiresAt 宽容断言）
	expiresAt, _ := time.Parse(time.RFC3339, toString(data["expiresAt"]))
	if d := time.Until(expiresAt); d > store.FrozenTTL || d < store.FrozenTTL-time.Minute {
		t.Fatalf("frozen ttl = %v, want ~%v", d, store.FrozenTTL)
	}
	// 副本落盘且内容与源一致（镜像布局 <native>/<rel>）
	snap := filepath.Join(share.SnapshotsRoot(), frozenNative("p1", "note.txt"), "note.txt")
	b, err := os.ReadFile(snap)
	if err != nil || string(b) != "hello" {
		t.Fatalf("snapshot copy missing/wrong: %v %q", err, b)
	}
	// 幂等：二次创建（副本不刷新）仍同 token
	code2, out2 := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt","mode":"frozen"}`)
	if code2 != http.StatusOK {
		t.Fatalf("recreate status = %d", code2)
	}
	data2, _ := out2["data"].(map[string]any)
	if data2 == nil || data2["token"] != data["token"] {
		t.Fatalf("idempotent frozen create broken: %v vs %v", data2, data)
	}

	// 撤销即删副本
	token, _ := data["token"].(string)
	if code3, _ := doJSON(r, http.MethodDelete, "/api/share/"+token, ""); code3 != http.StatusOK {
		t.Fatalf("revoke status = %d", code3)
	}
	if _, err := os.Stat(filepath.Dir(snap)); !os.IsNotExist(err) {
		t.Fatal("snapshot dir must be removed on revoke")
	}
}

// 冻结分享的显式有效期（P-20261020-5）：创建时可选预设覆盖 30 天默认；
// ttl=permanent 显式清窗（管理面 SetExpiry 同语义）；幂等重建未显式选择
// 时保留既有倒计时（安全边界不因重复分享被续期/清空）
func TestCreateShareFrozenExplicitTTL(t *testing.T) {
	r := newFrozenRouter(t)

	code, out := doJSON(r, http.MethodPost, "/api/share",
		`{"projectId":"p1","path":"note.txt","mode":"frozen","ttl":"7d"}`)
	if code != http.StatusOK {
		t.Fatalf("frozen 7d status = %d, body = %v", code, out)
	}
	data, _ := out["data"].(map[string]any)
	expiresAt, _ := time.Parse(time.RFC3339, toString(data["expiresAt"]))
	if d := time.Until(expiresAt); d > 7*24*time.Hour || d < 7*24*time.Hour-time.Minute {
		t.Fatalf("frozen ttl = %v, want ~7d", d)
	}

	// 未显式选择的幂等重建保留 7 天窗口（不回到 30 天、不清窗）
	code, out = doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt","mode":"frozen"}`)
	if code != http.StatusOK {
		t.Fatalf("frozen recreate status = %d", code)
	}
	again, _ := out["data"].(map[string]any)
	if again["expiresAt"] != data["expiresAt"] {
		t.Fatalf("idempotent frozen recreate must keep expiry: %v vs %v", again["expiresAt"], data["expiresAt"])
	}

	// 显式 permanent：清掉 30 天默认（既有冻结链同样生效）
	code, out = doJSON(r, http.MethodPost, "/api/share",
		`{"projectId":"p1","path":"note.txt","mode":"frozen","ttl":"permanent"}`)
	if code != http.StatusOK {
		t.Fatalf("frozen permanent status = %d, body = %v", code, out)
	}
	data, _ = out["data"].(map[string]any)
	if _, has := data["expiresAt"]; has {
		t.Fatalf("explicit permanent must clear frozen expiry: %v", data)
	}
}

func TestCreateShareFrozenScanGate(t *testing.T) {
	r := newFrozenRouter(t)

	// 首请求：副本扫描命中敏感文件 → 拦下不给 data，半成品副本不留盘
	code, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"secretdir","mode":"frozen"}`)
	if code != http.StatusOK {
		t.Fatalf("status = %d, body = %v", code, out)
	}
	if _, has := out["data"]; has {
		t.Fatalf("scan hit must not create: %v", out)
	}
	warnings, _ := out["warnings"].([]any)
	if len(warnings) == 0 {
		t.Fatalf("warnings missing: %v", out)
	}
	if _, err := os.Stat(filepath.Join(share.SnapshotsRoot(), frozenNative("p1", "secretdir"))); !os.IsNotExist(err) {
		t.Fatal("unconfirmed frozen copy must be discarded")
	}

	// override 二次请求：放行创建，副本保留（含被确认暴露的敏感文件）
	code2, out2 := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"secretdir","mode":"frozen","override":true}`)
	if code2 != http.StatusOK {
		t.Fatalf("override status = %d, body = %v", code2, out2)
	}
	data, _ := out2["data"].(map[string]any)
	if data == nil || data["frozen"] != true {
		t.Fatalf("override create failed: %v", out2)
	}
	if _, err := os.Stat(filepath.Join(share.SnapshotsRoot(), frozenNative("p1", "secretdir"), "secretdir", ".env")); err != nil {
		t.Fatalf("confirmed copy must keep scanned content: %v", err)
	}
}

func TestCreateShareFrozenQuotaGuard(t *testing.T) {
	r := newFrozenRouter(t)

	// 快照库总量触顶：往快照根塞一份占满额度的文件（截断到目标大小，不真写
	// 1GB 字节——dirTotalBytes 按 Info().Size() 计量），再冻结即 413（提示走 live）
	stuffing := filepath.Join(share.SnapshotsRoot(), "quota000000000001")
	if err := os.MkdirAll(stuffing, 0o755); err != nil {
		t.Fatal(err)
	}
	filler, err := os.Create(filepath.Join(stuffing, "filler.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if err := filler.Truncate(share.MaxFrozenTotalBytes); err != nil {
		t.Fatal(err)
	}
	_ = filler.Close()

	code, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt","mode":"frozen"}`)
	if code != http.StatusRequestEntityTooLarge {
		t.Fatalf("quota guard status = %d, body = %v", code, out)
	}
	if msg, _ := out["error"].(string); !strings.Contains(msg, "share snapshot store is full") {
		t.Fatalf("stable marker missing: %v", out)
	}
	// 失败不留半成品
	if _, err := os.Stat(filepath.Join(share.SnapshotsRoot(), frozenNative("p1", "note.txt"))); !os.IsNotExist(err) {
		t.Fatal("failed freeze must roll back partial copy")
	}
}

func TestCreateShareInvalidMode(t *testing.T) {
	r := newFrozenRouter(t)
	code, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt","mode":"weird"}`)
	if code != http.StatusBadRequest {
		t.Fatalf("invalid mode status = %d, body = %v", code, out)
	}
	// live 显式值与缺省同语义（既有契约回归）
	code2, out2 := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt","mode":"live"}`)
	if code2 != http.StatusOK {
		t.Fatalf("live mode status = %d, body = %v", code2, out2)
	}
	if data, _ := out2["data"].(map[string]any); data == nil {
		t.Fatalf("live create should return data: %v", out2)
	}
}

// TestListSharesFrozenUsage 列表响应的占用投影（P-20261005-176）：frozenUsage
// 总量/上限 + 有快照在盘的行带 frozenBytes；live 行不带；撤销后数字回落
func TestListSharesFrozenUsage(t *testing.T) {
	r := newFrozenRouter(t)

	// 空快照库：投影恒在（agent 程序化容量治理的稳定契约），总量 0
	_, out := doJSON(r, http.MethodGet, "/api/share", "")
	usage, _ := out["frozenUsage"].(map[string]any)
	if usage == nil {
		t.Fatalf("frozenUsage projection missing on empty store: %v", out)
	}
	if usage["capBytes"] != float64(share.MaxFrozenTotalBytes) || usage["totalBytes"] != float64(0) {
		t.Fatalf("empty usage wrong: %v", usage)
	}

	code, out := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt","mode":"frozen"}`)
	if code != http.StatusOK {
		t.Fatalf("create status = %d, body = %v", code, out)
	}
	data, _ := out["data"].(map[string]any)
	token, _ := data["token"].(string)

	// 冻结行带 frozenBytes = 该份快照目录实际字节量（与逐树统计同源）
	snap := filepath.Join(share.SnapshotsRoot(), frozenNative("p1", "note.txt"), "note.txt")
	fi, err := os.Stat(snap)
	if err != nil {
		t.Fatal(err)
	}
	_, out = doJSON(r, http.MethodGet, "/api/share", "")
	usage, _ = out["frozenUsage"].(map[string]any)
	if usage == nil || usage["totalBytes"] != float64(fi.Size()) {
		t.Fatalf("total usage = %v, want %d", usage["totalBytes"], fi.Size())
	}
	list, _ := out["data"].([]any)
	var frozenRow map[string]any
	for _, row := range list {
		m, _ := row.(map[string]any)
		if m != nil && m["frozen"] == true {
			frozenRow = m
		}
	}
	if frozenRow == nil || frozenRow["frozenBytes"] != float64(fi.Size()) {
		t.Fatalf("frozen row bytes wrong: %v", frozenRow)
	}

	// live 行不带 frozenBytes（只有快照在盘的行才有体积）
	code, _ = doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","path":"note.txt"}`)
	if code != http.StatusOK {
		t.Fatalf("live create status = %d", code)
	}
	_, out = doJSON(r, http.MethodGet, "/api/share", "")
	list, _ = out["data"].([]any)
	for _, row := range list {
		m, _ := row.(map[string]any)
		if m != nil && m["frozen"] != true {
			if _, has := m["frozenBytes"]; has {
				t.Fatalf("non-frozen row must not carry frozenBytes: %v", m)
			}
		}
	}

	// 撤销即删副本 → 占用回落到 0（容量护栏的治理闭环）
	if code, _ := doJSON(r, http.MethodDelete, "/api/share/"+token, ""); code != http.StatusOK {
		t.Fatalf("revoke status = %d", code)
	}
	_, out = doJSON(r, http.MethodGet, "/api/share", "")
	usage, _ = out["frozenUsage"].(map[string]any)
	if usage == nil || usage["totalBytes"] != float64(0) {
		t.Fatalf("usage after revoke = %v, want 0", usage)
	}
}

// toString 断言辅助：JSON 解包后的字符串值取回（非字符串返回空串）
func toString(v any) string {
	s, _ := v.(string)
	return s
}

// ── 多路径冻结分享（P-20261008-1） ──

// TestCreateShareFrozenBatch 批量创建链路：集合规范化（嵌套随父去重）、副本
// 按相对结构落盘、响应带 paths、顺序无关幂等、rotate 换链副本不动、撤销即删；
// live/互斥/非法路径/缺失目标拒绝
func TestCreateShareFrozenBatch(t *testing.T) {
	r := newFrozenRouter(t)
	p, err := store.Get().Project.GetByID("p1")
	if err != nil {
		t.Fatal(err)
	}
	for rel, content := range map[string]string{
		"src/a.ts":   "const a = 1",
		"docs/b.md":  "# b",
		"docs/c.txt": "c",
	} {
		full := filepath.Join(p.Path, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// 集合含目录 docs 与 docs/b.md：嵌套项随父去重 → [docs, src/a.ts]
	body := `{"projectId":"p1","mode":"frozen","paths":["src/a.ts","docs","docs/b.md"]}`
	code, out := doJSON(r, http.MethodPost, "/api/share", body)
	if code != http.StatusOK {
		t.Fatalf("create batch status = %d, body = %v", code, out)
	}
	data, _ := out["data"].(map[string]any)
	if data == nil || data["frozen"] != true {
		t.Fatalf("batch create response wrong: %v", out)
	}
	if data["path"] != "" {
		t.Fatalf("batch share path should be empty, got %v", data["path"])
	}
	paths, _ := data["paths"].([]any)
	if len(paths) != 2 || paths[0] != "docs" || paths[1] != "src/a.ts" {
		t.Fatalf("batch paths = %v, want [docs src/a.ts]", paths)
	}
	if size, _ := data["size"].(float64); size <= 0 {
		t.Fatalf("batch size should be copied bytes > 0, got %v", data["size"])
	}
	token, _ := data["token"].(string)
	native := store.FrozenBatchNativeToken(config.MasterKey(), "p1", []string{"docs", "src/a.ts"})
	for rel, content := range map[string]string{
		"src/a.ts":   "const a = 1",
		"docs/b.md":  "# b",
		"docs/c.txt": "c",
	} {
		b, err := os.ReadFile(filepath.Join(share.SnapshotsRoot(), native, filepath.FromSlash(rel)))
		if err != nil || string(b) != content {
			t.Fatalf("batch snapshot %s missing/wrong: %v %q", rel, err, b)
		}
	}

	// 顺序无关幂等：反序重建同 token，副本不重拷（CreatedAt 不刷新）
	code2, out2 := doJSON(r, http.MethodPost, "/api/share",
		`{"projectId":"p1","mode":"frozen","paths":["src/a.ts","docs"]}`)
	if code2 != http.StatusOK {
		t.Fatalf("idempotent recreate status = %d, body = %v", code2, out2)
	}
	data2, _ := out2["data"].(map[string]any)
	if data2 == nil || data2["token"] != token {
		t.Fatalf("batch idempotency broken: %v vs %v", data2, data)
	}
	if data2["createdAt"] != data["createdAt"] {
		t.Fatal("idempotent batch create must keep CreatedAt")
	}

	// rotate：换 token、副本目录不动（零代际键）
	code3, out3 := doJSON(r, http.MethodPost, "/api/share/"+token+"/rotate", "")
	if code3 != http.StatusOK {
		t.Fatalf("rotate status = %d, body = %v", code3, out3)
	}
	rotated, _ := out3["data"].(map[string]any)
	newToken, _ := rotated["token"].(string)
	if newToken == "" || newToken == token {
		t.Fatalf("rotate should issue a new token: %v", rotated)
	}
	if _, err := os.Stat(filepath.Join(share.SnapshotsRoot(), native, "src", "a.ts")); err != nil {
		t.Fatalf("rotate must keep batch snapshot in place: %v", err)
	}

	// 撤销即删副本
	if code4, _ := doJSON(r, http.MethodDelete, "/api/share/"+newToken, ""); code4 != http.StatusOK {
		t.Fatalf("revoke status = %d", code4)
	}
	if _, err := os.Stat(filepath.Join(share.SnapshotsRoot(), native)); !os.IsNotExist(err) {
		t.Fatal("batch snapshot must be removed on revoke")
	}

	// 拒绝族：live 批量、path+paths 互斥、非法路径、缺失目标
	if code, _ := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","paths":["docs"]}`); code != http.StatusBadRequest {
		t.Fatalf("live batch status = %d, want 400", code)
	}
	if code, _ := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","mode":"frozen","path":"note.txt","paths":["docs"]}`); code != http.StatusBadRequest {
		t.Fatalf("path+paths status = %d, want 400", code)
	}
	if code, _ := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","mode":"frozen","paths":["../etc/passwd"]}`); code != http.StatusBadRequest {
		t.Fatalf("traversal paths status = %d, want 400", code)
	}
	if code, _ := doJSON(r, http.MethodPost, "/api/share", `{"projectId":"p1","mode":"frozen","paths":["docs/missing.md"]}`); code != http.StatusNotFound {
		t.Fatalf("missing target status = %d, want 404", code)
	}
}

// TestCreateShareFrozenBatchScanGate 批量敏感扫描：任一路径命中即拦下、整份
// 半成品副本丢弃；override 二次请求放行并保留全部内容
func TestCreateShareFrozenBatchScanGate(t *testing.T) {
	r := newFrozenRouter(t)
	body := `{"projectId":"p1","mode":"frozen","paths":["secretdir/app.py","secretdir/.env"]}`
	code, out := doJSON(r, http.MethodPost, "/api/share", body)
	if code != http.StatusOK {
		t.Fatalf("status = %d, body = %v", code, out)
	}
	if _, has := out["data"]; has {
		t.Fatalf("scan hit must not create batch share: %v", out)
	}
	if warnings, _ := out["warnings"].([]any); len(warnings) == 0 {
		t.Fatalf("warnings missing: %v", out)
	}
	native := store.FrozenBatchNativeToken(config.MasterKey(), "p1", []string{"secretdir/.env", "secretdir/app.py"})
	if _, err := os.Stat(filepath.Join(share.SnapshotsRoot(), native)); !os.IsNotExist(err) {
		t.Fatal("unconfirmed batch copy must be discarded")
	}

	code2, out2 := doJSON(r, http.MethodPost, "/api/share",
		`{"projectId":"p1","mode":"frozen","override":true,"paths":["secretdir/app.py","secretdir/.env"]}`)
	if code2 != http.StatusOK {
		t.Fatalf("override status = %d, body = %v", code2, out2)
	}
	data, _ := out2["data"].(map[string]any)
	if data == nil || data["frozen"] != true {
		t.Fatalf("override batch create failed: %v", out2)
	}
	if _, err := os.Stat(filepath.Join(share.SnapshotsRoot(), native, "secretdir", ".env")); err != nil {
		t.Fatalf("confirmed batch copy must keep scanned content: %v", err)
	}
}
