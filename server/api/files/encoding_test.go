package files

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/encoding/traditionalchinese"

	"codecombo/server/store"
)

// setupEncodingTest 构造带已注册临时项目 + file 读/写路由的测试环境
func setupEncodingTest(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	r := setupProjectTest(t)
	proj, err := store.Get().Project.GetByID("proj-test")
	if err != nil || proj == nil {
		t.Fatalf("proj-test missing: %v", err)
	}
	g := r.Group("/api/projects/:id")
	{
		g.GET("/file", ReadFile)
		g.GET("/file-policy", GetFilePolicy)
		g.PUT("/file-save", WriteFile)
	}
	return r, proj.Path
}

func serve(r *gin.Engine, method, target, body string) *httptest.ResponseRecorder {
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, target, nil)
	} else {
		req = httptest.NewRequest(method, target, bytes.NewBufferString(body))
	}
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// TestDecodeText_GBK 探测：GBK 中文 → 解码文本 + gbk 标签
func TestDecodeText_GBK(t *testing.T) {
	raw, err := simplifiedchinese.GB18030.NewEncoder().Bytes([]byte("# 配置说明\n端口=8080\n"))
	if err != nil {
		t.Fatal(err)
	}
	text, enc := decodeText(raw)
	if enc != EncodingGBK {
		t.Fatalf("encoding = %q, want gbk", enc)
	}
	if text != "# 配置说明\n端口=8080\n" {
		t.Fatalf("decoded text = %q", text)
	}
}

// TestDecodeText_UTF8 合法 UTF-8 永远走原样路径（GBK 探测不抢）
func TestDecodeText_UTF8(t *testing.T) {
	raw := []byte("# 中文 UTF-8 文件\n")
	text, enc := decodeText(raw)
	if enc != "" {
		t.Fatalf("encoding = %q, want empty", enc)
	}
	if text != string(raw) {
		t.Fatalf("text = %q, want unchanged", text)
	}
}

// TestDecodeText_Indeterminate 非法且非 GBK（如拉丁系单字节高位字节）→ 维持原样
func TestDecodeText_Indeterminate(t *testing.T) {
	raw := []byte("caf\xe9 latin1\n") // 0xE9 在 UTF-8 非法；GBK 语境也无法 round-trip
	_, enc := decodeText(raw)
	if enc == EncodingGBK {
		t.Fatalf("encoding = %q, want empty（不确定内容不得误标 GBK）", enc)
	}
}

// TestDecodeText_TruncatedGBK 截断的多字节尾部破坏 round-trip → 不标 GBK
// （部分预览路径维持历史行为，宁可不解码不可错解码）
func TestDecodeText_TruncatedGBK(t *testing.T) {
	full, err := simplifiedchinese.GB18030.NewEncoder().Bytes([]byte("中文内容"))
	if err != nil {
		t.Fatal(err)
	}
	_, enc := decodeText(full[:len(full)-1])
	if enc == EncodingGBK {
		t.Fatalf("encoding = %q, want empty（截断尾部不得标 GBK）", enc)
	}
}

// TestReadFile_GBKEndToEnd GBK 文件读出正确中文 + encoding 标签
func TestReadFile_GBKEndToEnd(t *testing.T) {
	r, projPath := setupEncodingTest(t)
	raw, err := simplifiedchinese.GB18030.NewEncoder().Bytes([]byte("中文内容第一行\n"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(projPath, "gbk.txt"), raw, 0644); err != nil {
		t.Fatal(err)
	}

	w := serve(r, http.MethodGet, "/api/projects/proj-test/file?path=gbk.txt", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		Data     string `json:"data"`
		Encoding string `json:"encoding"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Encoding != EncodingGBK {
		t.Fatalf("encoding = %q, want gbk", resp.Encoding)
	}
	if resp.Data != "中文内容第一行\n" {
		t.Fatalf("data = %q, want decoded chinese", resp.Data)
	}
}

// TestReadFile_UTF8NoEncodingField UTF-8 文件响应不带 encoding（兼容旧前端）
func TestReadFile_UTF8NoEncodingField(t *testing.T) {
	r, projPath := setupEncodingTest(t)
	if err := os.WriteFile(filepath.Join(projPath, "u8.txt"), []byte("hello 世界\n"), 0644); err != nil {
		t.Fatal(err)
	}
	w := serve(r, http.MethodGet, "/api/projects/proj-test/file?path=u8.txt", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if bytes.Contains(w.Body.Bytes(), []byte(`"encoding"`)) {
		t.Fatalf("utf8 response must not carry encoding field: %s", w.Body.String())
	}
}

// TestWriteFile_GBKRoundTrip 带编码标签保存 → 磁盘字节为原编码（非 UTF-8）
func TestWriteFile_GBKRoundTrip(t *testing.T) {
	r, projPath := setupEncodingTest(t)
	gbkBytes, err := simplifiedchinese.GB18030.NewEncoder().Bytes([]byte("中文内容第二行\n"))
	if err != nil {
		t.Fatal(err)
	}
	// 先放一份 GBK 原始文件，模拟「GBK 文件在编辑器里修改保存」
	if err := os.WriteFile(filepath.Join(projPath, "keep.txt"), gbkBytes, 0644); err != nil {
		t.Fatal(err)
	}

	w := serve(r, http.MethodPut, "/api/projects/proj-test/file-save",
		`{"path":"keep.txt","content":"中文内容已修改\n","encoding":"gbk"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	onDisk, err := os.ReadFile(filepath.Join(projPath, "keep.txt"))
	if err != nil {
		t.Fatal(err)
	}
	want, err := simplifiedchinese.GB18030.NewEncoder().Bytes([]byte("中文内容已修改\n"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(onDisk, want) {
		t.Fatalf("disk bytes = %x, want GBK %x", onDisk, want)
	}
	if bytes.Equal(onDisk, []byte("中文内容已修改\n")) {
		t.Fatal("disk bytes must NOT be utf-8 when encoding=gbk")
	}

	// 回读：探测解码正确
	w = serve(r, http.MethodGet, "/api/projects/proj-test/file?path=keep.txt", "")
	var resp struct {
		Data     string `json:"data"`
		Encoding string `json:"encoding"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Data != "中文内容已修改\n" || resp.Encoding != EncodingGBK {
		t.Fatalf("round-trip read = %q / %q", resp.Data, resp.Encoding)
	}
}

// TestWriteFile_UnknownEncodingFallsBackUTF8 未知编码值向后兼容按 UTF-8 写
func TestWriteFile_UnknownEncodingFallsBackUTF8(t *testing.T) {
	r, projPath := setupEncodingTest(t)
	w := serve(r, http.MethodPut, "/api/projects/proj-test/file-save",
		`{"path":"x.txt","content":"中文\n","encoding":"unknown-enc"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	onDisk, err := os.ReadFile(filepath.Join(projPath, "x.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(onDisk) != "中文\n" {
		t.Fatalf("disk = %q, want utf-8 passthrough", onDisk)
	}
}

// utf16Bytes 编码为带 BOM 的 UTF-16 字节（测试辅助，独立于被测 encodeUTF16）
func utf16Bytes(t *testing.T, s string, little bool) []byte {
	t.Helper()
	runes := []rune(s)
	out := make([]byte, 2+len(runes)*2)
	if little {
		out[0], out[1] = 0xFF, 0xFE
	} else {
		out[0], out[1] = 0xFE, 0xFF
	}
	for i, r := range runes {
		if little {
			out[2+2*i], out[3+2*i] = byte(r), byte(r>>8)
		} else {
			out[2+2*i], out[3+2*i] = byte(r>>8), byte(r)
		}
	}
	return out
}

// TestDecodeText_UTF16 BOM 声明式识别大小端 UTF-16
func TestDecodeText_UTF16(t *testing.T) {
	for _, tc := range []struct {
		name  string
		raw   []byte
		label string
	}{
		{"le", utf16Bytes(t, "中文 UTF-16 内容\n", true), EncodingUTF16LE},
		{"be", utf16Bytes(t, "中文 UTF-16 内容\n", false), EncodingUTF16BE},
	} {
		text, enc := decodeText(tc.raw)
		if enc != tc.label {
			t.Fatalf("%s: encoding = %q, want %q", tc.name, enc, tc.label)
		}
		if text != "中文 UTF-16 内容\n" {
			t.Fatalf("%s: text = %q", tc.name, text)
		}
	}
}

// TestDecodeText_UTF16NotForOddOrSurrogates 截断/未配对代理项不误标 UTF-16
func TestDecodeText_UTF16NotForOddOrSurrogates(t *testing.T) {
	raw := utf16Bytes(t, "中文内容", true)
	if _, enc := decodeText(raw[:len(raw)-1]); enc == EncodingUTF16LE {
		t.Fatalf("odd-length body must not be labeled utf16le")
	}
	// 孤立低代理项 DC 00 + 孤立高代理项 D8 00：解码出 U+FFFD 无法 round-trip
	bad := append([]byte{0xFF, 0xFE, 0x00, 0xDC}, 0x00, 0xD8)
	if _, enc := decodeText(bad); enc == EncodingUTF16LE {
		t.Fatalf("unpaired surrogates must not round-trip to utf16le")
	}
}

// TestDecodeText_OtherCJK Big5 正确识别；与 GB18030 重叠的样本按优先级
// 标 gbk（探测固有局限），但走公开 API 回编必须逐字节还原——保存字节安全
// 是比标签正确更硬的保证
func TestDecodeText_OtherCJK(t *testing.T) {
	big5 := traditionalchinese.Big5
	// 实证挑选：无法被更高优先级的 GB18030 round-trip 吞掉的 Big5 文本
	raw, err := big5.NewEncoder().Bytes([]byte("許功蓋測試"))
	if err != nil {
		t.Fatal(err)
	}
	text, label := decodeText(raw)
	if label != EncodingBig5 || text != "許功蓋測試" {
		t.Fatalf("big5 sample: %q / %q, want big5 decode", text, label)
	}

	// 与 GB18030 重叠的 Big5 文本（「繁體中文測試」）会被标 gbk，但按返回
	// 标签回编必须还原原始字节（用户保存不损毁原文件）
	ambiguous, err := big5.NewEncoder().Bytes([]byte("繁體中文測試"))
	if err != nil {
		t.Fatal(err)
	}
	text, label = decodeText(ambiguous)
	back, err := encodeText(text, label)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(back, ambiguous) {
		t.Fatalf("ambiguous sample not byte-safe: label=%q round-trip broken", label)
	}
}

// TestReadFile_UTF16EndToEnd UTF-16 文件不被判 binary 且读出正确中文
func TestReadFile_UTF16EndToEnd(t *testing.T) {
	r, projPath := setupEncodingTest(t)
	if err := os.WriteFile(filepath.Join(projPath, "w16.ini"),
		utf16Bytes(t, "[配置]\n端口=8080\n", true), 0644); err != nil {
		t.Fatal(err)
	}

	// 策略端点：UTF-16 含 NUL 字节，不得判 binary
	w := serve(r, http.MethodGet, "/api/projects/proj-test/file-policy?path=w16.ini", "")
	if w.Code != http.StatusOK {
		t.Fatalf("policy status = %d, body=%s", w.Code, w.Body.String())
	}
	if bytes.Contains(w.Body.Bytes(), []byte(`"binary"`)) {
		t.Fatalf("utf16 text must not be classified binary: %s", w.Body.String())
	}

	// 读取端点：解码正确 + 带 utf16le 标签
	w = serve(r, http.MethodGet, "/api/projects/proj-test/file?path=w16.ini", "")
	if w.Code != http.StatusOK {
		t.Fatalf("read status = %d, body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		Data     string `json:"data"`
		Encoding string `json:"encoding"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Encoding != EncodingUTF16LE {
		t.Fatalf("encoding = %q, want utf16le", resp.Encoding)
	}
	if resp.Data != "[配置]\n端口=8080\n" {
		t.Fatalf("data = %q", resp.Data)
	}
}

// TestWriteFile_UTF16RoundTrip 带 utf16 标签保存 → 磁盘为带 BOM 的原端序字节
func TestWriteFile_UTF16RoundTrip(t *testing.T) {
	r, projPath := setupEncodingTest(t)
	w := serve(r, http.MethodPut, "/api/projects/proj-test/file-save",
		`{"path":"be.txt","content":"中文 BE\n","encoding":"utf16be"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	onDisk, err := os.ReadFile(filepath.Join(projPath, "be.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if want := utf16Bytes(t, "中文 BE\n", false); !bytes.Equal(onDisk, want) {
		t.Fatalf("disk = %x, want utf16be %x", onDisk, want)
	}
}
