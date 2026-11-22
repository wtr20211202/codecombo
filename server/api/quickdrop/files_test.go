package quickdrop

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/notification"
	"codecombo/server/share"
	"codecombo/server/store"
)

// 快投递多文件上行（P-20261117-2-S1）纪律锁：token 门禁前置（无效凭据大体量
// 请求零字节读取即 404 不落地）、流式限额三闸（单文件/配额/体闸触顶即删残
// 留）、白名单外排水跳过不回滚全批、收件箱 doc 承载文件元数据行（消费链闭
// 环）、TTL/GC/凭据清盘、urlencoded 旧表单并存（回归在 quickdrop_test.go）。

// mpFile 一个待上传文件（multipart files 字段）
type mpFile struct {
	name string
	data []byte
}

// mpRequestBody 组 multipart 体（content 字段在前 + files 依序——浏览器
// DOM 序惯例）；content 空串 = 不写 content 字段
func mpRequestBody(t *testing.T, content string, files []mpFile) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	if content != "" {
		if err := w.WriteField(qdContentField, content); err != nil {
			t.Fatalf("write content field: %v", err)
		}
	}
	for _, f := range files {
		fw, err := w.CreateFormFile(qdFilesField, f.name)
		if err != nil {
			t.Fatalf("create form file: %v", err)
		}
		if _, err := fw.Write(f.data); err != nil {
			t.Fatalf("write file part: %v", err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	return &buf, w.FormDataContentType()
}

// postFiles 发一次 multipart 投递并解包 JSON 响应
func postFiles(t *testing.T, r http.Handler, path, content string, files []mpFile) (int, map[string]any) {
	t.Helper()
	body, ctype := mpRequestBody(t, content, files)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, path, body)
	req.Header.Set("Content-Type", ctype)
	r.ServeHTTP(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

// qdTokenDir 测试侧凭据目录（与实现同构——落位断言用）
func qdTokenDir(t *testing.T, token string) string {
	t.Helper()
	return filepath.Join(config.DataDir(), "artifacts", "quickdrop", token)
}

// qdDirFiles 列出凭据目录下的非 sidecar 文件名（目录不存在 = nil）
func qdDirFiles(t *testing.T, token string) []string {
	t.Helper()
	entries, err := os.ReadDir(qdTokenDir(t, token))
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), share.DropSidecarSuffix) {
			out = append(out, e.Name())
		}
	}
	return out
}

// withSmallLimits 覆写限额档位锁小值（包级变量是测试可覆写位——生产只读）
func withSmallLimits(t *testing.T, total, file int64, batch int) {
	t.Helper()
	oldTotal, oldFile, oldBatch, oldFence := qdMaxTotalBytes, qdMaxFileBytes, qdMaxBatchFiles, qdBodyLimit
	qdMaxTotalBytes, qdMaxFileBytes, qdMaxBatchFiles = total, file, batch
	qdBodyLimit = total + (64 << 20)
	t.Cleanup(func() {
		qdMaxTotalBytes, qdMaxFileBytes, qdMaxBatchFiles, qdBodyLimit = oldTotal, oldFile, oldBatch, oldFence
	})
}

func TestPostDropFilesArrives(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	r := newQuickdropRouter(t)
	token := genToken(t, r)

	png := []byte("\x89PNGDATA-fake-image-bytes")
	log := []byte("panic: nil map in handler.go:42\n")
	code, out := postFiles(t, r, "/drop/"+token, "服务报错现场如下", []mpFile{
		{name: "screenshot.png", data: png},
		{name: `logs/../../etc/evil.log`, data: log}, // 路径杂名净化为单段
	})
	if code != http.StatusOK {
		t.Fatalf("status = %d: %v", code, out)
	}
	if ok, _ := out["data"].(map[string]any); ok == nil || ok["ok"] != true {
		t.Fatalf("data payload wrong: %v", out)
	}

	// 逐文件终态：两文件均 accepted（净化名/大小/形态），无警示
	added, _ := out["added"].([]any)
	if len(added) != 2 {
		t.Fatalf("added len = %d: %v", len(added), out)
	}
	first, _ := added[0].(map[string]any)
	if first["name"] != "screenshot.png" || first["kind"] != "image" {
		t.Fatalf("added[0] wrong: %v", first)
	}
	if sz, _ := first["size"].(float64); int64(sz) != int64(len(png)) {
		t.Fatalf("added[0] size = %v", first["size"])
	}
	second, _ := added[1].(map[string]any)
	if second["name"] != "evil.log" || second["kind"] != "file" {
		t.Fatalf("traversal name not sanitized: %v", second)
	}
	if warnings, _ := out["warnings"].([]any); len(warnings) != 0 {
		t.Fatalf("unexpected warnings: %v", out["warnings"])
	}

	// 落盘：文件字节等值 + sidecar 在场（本体先于 sidecar 的坏条目方向）
	files := qdDirFiles(t, token)
	if len(files) != 2 {
		t.Fatalf("dir files = %v", files)
	}
	for i, name := range files {
		if !strings.HasPrefix(name, "1") && !strings.HasPrefix(name, "2") {
			t.Fatalf("id prefix missing: %q", name)
		}
		data, err := os.ReadFile(filepath.Join(qdTokenDir(t, token), name))
		if err != nil {
			t.Fatalf("read %q: %v", name, err)
		}
		want := png
		if i == 1 {
			want = log
		}
		if string(data) != string(want) {
			t.Fatalf("file %q bytes mismatch (%d vs %d)", name, len(data), len(want))
		}
		if _, err := os.Stat(filepath.Join(qdTokenDir(t, token), name+share.DropSidecarSuffix)); err != nil {
			t.Fatalf("sidecar missing for %q: %v", name, err)
		}
	}

	// 收件箱 doc：Content = 文本 + 文件元数据行（头部/目录/明细——消费链闭环）
	list, err := store.Get().Quickdrop.List()
	if err != nil || len(list) != 1 {
		t.Fatalf("inbox: %v %d", err, len(list))
	}
	content := list[0].Content
	for _, want := range []string{"服务报错现场如下", "[文件 2 个，24h 内有效]", "目录: ", "screenshot.png", "evil.log", "("} {
		if !strings.Contains(content, want) {
			t.Fatalf("inbox content missing %q: %q", want, content)
		}
	}

	// 通知：filesArrived 模板 + count/size 参数 + 行内动作双出口不变
	notifs := store.Get().Notification.List(10)
	if len(notifs) != 1 {
		t.Fatalf("notification count = %d", len(notifs))
	}
	n := notifs[0]
	if n.Category != notification.CategoryDrop || n.TitleKey != "notify.quickdrop.filesArrived" {
		t.Fatalf("notification wrong: %+v", n)
	}
	if n.ActionPayload != PayloadPrefix+list[0].ID || n.SecondAction != "quickdrop-new" {
		t.Fatalf("action payloads wrong: %q / %q", n.ActionPayload, n.SecondAction)
	}
	if !strings.Contains(n.Body, "screenshot.png") || !strings.Contains(n.Body, "evil.log") {
		t.Fatalf("notification body missing file names: %q", n.Body)
	}

	// 审计：条数/字节量元数据（正文与文件名不入账）
	events, _, _ := store.Get().Audit.List(10, 0)
	found := false
	for _, e := range events {
		if e.Action == "quickdrop.drop" {
			found = true
			if !strings.Contains(e.Detail, "files=2") || !strings.Contains(e.Detail, "bytes=") {
				t.Fatalf("audit detail wrong: %q", e.Detail)
			}
			if strings.Contains(e.Detail, "handler.go") {
				t.Fatalf("audit detail leaks content: %q", e.Detail)
			}
		}
	}
	if !found {
		t.Fatal("quickdrop.drop audit event missing")
	}
}

func TestPostDropFilesSensitiveNameWarning(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	r := newQuickdropRouter(t)
	token := genToken(t, r)

	code, out := postFiles(t, r, "/drop/"+token, "", []mpFile{
		{name: "credentials.json", data: []byte(`{"token":"secret"}`)},
	})
	if code != http.StatusOK {
		t.Fatalf("status = %d: %v", code, out)
	}
	warnings, _ := out["warnings"].([]any)
	if len(warnings) != 1 || warnings[0] != "credentials.json" {
		t.Fatalf("warnings = %v, want sensitive-name hit", out["warnings"])
	}
	// 审计带 sensitive-name 注记
	events, _, _ := store.Get().Audit.List(10, 0)
	hit := false
	for _, e := range events {
		if e.Action == "quickdrop.drop" && strings.Contains(e.Detail, "sensitive-name") {
			hit = true
		}
	}
	if !hit {
		t.Fatal("audit sensitive-name note missing")
	}
}

// 门禁前置（评审必改②）：无效凭据的 multipart 大体量请求零字节读取即 404
// 品牌页（与表单提交同口径），落盘区零新建（不耗盘不暴露端点存在性）
func TestPostDropFilesGateFirst(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	r := newQuickdropRouter(t)
	genToken(t, r) // 凭据存在但本次投递不携带

	big := bytes.Repeat([]byte("x"), 1<<20) // 1MB 载荷——门禁前置即拒
	body, ctype := mpRequestBody(t, "", []mpFile{{name: "big.bin", data: big}})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/drop/scd_invalidinvalidinvalidinvalidinv", body)
	req.Header.Set("Content-Type", ctype)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "链接无效") {
		t.Fatalf("404 must be the brand page: %s", w.Body.String())
	}
	if entries, _ := os.ReadDir(filepath.Join(config.DataDir(), "artifacts", "quickdrop")); len(entries) != 0 {
		t.Fatalf("invalid-token upload must not land on disk: %v", entries)
	}
	// 凭据存储在册但未投递：收件箱空
	list, _ := store.Get().Quickdrop.List()
	if len(list) != 0 {
		t.Fatalf("rejected drop stored: %d", len(list))
	}
}

// 白名单外/超单文件上限：拒绝位不落盘不消耗配额，后续文件照收（不搞全批
// 回滚的假原子——drops.go 同契约）
func TestPostDropFilesRejects(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	withSmallLimits(t, 64<<20, 8<<20, 20)
	r := newQuickdropRouter(t)
	token := genToken(t, r)

	code, out := postFiles(t, r, "/drop/"+token, "", []mpFile{
		{name: "malware.exe", data: []byte("MZbinary")},            // 白名单外
		{name: "huge.zip", data: bytes.Repeat([]byte("z"), 9<<20)}, // 超文件档 8MB
		{name: "ok.txt", data: []byte("fine")},                     // 可达照收
	})
	if code != http.StatusOK {
		t.Fatalf("status = %d: %v", code, out)
	}
	added, _ := out["added"].([]any)
	if len(added) != 3 {
		t.Fatalf("added len = %d: %v", len(added), out)
	}
	for i, wantKind := range []string{"rejected", "rejected", "file"} {
		m, _ := added[i].(map[string]any)
		if m["kind"] != wantKind {
			t.Fatalf("added[%d] kind = %v, want %q", i, m["kind"], wantKind)
		}
		if wantKind == "rejected" {
			if id, _ := m["id"].(string); id != "" {
				t.Fatalf("rejected entry must have empty id: %v", m)
			}
		}
	}
	files := qdDirFiles(t, token)
	if len(files) != 1 || !strings.HasSuffix(files[0], "_ok.txt") {
		t.Fatalf("only ok.txt must land: %v", files)
	}
	// 收件箱 doc：仅剩 1 个 accepted 文件（rejected 不入元数据行）
	list, _ := store.Get().Quickdrop.List()
	if len(list) != 1 || !strings.Contains(list[0].Content, "[文件 1 个") {
		t.Fatalf("inbox doc wrong: %+v", list)
	}
}

// 配额触顶：整批断 413 drop_quota，本批残留全删（半成品+已落盘）；先前
// 批次的文件不受牵连
func TestPostDropFilesQuotaAbort(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	withSmallLimits(t, 16<<10, 8<<10, 20)
	r := newQuickdropRouter(t)
	token := genToken(t, r)

	// 先前批次：6KB×1 在配额内落定
	code, _ := postFiles(t, r, "/drop/"+token, "", []mpFile{{name: "a.txt", data: bytes.Repeat([]byte("a"), 6<<10)}})
	if code != http.StatusOK {
		t.Fatalf("first batch status = %d", code)
	}
	// 本批：6KB+6KB+6KB = 18KB > 16KB 配额 → 第三个文件中途触顶断
	code, out := postFiles(t, r, "/drop/"+token, "", []mpFile{
		{name: "b.txt", data: bytes.Repeat([]byte("b"), 6<<10)},
		{name: "c.txt", data: bytes.Repeat([]byte("c"), 6<<10)},
		{name: "d.txt", data: bytes.Repeat([]byte("d"), 6<<10)},
	})
	if code != http.StatusRequestEntityTooLarge {
		t.Fatalf("quota status = %d: %v", code, out)
	}
	if msg, _ := out["error"].(string); msg != "drop_quota" {
		t.Fatalf("error = %v, want drop_quota", out["error"])
	}
	// 本批残留全删（b/c/d 一个不留），先前批次 a.txt 保留
	files := qdDirFiles(t, token)
	if len(files) != 1 || !strings.HasSuffix(files[0], "_a.txt") {
		t.Fatalf("residue wrong: %v", files)
	}
	list, _ := store.Get().Quickdrop.List()
	if len(list) != 1 || !strings.Contains(list[0].Content, "a.txt") {
		t.Fatalf("inbox wrong after quota abort: %+v", list)
	}
}

// 体闸越界：413 too_large（白名单外垃圾 part 不计配额——体闸是唯一总兜底）
func TestPostDropFilesBodyFence(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	withSmallLimits(t, 16<<10, 8<<10, 20)
	r := newQuickdropRouter(t)
	token := genToken(t, r)

	// 10KB 文件 < 配额 16KB 但 > 体闸 16KB+64MB？——体闸随 withSmallLimits
	// 重算为 16KB+64MB，需直接覆写体闸更小值
	qdBodyLimit = 8 << 10
	code, out := postFiles(t, r, "/drop/"+token, "", []mpFile{
		{name: "big.txt", data: bytes.Repeat([]byte("x"), 10<<10)},
	})
	if code != http.StatusRequestEntityTooLarge {
		t.Fatalf("fence status = %d: %v", code, out)
	}
	if msg, _ := out["error"].(string); msg != "too_large" {
		t.Fatalf("error = %v, want too_large", out["error"])
	}
	if files := qdDirFiles(t, token); len(files) != 0 {
		t.Fatalf("fence residue not cleaned: %v", files)
	}
}

func TestPostDropFilesEmpty(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	r := newQuickdropRouter(t)
	token := genToken(t, r)

	// 内容与文件全空 → 400（内容或文件至少一项）
	code, out := postFiles(t, r, "/drop/"+token, "", nil)
	if code != http.StatusBadRequest {
		t.Fatalf("status = %d: %v", code, out)
	}
	// 全部文件被拒且无文本 → 400（rejected 占位如实随响应）
	code, out = postFiles(t, r, "/drop/"+token, "", []mpFile{{name: "x.exe", data: []byte("MZ")}})
	if code != http.StatusBadRequest {
		t.Fatalf("all-rejected status = %d: %v", code, out)
	}
	if added, _ := out["added"].([]any); len(added) != 1 {
		t.Fatalf("rejected placeholder missing: %v", out)
	}
	// 非法 multipart 体 → 400
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/drop/"+token, strings.NewReader("garbage"))
	req.Header.Set("Content-Type", "multipart/form-data; boundary=none")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("invalid multipart status = %d: %s", w.Code, w.Body.String())
	}
}

// 纯文本 multipart（文件全被拒或只有文本）：走文本通道同一到达语义
// （notify/audit 文本口径——titleKey arrived 而非 filesArrived）
func TestPostDropFilesTextOnly(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	r := newQuickdropRouter(t)
	token := genToken(t, r)

	code, out := postFiles(t, r, "/drop/"+token, "just text over multipart", nil)
	if code != http.StatusOK {
		t.Fatalf("status = %d: %v", code, out)
	}
	list, _ := store.Get().Quickdrop.List()
	if len(list) != 1 || list[0].Content != "just text over multipart" {
		t.Fatalf("inbox wrong: %+v", list)
	}
	n := store.Get().Notification.List(10)[0]
	if n.TitleKey != "notify.quickdrop.arrived" {
		t.Fatalf("text drop must use arrived titleKey: %q", n.TitleKey)
	}
}

// 文本超 4KB：整批断 413（与文本通道同口径；文件残留清）
func TestPostDropFilesTextTooLarge(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	r := newQuickdropRouter(t)
	token := genToken(t, r)

	big := strings.Repeat("t", store.MaxDropBytes+1)
	// content 字段超限——mpRequestBody 对 content 无长度闸，直发
	body, ctype := mpRequestBody(t, big, []mpFile{{name: "a.txt", data: []byte("x")}})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/drop/"+token, body)
	req.Header.Set("Content-Type", ctype)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d: %s", w.Code, w.Body.String())
	}
	if files := qdDirFiles(t, token); len(files) != 0 {
		t.Fatalf("text-overflow residue not cleaned: %v", files)
	}
}

// 单批上限：超出部分拒绝位（保连接继续收——逐 part 计数的 skip 语义）
func TestPostDropFilesBatchCap(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	withSmallLimits(t, 64<<20, 8<<10, 2)
	r := newQuickdropRouter(t)
	token := genToken(t, r)

	code, out := postFiles(t, r, "/drop/"+token, "", []mpFile{
		{name: "a.png", data: []byte("A")},
		{name: "b.png", data: []byte("B")},
		{name: "c.png", data: []byte("C")}, // 第 3 个超单批 2
	})
	if code != http.StatusOK {
		t.Fatalf("status = %d: %v", code, out)
	}
	added, _ := out["added"].([]any)
	if len(added) != 3 {
		t.Fatalf("added len = %d", len(added))
	}
	last, _ := added[2].(map[string]any)
	if last["kind"] != "rejected" {
		t.Fatalf("batch-cap overflow must be rejected: %v", last)
	}
	if files := qdDirFiles(t, token); len(files) != 2 {
		t.Fatalf("accepted files = %v", files)
	}
}

// 恰好触档：文件字节数 = 单文件上限 → 照收（quotaBoundedReader 边界探测
// 区分「恰好收满」与「仍有余量」——±1 字节两向钉死）
func TestPostDropFilesExactCap(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	withSmallLimits(t, 64<<20, 8<<10, 20)
	r := newQuickdropRouter(t)
	token := genToken(t, r)

	code, out := postFiles(t, r, "/drop/"+token, "", []mpFile{
		{name: "exact.txt", data: bytes.Repeat([]byte("e"), 8<<10)},
		{name: "over.txt", data: bytes.Repeat([]byte("o"), (8<<10)+1)},
	})
	if code != http.StatusOK {
		t.Fatalf("status = %d: %v", code, out)
	}
	added, _ := out["added"].([]any)
	if added[0].(map[string]any)["kind"] != "file" {
		t.Fatalf("exact-cap file must be accepted: %v", added[0])
	}
	if added[1].(map[string]any)["kind"] != "rejected" {
		t.Fatalf("cap+1 file must be rejected: %v", added[1])
	}
}

// 凭据生命周期清盘：轮换/撤销后文件隔离区显式清空（文本收件箱 doc 不随动）
func TestPurgeFilesOnTokenRotateAndRevoke(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	r := newQuickdropRouter(t)
	oldToken := genToken(t, r)

	code, _ := postFiles(t, r, "/drop/"+oldToken, "", []mpFile{{name: "a.txt", data: []byte("A")}})
	if code != http.StatusOK {
		t.Fatalf("upload status = %d", code)
	}
	if files := qdDirFiles(t, oldToken); len(files) != 1 {
		t.Fatalf("setup upload missing: %v", files)
	}

	// 轮换：旧凭据目录整树清空
	newToken := genToken(t, r) // 生成即轮换
	if entries, _ := os.ReadDir(filepath.Join(config.DataDir(), "artifacts", "quickdrop")); len(entries) != 0 {
		t.Fatalf("rotate must purge file area: %v", entries)
	}
	if code, _ := doJSON(r, http.MethodPost, "/api/quickdrop", `{"token":"`+oldToken+`","content":"x"}`); code != http.StatusNotFound {
		t.Fatalf("old token after rotate = %d", code)
	}
	// 文本收件箱 doc 不随轮换清账（照常 24h TTL 过窗）
	list, _ := store.Get().Quickdrop.List()
	if len(list) != 1 {
		t.Fatalf("text inbox docs must survive rotate: %d", len(list))
	}

	// 新凭据投递后再撤销：目录清空
	code, _ = postFiles(t, r, "/drop/"+newToken, "", []mpFile{{name: "b.txt", data: []byte("B")}})
	if code != http.StatusOK {
		t.Fatalf("upload status = %d", code)
	}
	if code, _ := doJSON(r, http.MethodDelete, "/api/quickdrop/token", ""); code != http.StatusOK {
		t.Fatal("revoke failed")
	}
	if entries, _ := os.ReadDir(filepath.Join(config.DataDir(), "artifacts", "quickdrop")); len(entries) != 0 {
		t.Fatalf("revoke must purge file area: %v", entries)
	}
}

// GC 对账：孤儿目录（失效凭据名）整树删、过期文件删、鲜活文件留、
// sidecar 缺失裸文件按 mtime 口径清
func TestGcQuickdropFiles(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	r := newQuickdropRouter(t)
	token := genToken(t, r)

	code, _ := postFiles(t, r, "/drop/"+token, "", []mpFile{{name: "fresh.txt", data: []byte("F")}})
	if code != http.StatusOK {
		t.Fatalf("upload status = %d", code)
	}
	// 把 fresh.txt 的 sidecar At 改成 48h 前（TTL 过窗）
	files := qdDirFiles(t, token)
	var sidecar string
	for _, name := range files {
		sc := filepath.Join(qdTokenDir(t, token), name+share.DropSidecarSuffix)
		var meta share.DropMeta
		data, err := os.ReadFile(sc)
		if err != nil || json.Unmarshal(data, &meta) != nil {
			t.Fatalf("read sidecar: %v", err)
		}
		meta.At = time.Now().Add(-48 * time.Hour)
		data, _ = json.Marshal(meta)
		if err := os.WriteFile(sc, data, 0o600); err != nil {
			t.Fatal(err)
		}
		sidecar = sc
	}
	_ = sidecar

	// 孤儿目录（失效凭据名）+ 裸文件（无 sidecar，mtime 48h 前）
	orphan := filepath.Join(config.DataDir(), "artifacts", "quickdrop", "scd_orphanorphanorphanorphanor")
	if err := os.MkdirAll(orphan, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(orphan, "junk.bin"), []byte("J"), 0o600); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(qdTokenDir(t, token), "999_stale.txt")
	if err := os.WriteFile(stale, []byte("S"), 0o600); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(stale, past, past); err != nil {
		t.Fatal(err)
	}

	if n := gcQuickdropFiles(store.Get(), time.Now(), nil); n < 3 {
		t.Fatalf("gc removed = %d, want >=3 (orphan dir + expired file + stale bare file)", n)
	}
	// 孤儿整树删；fresh.txt（sidecar 已改 48h 前）同窗删；stale 裸文件删
	if _, err := os.Stat(orphan); !os.IsNotExist(err) {
		t.Fatal("orphan dir must be removed")
	}
	if files := qdDirFiles(t, token); len(files) != 0 {
		t.Fatalf("expired files must be removed: %v", files)
	}
	// 空目录回收
	if _, err := os.Stat(qdTokenDir(t, token)); !os.IsNotExist(err) {
		t.Fatal("empty token dir must be removed")
	}
	// store 判不了（nil）即拒清账（GcOrphanDrops keep=nil 守卫同旨）
	orphan2 := filepath.Join(config.DataDir(), "artifacts", "quickdrop", "scd_orphan2orphan2orphan2orphan")
	if err := os.MkdirAll(orphan2, 0o700); err != nil {
		t.Fatal(err)
	}
	if n := gcQuickdropFiles(nil, time.Now(), nil); n != 0 {
		t.Fatal("nil store must refuse to gc")
	}
	if _, err := os.Stat(orphan2); err != nil {
		t.Fatal("nil store gc must not touch disk")
	}
}

func TestBuildFileDropContent(t *testing.T) {
	dir := "/data/artifacts/quickdrop/scd_abcd"
	metas := []share.DropMeta{
		{ID: "1", Name: "shot.png", Size: 1300},
		{ID: "2", Name: "run.log", Size: 46000},
	}

	// 常态：文本 + 头部 + 目录 + 明细行（FmtSize 口径）
	got := buildFileDropContent("现场如下", dir, metas)
	for _, want := range []string{"现场如下", "[文件 2 个，24h 内有效]", "目录: " + dir, "- shot.png (1.3KB)", "- run.log (44.9KB)"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in %q", want, got)
		}
	}
	if len(got) > store.MaxDropBytes {
		t.Fatalf("content over budget: %d", len(got))
	}

	// 无文本：块独立成文
	got = buildFileDropContent("", dir, metas)
	if !strings.HasPrefix(got, "[文件 2 个") {
		t.Fatalf("files-only content head wrong: %q", got)
	}

	// 文本贴满预算：文本裁剪+标记，目录行恒在，总预算不破
	//（CJK 与 ASCII 两形态都要过——ASCII 字节粒度最坏情况钉死「分隔符
	// 差一字节越 doc 硬闸」的边界）
	for name, big := range map[string]string{
		"cjk":   strings.Repeat("字", store.MaxDropBytes),
		"ascii": strings.Repeat("a", store.MaxDropBytes),
	} {
		got = buildFileDropContent(big, dir, metas)
		if len(got) > store.MaxDropBytes {
			t.Fatalf("%s overflow not capped: %d", name, len(got))
		}
		if !strings.Contains(got, "truncated") || !strings.Contains(got, "目录: "+dir) {
			t.Fatalf("%s truncation marker / dir line missing: %q", name, got[:200])
		}
	}

	// 明细行预算不够：目录行仍完整（agent ls 可还原全量）
	longNames := make([]share.DropMeta, 0, 20)
	for i := 0; i < 20; i++ {
		longNames = append(longNames, share.DropMeta{ID: "x", Name: strings.Repeat("n", 100), Size: 1})
	}
	got = buildFileDropContent(strings.Repeat("a", store.MaxDropBytes), dir, longNames)
	if !strings.Contains(got, "目录: "+dir) || len(got) > store.MaxDropBytes {
		t.Fatalf("dir line must survive line truncation: %d", len(got))
	}
}

// quotaBoundedReader 边界探测：恰好收满（EOF）与仍有余量（errQuotaExceeded）
// 两向钉死——「配额精确填满属合法」的语义闸
func TestQuotaBoundedReader(t *testing.T) {
	// 恰好收满：3 字节流 × 闸 3 → EOF 收满
	qr := &quotaBoundedReader{r: strings.NewReader("abc"), remaining: 3}
	got, err := io.ReadAll(qr)
	if err != nil || string(got) != "abc" {
		t.Fatalf("exact fill broken: %q %v", got, err)
	}

	// 仍有余量：3 字节流 × 闸 2 → errQuotaExceeded
	qr = &quotaBoundedReader{r: strings.NewReader("abc"), remaining: 2}
	_, err = io.ReadAll(qr)
	if err != errQuotaExceeded {
		t.Fatalf("overflow must abort with errQuotaExceeded, got %v", err)
	}

	// 空 payload × 闸 0 → EOF（0 字节文件合法）
	qr = &quotaBoundedReader{r: strings.NewReader(""), remaining: 0}
	got, err = io.ReadAll(qr)
	if err != nil || len(got) != 0 {
		t.Fatalf("zero-quota empty part broken: %v", err)
	}
}
