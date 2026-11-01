package remote

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path"
	"strings"
	"testing"

	"codecombo/server/filepolicy"
	"codecombo/server/filestore"
	"codecombo/server/sshclient"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// ============== 编辑器读写端点单测（fake 通道直驱，不经真实 SSH） ==============
//
// 远端路径全程走 SFTP 线协议直传无 shell 拼接面，但「特殊字符路径端到端不
// 被误处理」仍是任务书点名的硬要求——这里以记录全部通道调用的 fake 覆盖：
// 空格/单引号/$/反引号/括号/CJK 的路径读写 round-trip、临时文件落同目录、
// 换名目标逐字节精确、409/415/413 守卫、gbk 标签回写。

// recordFileClient 在 fakeFileClient 基础上记录全部写通道调用（Upload/Rename/
// Chmod/RemoveAll），供写入路径断言
type recordFileClient struct {
	fakeFileClient
	uploads   map[string]string // 路径 → 写入内容
	renames   [][2]string
	chmods    map[string]os.FileMode
	removed   []string
	renameErr error                  // 非 nil 时 Rename 恒失败（posix-rename 不支持的服务端形态）
	statSizes map[string]int64       // Stat 尺寸覆写（「Stat 报小、内容超限」的间隙膨胀形态）
	modes     map[string]os.FileMode // Mode 覆写（原权限位保留断言）
}

func newRecordClient(files map[string]string) *recordFileClient {
	if files == nil {
		files = map[string]string{}
	}
	return &recordFileClient{
		fakeFileClient: fakeFileClient{files: files},
		uploads:        map[string]string{},
		chmods:         map[string]os.FileMode{},
	}
}

func (f *recordFileClient) Stat(p string) (int64, bool, error) {
	if sz, ok := f.statSizes[p]; ok {
		return sz, false, nil
	}
	return f.fakeFileClient.Stat(p)
}

func (f *recordFileClient) Upload(r io.Reader, p string) error {
	b, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	f.uploads[p] = string(b)
	// 与真实通道一致：上传即落位（rename 搬移语义据此可推演）
	f.files[p] = string(b)
	return nil
}

func (f *recordFileClient) Rename(from, to string) error {
	if f.renameErr != nil {
		return f.renameErr
	}
	f.renames = append(f.renames, [2]string{from, to})
	// 换名语义落地：files 表同步搬移（覆盖语义）
	if c, ok := f.files[from]; ok {
		f.files[to] = c
		delete(f.files, from)
	}
	return nil
}

func (f *recordFileClient) Chmod(p string, mode os.FileMode) error {
	f.chmods[p] = mode
	return nil
}

func (f *recordFileClient) Mode(p string) (os.FileMode, error) {
	if m, ok := f.modes[p]; ok {
		return m, nil
	}
	return 0, os.ErrNotExist
}

func (f *recordFileClient) RemoveAll(p string) error {
	f.removed = append(f.removed, p)
	delete(f.files, p)
	return nil
}

func ginTestCtx(t *testing.T) (*gin.Context, *httptest.ResponseRecorder) {
	t.Helper()
	// 写路径成功收尾会入账审计（remotehost.file.write）+ 状态点回写——
	// 本文件全部用例经此装配独立临时数据面（securitynotify 测试同款）。
	// id 避开 status 测试的 "sc_rh_test"：statusCache 是包级全局，
	// MarkAuthOK 的粘性 AuthOK 会跨用例污染（实测踩过）
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodGet, "/content", nil)
	c.Params = gin.Params{{Key: "id", Value: "sc_rh_contenttest"}}
	return c, w
}

func mustDecodeBody(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("decode response body: %v\nbody: %s", err, w.Body.String())
	}
	return m
}

// TestReadRemoteContentText 普通 UTF-8 文本：200 + hash 与内容字节一致
func TestReadRemoteContentText(t *testing.T) {
	fc := newRecordClient(map[string]string{"/etc/app.conf": "hello 世界\n"})
	c, w := ginTestCtx(t)
	readRemoteContentHandler(c, fc, "/etc/app.conf")

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	m := mustDecodeBody(t, w)
	if m["data"] != "hello 世界\n" {
		t.Fatalf("data = %q", m["data"])
	}
	if m["hash"] != contentHash([]byte("hello 世界\n")) {
		t.Fatalf("hash mismatch: %v", m["hash"])
	}
	if _, has := m["encoding"]; has {
		t.Fatalf("utf-8 文本不应带 encoding 标签")
	}
}

// TestReadRemoteContentSpecialCharPath 特殊字符路径 round-trip：空格/引号/$/
// 反引号/括号/CJK 混排路径——SFTP 线协议直传语义下逐字节保真
func TestReadRemoteContentSpecialCharPath(t *testing.T) {
	weird := `/etc/nginx/sites-enabled/my site$.conf 'quote' ` + "`tick`" + ` (v1) 配置.conf`
	fc := newRecordClient(map[string]string{weird: "ok"})
	c, w := ginTestCtx(t)
	readRemoteContentHandler(c, fc, weird)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	if got := mustDecodeBody(t, w)["data"]; got != "ok" {
		t.Fatalf("data = %q, want ok", got)
	}
}

// TestReadRemoteContentBinaryNUL 前 8KB 含 NUL → 415，正文不外发
func TestReadRemoteContentBinaryNUL(t *testing.T) {
	raw := append([]byte("text head"), make([]byte, 64)...) // NUL 在嗅探窗内
	fc := newRecordClient(map[string]string{"/bin/blob.dat": string(raw)})
	c, w := ginTestCtx(t)
	readRemoteContentHandler(c, fc, "/bin/blob.dat")
	if w.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("status = %d, want 415; body=%s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "text head") {
		t.Fatalf("415 正文不得外发内容")
	}
}

// TestReadRemoteContentBinaryExt 扩展名二进制（.png）即使纯文本字节也 415
func TestReadRemoteContentBinaryExt(t *testing.T) {
	fc := newRecordClient(map[string]string{"/img/logo.png": "plain text"})
	c, w := ginTestCtx(t)
	readRemoteContentHandler(c, fc, "/img/logo.png")
	if w.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("status = %d, want 415", w.Code)
	}
}

// TestReadRemoteContentUTF16BOMNotBinary UTF-16 BOM 文件合法含 NUL → 不判二进制
func TestReadRemoteContentUTF16BOMNotBinary(t *testing.T) {
	raw := []byte{0xFF, 0xFE, 'h', 0, 'i', 0} // "hi" UTF-16LE + BOM
	fc := newRecordClient(map[string]string{"/notes/unicode.txt": string(raw)})
	c, w := ginTestCtx(t)
	readRemoteContentHandler(c, fc, "/notes/unicode.txt")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	m := mustDecodeBody(t, w)
	if m["encoding"] != filepolicy.EncodingUTF16LE {
		t.Fatalf("encoding = %v, want utf16le", m["encoding"])
	}
}

// TestReadRemoteContentTooLarge 超上限 → 413
func TestReadRemoteContentTooLarge(t *testing.T) {
	big := strings.Repeat("a", int(filesContentMaxBytes)+1)
	fc := newRecordClient(map[string]string{"/var/log/big.log": big})
	c, w := ginTestCtx(t)
	readRemoteContentHandler(c, fc, "/var/log/big.log")
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", w.Code)
	}
}

// TestReadRemoteContentDir 目录 → 400
func TestReadRemoteContentDir(t *testing.T) {
	fc := newRecordClient(nil)
	fc.dirs = map[string][]sshclient.DirEntry{"/etc": {{Name: "app.conf"}}}
	c, w := ginTestCtx(t)
	readRemoteContentHandler(c, fc, "/etc")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

// TestReadRemoteContentMissing 读取失败（文件不存在）→ 502（远端侧失败统一网关语义）
func TestReadRemoteContentMissing(t *testing.T) {
	fc := newRecordClient(nil)
	c, w := ginTestCtx(t)
	readRemoteContentHandler(c, fc, "/gone.txt")
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", w.Code)
	}
}

// TestWriteRemoteContentAtomicFlow 写入：tmp 落同目录 + 换名目标精确 + hash 回传
func TestWriteRemoteContentAtomicFlow(t *testing.T) {
	fc := newRecordClient(map[string]string{"/etc/app.conf": "old"})
	c, w := ginTestCtx(t)
	data := []byte("new content 中文")
	writeRemoteContentHandler(c, fc, "/etc/app.conf", data, "", "")

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	m := mustDecodeBody(t, w)
	if m["hash"] != contentHash(data) {
		t.Fatalf("hash mismatch: %v", m["hash"])
	}
	if len(fc.renames) != 1 {
		t.Fatalf("renames = %v, want exactly one", fc.renames)
	}
	from, to := fc.renames[0][0], fc.renames[0][1]
	if to != "/etc/app.conf" {
		t.Fatalf("rename target = %q, want /etc/app.conf", to)
	}
	// tmp 必须落目标同目录（同文件系统是 rename 原子性的前提）
	if dirOf(from) != "/etc" {
		t.Fatalf("tmp dir = %q, want /etc", dirOf(from))
	}
	if fc.uploads[from] != string(data) {
		t.Fatalf("tmp content = %q", fc.uploads[from])
	}
	if fc.chmods[from] != 0644 { // fake Stat 无 mode 信息，缺省 0644
		t.Fatalf("chmod = %v, want 0644", fc.chmods[from])
	}
	if len(fc.removed) != 0 {
		t.Fatalf("成功路径不应清理任何文件: %v", fc.removed)
	}
	// 换名落位：目标内容即新内容，tmp 不残留
	if fc.files["/etc/app.conf"] != string(data) {
		t.Fatalf("target content = %q", fc.files["/etc/app.conf"])
	}
	if _, still := fc.files[from]; still {
		t.Fatalf("tmp %q 未随换名消失", from)
	}
}

// TestWriteRemoteContentSpecialCharPath 特殊字符路径写入：tmp 同目录、目标逐字节
func TestWriteRemoteContentSpecialCharPath(t *testing.T) {
	weird := `/opt/my app$/` + `conf 'q'` + " (v2) 路径.env"
	fc := newRecordClient(map[string]string{weird: "old"})
	c, w := ginTestCtx(t)
	writeRemoteContentHandler(c, fc, weird, []byte("v2"), "", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", w.Code, w.Body.String())
	}
	if len(fc.renames) != 1 || fc.renames[0][1] != weird {
		t.Fatalf("renames = %v, want single rename to %q", fc.renames, weird)
	}
	if dirOf(fc.renames[0][0]) != "/opt/my app$" {
		t.Fatalf("tmp dir = %q", dirOf(fc.renames[0][0]))
	}
	if fc.files[weird] != "v2" {
		t.Fatalf("target content = %q", fc.files[weird])
	}
}

// TestWriteRemoteContentConflict 陈旧基线 → 409 + 远端当前内容；远端不被改动
func TestWriteRemoteContentConflict(t *testing.T) {
	fc := newRecordClient(map[string]string{"/etc/app.conf": "remote-current"})
	c, w := ginTestCtx(t)
	writeRemoteContentHandler(c, fc, "/etc/app.conf", []byte("stale save"), "", contentHash([]byte("opened-version")))
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", w.Code, w.Body.String())
	}
	m := mustDecodeBody(t, w)
	if m["currentContent"] != "remote-current" {
		t.Fatalf("currentContent = %v", m["currentContent"])
	}
	if len(fc.renames) != 0 || len(fc.uploads) != 0 {
		t.Fatalf("409 不得触碰远端: renames=%v uploads=%v", fc.renames, fc.uploads)
	}
}

// TestWriteRemoteContentMatchingHash 匹配基线放行直写
func TestWriteRemoteContentMatchingHash(t *testing.T) {
	data := []byte("same")
	fc := newRecordClient(map[string]string{"/etc/app.conf": string(data)})
	c, w := ginTestCtx(t)
	writeRemoteContentHandler(c, fc, "/etc/app.conf", data, "", contentHash(data))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
}

// TestWriteRemoteContentMissingTargetSkipsDetect 目标已被删除：跳过检测直写重建
func TestWriteRemoteContentMissingTargetSkipsDetect(t *testing.T) {
	fc := newRecordClient(nil) // 空 files：Stat/Open 均 not found
	c, w := ginTestCtx(t)
	writeRemoteContentHandler(c, fc, "/etc/new.conf", []byte("fresh"), "", "somehash")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	if len(fc.renames) != 1 || fc.files["/etc/new.conf"] != "fresh" {
		t.Fatalf("重建写失败: renames=%v files=%v", fc.renames, fc.files)
	}
}

// TestWriteRemoteContentRenameFallback posix-rename 不可用且目标已存在的服务端：
// 降级直写覆盖成功，tmp 清理不留远端垃圾
func TestWriteRemoteContentRenameFallback(t *testing.T) {
	fc := newRecordClient(map[string]string{"/etc/app.conf": "old"})
	fc.renameErr = fmt.Errorf("sftp: rename: failure (target exists)")
	c, w := ginTestCtx(t)
	writeRemoteContentHandler(c, fc, "/etc/app.conf", []byte("direct"), "", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	if fc.uploads["/etc/app.conf"] != "direct" {
		t.Fatalf("降级直写未落目标: %v", fc.uploads)
	}
	if len(fc.removed) == 0 || dirOf(fc.removed[0]) != "/etc" {
		t.Fatalf("tmp 未清理: %v", fc.removed)
	}
}

// TestWriteRemoteContentEncodingGBK gbk 标签回写：字节按原编码落盘不被转 UTF-8
func TestWriteRemoteContentEncodingGBK(t *testing.T) {
	fc := newRecordClient(map[string]string{"/var/notes.txt": ""})
	gbkBytes := []byte{0xD6, 0xD0, 0xCE, 0xC4} // "中文" GB18030
	c, w := ginTestCtx(t)
	// 传入的是编辑器 UTF-8 文本 + gbk 标签（writeRemoteFileContent 调用方
	// 已做 base64 解码，本层收到的即 UTF-8 原文）
	writeRemoteContentHandler(c, fc, "/var/notes.txt", []byte("中文"), "gbk", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", w.Code, w.Body.String())
	}
	from := fc.renames[0][0]
	if !bytes.Equal([]byte(fc.uploads[from]), gbkBytes) {
		t.Fatalf("落盘字节 = %x, want gbk %x", fc.uploads[from], gbkBytes)
	}
}

// TestWriteRemoteContentPreservesMode 原权限位保留：目标 0755 的可执行脚本编辑
// 保存后权限位不变（对齐提案 chmod --reference 意图）
func TestWriteRemoteContentPreservesMode(t *testing.T) {
	fc := newRecordClient(map[string]string{"/usr/local/bin/run.sh": "#!/bin/sh\n"})
	fc.modes = map[string]os.FileMode{"/usr/local/bin/run.sh": 0o755}
	c, w := ginTestCtx(t)
	writeRemoteContentHandler(c, fc, "/usr/local/bin/run.sh", []byte("#!/bin/sh\nset -e\n"), "", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body=%s", w.Code, w.Body.String())
	}
	from := fc.renames[0][0]
	if fc.chmods[from] != 0o755 {
		t.Fatalf("chmod = %v, want 0755（原权限位必须保留）", fc.chmods[from])
	}
}

// TestReadLimitedGrowthStat Stat 与读取间隙文件膨胀：有界读取截断不越内存预算
func TestReadLimitedGrowthStat(t *testing.T) {
	big := strings.Repeat("a", int(filesContentMaxBytes)+100)
	fc := newRecordClient(map[string]string{"/big.conf": big})
	// Stat 报小（间隙膨胀前），Open 读出超限——truncated 分支兜底 413
	fc.statSizes = map[string]int64{"/big.conf": 10}
	c, w := ginTestCtx(t)
	readRemoteContentHandler(c, fc, "/big.conf")
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", w.Code)
	}
}

// ============== 纯函数小件 ==============

func TestSniffHasNUL(t *testing.T) {
	if !sniffHasNUL([]byte("abc\x00def"), 8) {
		t.Fatalf("NUL 窗内未命中")
	}
	if sniffHasNUL([]byte("abcdef"), 8) {
		t.Fatalf("纯文本误报")
	}
	if sniffHasNUL([]byte("ab\x00"), 2) {
		t.Fatalf("窗外 NUL 不应命中")
	}
	if !hasUTF16BOM([]byte{0xFF, 0xFE, 'x'}) || !hasUTF16BOM([]byte{0xFE, 0xFF, 'x'}) {
		t.Fatalf("BOM 探测失灵")
	}
	if hasUTF16BOM([]byte("plain")) {
		t.Fatalf("纯文本误报 BOM")
	}
}

// TestTmpPathShape 临时文件名形态：同目录 + 固定前缀 + 保留原名（防并发互踩
// 的随机段 + 排障可读性）
func TestTmpPathShape(t *testing.T) {
	tmp := tmpPathFor("/etc/nginx/nginx.conf")
	if dirOf(tmp) != "/etc/nginx" {
		t.Fatalf("tmp dir = %q", dirOf(tmp))
	}
	base := path.Base(tmp)
	if !strings.HasPrefix(base, ".sc-tmp-") || !strings.HasSuffix(base, "nginx.conf") {
		t.Fatalf("tmp name = %q", base)
	}
	if tmp2 := tmpPathFor("/etc/a.conf"); tmp == tmp2 {
		t.Fatalf("tmp 名必须带随机段防并发互踩")
	}
}

// ============== 辅助 ==============

func dirOf(p string) string {
	idx := strings.LastIndex(p, "/")
	if idx <= 0 {
		return "/"
	}
	return p[:idx]
}
