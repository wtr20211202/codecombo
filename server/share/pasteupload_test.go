package share

import (
	"bytes"
	"encoding/json"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"codecombo/server/notification"
	"codecombo/server/store"
)

// 访客粘贴上传端点（P-20261122-1 必改1）单测：
//   - mode-aware 门禁三档：只读/双开关全关 404 存在性不可探测；open 即准入；
//     hold 模式无持权 403 / 持权准入
//   - 白名单/限额：image CT 四类白名单 10MB、file 扩展名白名单 20MB、超限 400
//   - 落盘形态：sc-paste- 前缀（paste-cleaner 匹配面）+ 扩展名随形态、内容一致
//   - 副作用旁路：审计 share.pasteUpload、敏感名才发 note、ops 广播事件
//   - 频控：第 11 次 429（(token,IP) 维度）
//   - gateGuard 集成：口令记录未持门会话 401

// pasteShare 构造一条 terminal 直播分享（writable/guestInputOff 按档组合）
func pasteShare(token string, writable, guestInputOff bool) *store.Share {
	return &store.Share{
		Token: token, Kind: store.ShareKindTerminal, TerminalID: "sess-pu",
		Name: "粘贴上传", CreatedAt: time.Now(),
		Writable: writable, GuestInputOff: guestInputOff,
	}
}

// postPasteUpload 以 file/image 形态发起一次访客上传请求（contentType 非空时
// 以自定义 part 头携带——multipart.CreateFormFile 恒写 application/octet-stream，
// image 形态 CT 白名单的覆盖需要显式头）
func postPasteUpload(t *testing.T, svc *Service, token, fieldName, fileName, contentType string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", mime.FormatMediaType("form-data", map[string]string{"name": fieldName, "filename": fileName}))
	if contentType != "" {
		h.Set("Content-Type", contentType)
	}
	part, err := mw.CreatePart(h)
	if err != nil {
		t.Fatalf("CreatePart: %v", err)
	}
	if _, err := part.Write(body); err != nil {
		t.Fatalf("write part: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}
	req := httptest.NewRequest("POST", "/s/"+token+"/paste-upload", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.SetPathValue("token", token)
	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, req)
	return rec
}

func pasteUploadData(t *testing.T, body []byte) (path string, size int64) {
	t.Helper()
	var out struct {
		Data struct {
			Path string `json:"path"`
			Size int64  `json:"size"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return out.Data.Path, out.Data.Size
}

// 只读形态（非 terminal）与双开关全关：恒 404 与「端点不存在」不可区分
func TestPasteUploadGate404(t *testing.T) {
	token := fixedToken("pu404")
	shares := fakeShares{token: {Token: token, Kind: store.ShareKindSnippet, Name: "snip", CreatedAt: time.Now()}}
	svc := NewService(shares, fakeRoots{}, nil)
	if rec := postPasteUpload(t, svc, token, "file", "a.txt", "text/plain", []byte("x")); rec.Code != http.StatusNotFound {
		t.Fatalf("snippet form status = %d, want 404", rec.Code)
	}
	token2 := fixedToken("pu404ro")
	shares[token2] = &store.Share{Token: token2, Kind: store.ShareKindTerminal, TerminalID: "s", Name: "ro", CreatedAt: time.Now(), Writable: false, GuestInputOff: true}
	if rec := postPasteUpload(t, svc, token2, "file", "a.txt", "text/plain", []byte("x")); rec.Code != http.StatusNotFound {
		t.Fatalf("both-off form status = %d, want 404", rec.Code)
	}
	// 未登记 token 同样 404（token 空间不可枚举的既有语义）
	rec := postPasteUpload(t, svc, fixedToken("pu404xx"), "file", "a.txt", "text/plain", []byte("x"))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown token status = %d, want 404", rec.Code)
	}
}

// open 模式即准入：file 形态白名单扩展名落盘成功（开放连接不进 holds 账本，
// 绑 holds 判定会误拒 open——本用例即该回归的防线）
func TestPasteUploadOpenModeAdmits(t *testing.T) {
	token := fixedToken("puopen")
	svc := NewService(fakeShares{token: pasteShare(token, true, false)}, fakeRoots{}, nil)
	rec := postPasteUpload(t, svc, token, "file", "notes.txt", "text/plain", []byte("hello paste"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s, want 200", rec.Code, rec.Body.String())
	}
	path, size := pasteUploadData(t, rec.Body.Bytes())
	defer os.Remove(path)
	if !strings.Contains(path, "sc-paste-") || filepath.Ext(path) != ".txt" {
		t.Fatalf("path = %q, want sc-paste-*.txt", path)
	}
	if size != int64(len("hello paste")) {
		t.Fatalf("size = %d", size)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != "hello paste" {
		t.Fatalf("content mismatch: %v %q", err, got)
	}
}

// hold 模式持权门：无持权 403 direct_denied；持权（direct.grant 绑 visitorId）
// 准入且上传顺带 touch 续期
func TestPasteUploadHoldModeGate(t *testing.T) {
	token := fixedToken("puhold")
	sh := pasteShare(token, false, false) // 申请通道在场、未开直入
	svc := NewService(fakeShares{token: sh}, fakeRoots{}, nil)
	// 无持权：403
	if rec := postPasteUpload(t, svc, token, "file", "a.txt", "text/plain", []byte("x")); rec.Code != http.StatusForbidden {
		t.Fatalf("no-hold status = %d, want 403", rec.Code)
	}
	// 持权授予（走申请-批准握手真实路径）：FormValue 带 visitorId 准入
	now := time.Now()
	svc.direct.request(token, "v-hold-1", "", now)
	svc.direct.grant(token, "v-hold-1", "", "sess-1", now)
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	if err := mw.WriteField("visitorId", "v-hold-1"); err != nil {
		t.Fatalf("write field: %v", err)
	}
	part, err := mw.CreateFormFile("file", "held.png")
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := part.Write([]byte("png")); err != nil {
		t.Fatalf("write part: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}
	req := httptest.NewRequest("POST", "/s/"+token+"/paste-upload", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.SetPathValue("token", token)
	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("held status = %d body=%s, want 200", rec.Code, rec.Body.String())
	}
	path, _ := pasteUploadData(t, rec.Body.Bytes())
	defer os.Remove(path)
	if filepath.Ext(path) != ".png" {
		t.Fatalf("ext = %q, want .png", filepath.Ext(path))
	}
	// 他人 visitorId：403（持权绑定单访客）
	var buf2 bytes.Buffer
	mw2 := multipart.NewWriter(&buf2)
	if err := mw2.WriteField("visitorId", "v-other"); err != nil {
		t.Fatalf("write field: %v", err)
	}
	p2, err := mw2.CreateFormFile("file", "b.txt")
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := p2.Write([]byte("x")); err != nil {
		t.Fatalf("write part: %v", err)
	}
	if err := mw2.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}
	req2 := httptest.NewRequest("POST", "/s/"+token+"/paste-upload", &buf2)
	req2.Header.Set("Content-Type", mw2.FormDataContentType())
	req2.SetPathValue("token", token)
	rec2 := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusForbidden {
		t.Fatalf("other-visitor status = %d, want 403", rec2.Code)
	}
}

// 白名单与限额：image CT 四类精确白名单（四类之外 400 unsupported_type，
// P-20261122-18 ⑦）、file 扩展名白名单（.exe 拒绝）、image 10MB 上限（免造大
// 体用 header.Size 短路路径——构造真实 multipart 才到得了校验，此处以小体验
// 语义边界）
func TestPasteUploadWhitelists(t *testing.T) {
	token := fixedToken("puwl")
	svc := NewService(fakeShares{token: pasteShare(token, true, false)}, fakeRoots{}, nil)
	// image 形态 CT 四类之外：400 unsupported_type（旧实现静默落 .png——
	// 扩展名不可信就落盘会产出「名字说 png、内容是别的」的文件交给主机 shell）
	for _, ct := range []string{"application/octet-stream", "image/svg+xml", "image/bmp", "image/avif", ""} {
		rec := postPasteUpload(t, svc, token, "image", "shot.bin", ct, []byte("x"))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("image ct=%q status = %d body=%s, want 400", ct, rec.Code, rec.Body.String())
		}
		if body := rec.Body.String(); !strings.Contains(body, "unsupported_type") {
			t.Fatalf("image ct=%q body = %s, want unsupported_type", ct, body)
		}
	}
	// image 四类各落对应扩展名（png/jpeg/gif/webp；jpeg 归 .jpg）。频控按
	// Service 实例计数（(token,IP) 10/min）——拒绝组已用 5 次，白名单组换
	// 新实例，避免用例自身撞频控闸（429）
	svcOK := NewService(fakeShares{token: pasteShare(token, true, false)}, fakeRoots{}, nil)
	for ct, wantExt := range map[string]string{
		"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
	} {
		rec := postPasteUpload(t, svcOK, token, "image", "shot.bin", ct, []byte("x"))
		if rec.Code != http.StatusOK {
			t.Fatalf("image %s status = %d body=%s", ct, rec.Code, rec.Body.String())
		}
		p, _ := pasteUploadData(t, rec.Body.Bytes())
		if filepath.Ext(p) != wantExt {
			t.Fatalf("image %s ext = %q, want %q", ct, filepath.Ext(p), wantExt)
		}
		_ = os.Remove(p)
	}
	// CT 带参数（非浏览器客户端合法形态）：归一后仍命中白名单
	rec := postPasteUpload(t, svcOK, token, "image", "shot.bin", "image/png; charset=binary", []byte("x"))
	if rec.Code != http.StatusOK {
		t.Fatalf("image param-ct status = %d body=%s", rec.Code, rec.Body.String())
	}
	p, _ := pasteUploadData(t, rec.Body.Bytes())
	defer os.Remove(p)
	if filepath.Ext(p) != ".png" {
		t.Fatalf("param-ct ext = %q, want .png", filepath.Ext(p))
	}
	// file 形态扩展名白名单外：400 unsupported_type
	svcFile := NewService(fakeShares{token: pasteShare(token, true, false)}, fakeRoots{}, nil)
	if rec := postPasteUpload(t, svcFile, token, "file", "evil.exe", "application/octet-stream", []byte("x")); rec.Code != http.StatusBadRequest {
		t.Fatalf("exe status = %d, want 400", rec.Code)
	}
	// 双字段全缺：400 no_file
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	mw.Close()
	req := httptest.NewRequest("POST", "/s/"+token+"/paste-upload", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.SetPathValue("token", token)
	rec2 := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec2, req)
	if rec2.Code != http.StatusBadRequest {
		t.Fatalf("no-file status = %d, want 400", rec2.Code)
	}
}

// 副作用旁路：审计 share.pasteUpload 入账（元数据口径）、敏感名命中才发 note、
// ops 广播事件成型
func TestPasteUploadSideEffects(t *testing.T) {
	token := fixedToken("puse")
	sh := pasteShare(token, true, false)
	svc := NewService(fakeShares{token: sh}, fakeRoots{}, nil)
	var events []PasteUploadEvent
	svc = svc.WithPasteUploadEvents(func(ev PasteUploadEvent) { events = append(events, ev) })
	// 普通名：审计+广播，note 缓冲为空
	rec := postPasteUpload(t, svc, token, "file", "diagram.png", "image/png", []byte("px"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	p, _ := pasteUploadData(t, rec.Body.Bytes())
	defer os.Remove(p)
	flushed := svc.FlushViewAudits(func(e store.AuditEvent) {})
	if flushed != 1 {
		t.Fatalf("audits flushed = %d, want 1", flushed)
	}
	if len(events) != 1 || events[0].Name != "diagram.png" || events[0].Mode != "open" || events[0].TerminalID != "sess-pu" {
		t.Fatalf("event = %+v", events)
	}
	if n := svc.FlushGuestNotes(func(notification.Notification) {}); n != 0 {
		t.Fatalf("non-sensitive note count = %d, want 0", n)
	}
	// 敏感名（IsSensitiveName 模式表命中）：note 恰一条
	rec = postPasteUpload(t, svc, token, "file", "credentials.json", "text/plain", []byte("x"))
	if rec.Code != http.StatusOK {
		t.Fatalf("sensitive status = %d", rec.Code)
	}
	p2, _ := pasteUploadData(t, rec.Body.Bytes())
	defer os.Remove(p2)
	if n := svc.FlushGuestNotes(func(notification.Notification) {}); n != 1 {
		t.Fatalf("sensitive note count = %d, want 1", n)
	}
	if len(events) != 2 {
		t.Fatalf("events = %d, want 2", len(events))
	}
}

// 频控：(token,IP) 每分钟 10 次，第 11 次 429 + Retry-After
func TestPasteUploadRateLimit(t *testing.T) {
	token := fixedToken("pu429")
	svc := NewService(fakeShares{token: pasteShare(token, true, false)}, fakeRoots{}, nil)
	for i := 0; i < 10; i++ {
		rec := postPasteUpload(t, svc, token, "file", "a.txt", "text/plain", []byte("x"))
		if rec.Code != http.StatusOK {
			t.Fatalf("req #%d status = %d, want 200", i+1, rec.Code)
		}
		if p, _ := pasteUploadData(t, rec.Body.Bytes()); p != "" {
			os.Remove(p)
		}
	}
	rec := postPasteUpload(t, svc, token, "file", "a.txt", "text/plain", []byte("x"))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("req #11 status = %d, want 429", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("429 must carry Retry-After")
	}
}

// gateGuard 集成：口令记录未持门会话 401（粘贴上传在口令门后，路由注册面）
func TestPasteUploadPassphraseGate(t *testing.T) {
	token := fixedToken("pupass")
	sh := pasteShare(token, true, false)
	sh.PassphraseHash = "h"
	svc := NewService(fakeShares{token: sh}, fakeRoots{}, nil)
	if rec := postPasteUpload(t, svc, token, "file", "a.txt", "text/plain", []byte("x")); rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 passphrase_required", rec.Code)
	}
}

// 审计动作词条契约（check:audit-actions 的 Go 侧哨兵）：share.pasteUpload 常量
// 在册——词条对账在前端 check 链，此处锚定常量值不漂移
func TestPasteUploadAuditKeyShape(t *testing.T) {
	if store.AuditSharePasteUpload != "share.pasteUpload" {
		t.Fatalf("audit key = %q, want share.pasteUpload", store.AuditSharePasteUpload)
	}
}
