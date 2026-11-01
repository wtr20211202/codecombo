package remote

import (
	"context"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/remoteterminal"
	"codecombo/server/sshclient"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// TestRemoteResourceID 远程终端资源 ID 白名单校验
// hostID（sc_rh_ 前缀）与 sessionId（32 hex）都必须落在字符集内；
// 路径穿越 / 盘符 / scheme 分隔符等危险形态必须拒绝
func TestRemoteResourceID(t *testing.T) {
	for _, ok := range []string{"abc", "a-b_C9", "0123456789012345678901234567890123456789012345678901234567890123"} {
		if !remoteResIDRe.MatchString(ok) {
			t.Errorf("should accept %q", ok)
		}
	}
	for _, bad := range []string{"", "../lock/config", `..\..\x`, "a:b", "a/b"} {
		if remoteResIDRe.MatchString(bad) {
			t.Errorf("should reject %q", bad)
		}
	}
}

// TestRemotePasteImageExt Content-Type 精确白名单映射（不用 contains——
// "image/png; x=application/x-sh" 之类畸形类型必须拒绝而非误判 png）
func TestRemotePasteImageExt(t *testing.T) {
	cases := []struct {
		ct      string
		wantExt string
		wantOK  bool
	}{
		{"image/png", ".png", true},
		{"image/jpeg", ".jpg", true},
		{"image/gif", ".gif", true},
		{"image/webp", ".webp", true},
		{"application/octet-stream", "", false},
		{"text/plain", "", false},
		{"", "", false},
		{"image/png; charset=utf-8", "", false}, // 带参数即拒绝（前端 blob.type 是精确值）
		{"ximage/png", "", false},
		{"IMAGE/PNG", "", false}, // 大小写敏感拒绝
	}
	for _, c := range cases {
		ext, ok := remotePasteImageExt(c.ct)
		if ok != c.wantOK || ext != c.wantExt {
			t.Errorf("remotePasteImageExt(%q) = (%q, %v), want (%q, %v)",
				c.ct, ext, ok, c.wantExt, c.wantOK)
		}
	}
}

// TestValidateRemotePaste 上传校验：合法通过 / 超大拒绝 / 非白名单拒绝
func TestValidateRemotePaste(t *testing.T) {
	newHeader := func(size int64, ct string) *multipart.FileHeader {
		return &multipart.FileHeader{
			Size:   size,
			Header: textproto.MIMEHeader{"Content-Type": []string{ct}},
		}
	}

	if ext, err := validateRemotePaste(newHeader(1024, "image/png")); err != nil || ext != ".png" {
		t.Errorf("valid paste should pass, got ext=%q err=%v", ext, err)
	}
	if _, err := validateRemotePaste(newHeader(remotePasteMaxBytes+1, "image/png")); err == nil {
		t.Error("oversize paste should be rejected")
	}
	if _, err := validateRemotePaste(newHeader(1024, "application/zip")); err == nil {
		t.Error("non-whitelisted content type should be rejected")
	}
}

// TestValidateRemotePasteFile file 形态校验（P-20261024-2）：白名单扩展名通过
// （lowercase 归一）/ 超大拒绝 / 白名单外与无扩展名拒绝
func TestValidateRemotePasteFile(t *testing.T) {
	newFileHeader := func(size int64, name string) *multipart.FileHeader {
		return &multipart.FileHeader{Size: size, Filename: name}
	}

	if ext, err := validateRemotePasteFile(newFileHeader(1024, "notes.md")); err != nil || ext != ".md" {
		t.Errorf("whitelisted ext should pass, got ext=%q err=%v", ext, err)
	}
	if ext, err := validateRemotePasteFile(newFileHeader(1024, "A.JPG")); err != nil || ext != ".jpg" {
		t.Errorf("uppercase ext should normalize, got ext=%q err=%v", ext, err)
	}
	if _, err := validateRemotePasteFile(newFileHeader(remotePasteFileMaxBytes+1, "a.zip")); err == nil {
		t.Error("oversize file should be rejected")
	}
	if _, err := validateRemotePasteFile(newFileHeader(1024, "evil.exe")); err == nil {
		t.Error("non-whitelisted ext should be rejected")
	}
	if _, err := validateRemotePasteFile(newFileHeader(1024, "Makefile")); err == nil {
		t.Error("extensionless file should be rejected in v1")
	}
}

// TestRemotePasteName 远程文件名格式：sc-paste-<unixms>-<8字节hex随机后缀><ext>
// 随机后缀防多用户主机的 /tmp symlink 抢占
func TestRemotePasteName(t *testing.T) {
	got := remotePasteName(1700000000123, "a1b2c3d4e5f60718", ".png")
	if want := "sc-paste-1700000000123-a1b2c3d4e5f60718.png"; got != want {
		t.Errorf("remotePasteName = %q, want %q", got, want)
	}
	suffix, err := remotePasteRandHex()
	if err != nil {
		t.Fatalf("remotePasteRandHex error: %v", err)
	}
	if len(suffix) != 16 || strings.ContainsAny(suffix, "ghijklmnopqrstuvwxyz") {
		t.Errorf("rand suffix should be 16 hex chars, got %q", suffix)
	}
	// 两次调用应不同（crypto/rand）
	other, _ := remotePasteRandHex()
	if suffix == other {
		t.Errorf("rand suffix repeated: %q", suffix)
	}
}

// TestResolveRemoteHostAuth 凭据解析短路路径：
// 非 sshkey 认证 / sshkey 但未引用 SshKeyID 时不触 store 直接通过
// （sshkey 引用路径依赖真实 SshKey store，由集成链路覆盖）
func TestResolveRemoteHostAuth(t *testing.T) {
	rh := &config.RemoteHost{AuthType: sshclient.AuthTypePassword, Password: "pw", PemContent: ""}
	if err := ResolveRemoteHostAuth(rh); err != nil {
		t.Errorf("password auth should pass without store access, got %v", err)
	}
	if rh.PemContent != "" {
		t.Errorf("password auth must not touch PemContent, got %q", rh.PemContent)
	}

	pem := &config.RemoteHost{AuthType: sshclient.AuthTypePem, PemContent: "pem-body"}
	if err := ResolveRemoteHostAuth(pem); err != nil {
		t.Errorf("pem auth should pass, got %v", err)
	}
	if pem.PemContent != "pem-body" {
		t.Errorf("pem auth must keep existing PemContent, got %q", pem.PemContent)
	}

	noRef := &config.RemoteHost{AuthType: sshclient.AuthTypeSshKey, SshKeyID: ""}
	if err := ResolveRemoteHostAuth(noRef); err != nil {
		t.Errorf("sshkey auth without key id should pass, got %v", err)
	}
}

// TestRemoteResIDReIsAnchored 校验正则锚定（防换行拼接绕过）
func TestRemoteResIDReIsAnchored(t *testing.T) {
	if remoteResIDRe.MatchString("abc\n../etc") {
		t.Error("multiline injection should be rejected")
	}
	// 长度上界 64：65 长度必须拒绝
	if remoteResIDRe.MatchString(strings.Repeat("a", 65)) {
		t.Error("should reject 65-char id (max 64)")
	}
}

// TestNormalizeRemoteSize 尺寸归一化：0 取默认、超上限钳制、边界值与合法值原样通过
func TestNormalizeRemoteSize(t *testing.T) {
	cases := []struct {
		name               string
		rows, cols         uint16
		wantRows, wantCols uint16
	}{
		{"zero -> defaults", 0, 0, 24, 80},
		{"only rows zero", 0, 120, 24, 120},
		{"only cols zero", 40, 0, 40, 80},
		{"valid passthrough", 30, 100, 30, 100},
		{"min bounds", 1, 1, 1, 1},
		{"max bounds", 512, 1024, 512, 1024},
		{"oversize clamped", 60000, 60000, 512, 1024},
		{"one past max", 513, 1025, 512, 1024},
	}
	for _, c := range cases {
		gotRows, gotCols := normalizeRemoteSize(c.rows, c.cols)
		if gotRows != c.wantRows || gotCols != c.wantCols {
			t.Errorf("%s: normalizeRemoteSize(%d, %d) = (%d, %d), want (%d, %d)",
				c.name, c.rows, c.cols, gotRows, gotCols, c.wantRows, c.wantCols)
		}
	}
}

// ============== WS 主循环退出机制回归（I1） ==============

// silentPTY 测试用 PTY 连接：Read 阻塞直至 Close（模拟"远端无输出"——
// 正是旧实现主循环永久阻塞的场景：outputChan 恒空，唯一出路是 clientGone）
type silentPTY struct {
	closed chan struct{}
}

func newSilentPTY() *silentPTY { return &silentPTY{closed: make(chan struct{})} }

func (p *silentPTY) Read(b []byte) (int, error) {
	<-p.closed
	return 0, io.EOF
}
func (p *silentPTY) Write(b []byte) (int, error) { return len(b), nil }
func (p *silentPTY) Resize(uint16, uint16) error { return nil }
func (p *silentPTY) Close() error {
	select {
	case <-p.closed:
	default:
		close(p.closed)
	}
	return nil
}
func (p *silentPTY) SetReadDeadline(time.Time) error { return nil }

// adminDialerFunc admin 包内的函数适配 Dialer 接口（remoteterminal 包测试有同名 dialerFunc，跨包不冲突）
type adminDialerFunc func(spec remoteterminal.SessionSpec) (remoteterminal.PTYConn, error)

func (f adminDialerFunc) DialPTY(spec remoteterminal.SessionSpec) (remoteterminal.PTYConn, error) {
	return f(spec)
}

// TestRemoteTerminalWSClientGone I1 回归：客户端断开后主循环必须退出并释放连接位。
// 机制：读 goroutine defer close(clientGone)，主循环 select 兜底该分支——
// WS hijack 后 request ctx 不再随连接关闭触发 Done，远端无输出时
// outputChan 恒空，缺此分支则 connHeld 永久占用（重连永久 409 + GC 不启动 + 泄漏）。
// 验证方式：真实 WS 握手（httptest + gorilla dialer）→ 客户端关闭 → 轮询连接位可重占。
func TestRemoteTerminalWSClientGone(t *testing.T) {
	// 经模块装配注入测试 Manager（M2.1：SetManager setter 已消除，
	// 模块 Init/Stop 即装配/卸载入口）
	// GC 窗口取长（1 分钟）：断言窗口内连接位被释放，避免 GC Kill 抢跑干扰判定
	m := remoteterminal.NewManagerWithGC(
		adminDialerFunc(func(spec remoteterminal.SessionSpec) (remoteterminal.PTYConn, error) {
			return newSilentPTY(), nil
		}), 5, time.Minute)
	mod := remoteterminal.NewModuleWithManager(m)
	if err := mod.Init(context.Background(), nil); err != nil {
		t.Fatalf("init remoteterminal module: %v", err)
	}
	defer func() { _ = mod.Stop(context.Background(), nil) }()

	s, err := m.CreateSession("host-test", 24, 80, "")
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	defer m.KillSession(s.ID)

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/ws/remote-terminal/:id", RemoteTerminalWS)
	srv := httptest.NewServer(r)
	defer srv.Close()

	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/remote-terminal/" + s.ID
	ws, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}

	// 客户端主动断开 → 服务端读 goroutine 读错退出 → clientGone close
	// → 主循环 return → defer ReleaseConn 释放连接位
	_ = ws.Close()

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if s.TryAcquireConn() {
			s.ReleaseConn()
			return // 连接位已释放，主循环退出机制生效
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("connection slot never released after client disconnect (WS main loop stuck)")
}
