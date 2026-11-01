package files

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

// setupUploadTest 构造带已注册临时项目的上传测试环境（POST /file/upload 同生产路由）
func setupUploadTest(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	doc := filestore.New(t.TempDir())
	store.SetDefault(store.New(doc))
	t.Cleanup(func() { store.SetDefault(nil) })

	projPath := t.TempDir()
	if err := store.Get().Project.Create(config.ProjectConfig{
		ID:   "proj-upload",
		Name: "upload-test",
		Path: projPath,
	}); err != nil {
		t.Fatal(err)
	}
	r := gin.New()
	g := r.Group("/api/projects/:id")
	g.POST("/file/upload", UploadFiles)
	return r, projPath
}

// doUpload 按生产契约（multipart 字段名 files，dest 缺省 = 项目根）发一次单文件上传
func doUpload(t *testing.T, r *gin.Engine, name, content string) *httptest.ResponseRecorder {
	t.Helper()
	body, ctype := uploadBody(t, name, content)
	return doUploadReq(r, ctype, body, "")
}

// doUploadQuery 同 doUpload，附 query 原文（如 "?overwrite=1"，P-20261003-230 覆盖档）
func doUploadQuery(t *testing.T, r *gin.Engine, name, content, query string) *httptest.ResponseRecorder {
	t.Helper()
	body, ctype := uploadBody(t, name, content)
	return doUploadReq(r, ctype, body, query)
}

// uploadBody 预构建 multipart 请求体（返回 body 与 Content-Type）：
// 并发用例先在主 goroutine 批量构建（helper 内 t.Fatal 只允许测试 goroutine 调用）
func uploadBody(t *testing.T, name, content string) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("files", name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write([]byte(content)); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	return &buf, mw.FormDataContentType()
}

// doUploadReq goroutine 安全的最小上传：无 testing 断言、无共享可变状态
// （gin.Engine 并发 ServeHTTP 安全），失败形态经响应码/响应体回传给主 goroutine 断言
func doUploadReq(r *gin.Engine, contentType string, body *bytes.Buffer, query string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/projects/proj-upload/file/upload"+query, body)
	req.Header.Set("Content-Type", contentType)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

type uploadResp struct {
	Saved   []string            `json:"saved"`
	Skipped []map[string]string `json:"skipped"`
}

// TestUploadFiles_ConcurrentSameName_ContentIntact 并发上传同名文件（全部带
// ?overwrite=1：并发覆盖正是 rename 原子性要考验的形态；缺省档现在会跳过同名，
// 全部 skip 就测不到 rename 竞态了）：每个请求各写各的唯一 tmp 再 rename（直写
// target 时代 A/B 的写指针会在同一文件上交错），最终落盘内容必须是某一个请求的
// 完整原文而非交错半截，且目录无 .sc-tmp-* 残留。
// 注：Windows 下多个 rename 并发替换同一目标文件本身会瞬时 Access denied
// （与 WriteFile 并发保存同款竞态，提案不改 rename 语义），允许个别请求因
// rename 失败进 skipped——其 tmp 已被清理，不产生残留
func TestUploadFiles_ConcurrentSameName_ContentIntact(t *testing.T) {
	r, projPath := setupUploadTest(t)

	const writers = 16
	payloads := make([]string, writers)
	bodies := make([]*bytes.Buffer, writers)
	ctypes := make([]string, writers)
	for i := range payloads {
		payloads[i] = fmt.Sprintf("uploader-%02d:%s", i, strings.Repeat("x", 512))
		bodies[i], ctypes[i] = uploadBody(t, "same-name.txt", payloads[i])
	}

	var wg sync.WaitGroup
	resps := make([]*httptest.ResponseRecorder, writers)
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			resps[i] = doUploadReq(r, ctypes[i], bodies[i], "?overwrite=1")
		}(i)
	}
	wg.Wait()

	// 非 rename 步骤的失败一律算失败（tmp 唯一化后不应出现写 tmp 失败）
	savedCount := 0
	for i, w := range resps {
		if w.Code != http.StatusOK {
			t.Fatalf("uploader %d: status = %d, body=%s", i, w.Code, w.Body.String())
		}
		var resp uploadResp
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("uploader %d: decode response: %v", i, err)
		}
		found := false
		for _, name := range resp.Saved {
			if name == "same-name.txt" {
				found = true
			}
		}
		if found {
			savedCount++
			continue
		}
		renameFailed := false
		for _, sk := range resp.Skipped {
			if sk["name"] == "same-name.txt" && strings.Contains(sk["reason"], "rename ") {
				renameFailed = true
			}
		}
		if !renameFailed {
			t.Fatalf("uploader %d failed at unexpected step: %s", i, w.Body.String())
		}
	}
	if savedCount == 0 {
		t.Fatal("all uploads skipped, expected at least one to win the rename")
	}

	// 最终内容必须是某一个上传者的完整 payload（rename 原子，不能交错截断）
	got, err := os.ReadFile(filepath.Join(projPath, "same-name.txt"))
	if err != nil {
		t.Fatalf("read target after %d successful uploads: %v", savedCount, err)
	}
	won := false
	for _, p := range payloads {
		if string(got) == p {
			won = true
			break
		}
	}
	if !won {
		t.Fatalf("disk content (len=%d) is not any uploader's intact payload — tmp collision?", len(got))
	}

	// 每个请求只负责自己的 tmp：成功者 rename 消费、失败者 Remove 清理，
	// 全部完成后目录无 .sc-tmp-* 残留
	assertNoTmpResidue(t, projPath, "")
}

// TestUploadFiles_InterruptedSave_TargetNotPolluted 中断模拟：tmp 已写完、提交
// （rename）被中断的最坏时序下，目标不被截断/交错内容污染，失败请求自身 tmp
// 清理干净，既有「失败即跳过」的 skipped 响应形状不变；已存在的 SIGKILL 型
// 邻位 tmp 残留保持惰性、不碍后续上传完整落盘
func TestUploadFiles_InterruptedSave_TargetNotPolluted(t *testing.T) {
	r, projPath := setupUploadTest(t)

	// 预置完整旧内容 + 人为放置一枚 SIGKILL 型 tmp 残留（模拟进程在
	// 「tmp 已写完、rename 未发生」瞬间死亡留下的邻位垃圾——唯一命名下
	// 它与后续请求互不相干，这是 uniqueTmp 的前提之一）
	target := filepath.Join(projPath, "keep.txt")
	if err := os.WriteFile(target, []byte("V1-original-content"), 0644); err != nil {
		t.Fatal(err)
	}
	stale := target + ".sc-tmp-deadbeefdeadbeef"
	if err := os.WriteFile(stale, []byte("half-written truncat"), 0644); err != nil {
		t.Fatal(err)
	}

	// 让 rename 一步确定性失败：预建同名目录，os.Rename（文件 → 目录）在
	// Windows/Linux 均报错——精确覆盖「tmp 已写完、提交被中断」而不依赖
	// 平台时序。带 ?overwrite=1（缺省档会在同名防护就提前跳过，到不了
	// rename，中断时序须走显式覆盖档）
	if err := os.Mkdir(filepath.Join(projPath, "clash-dir"), 0755); err != nil {
		t.Fatal(err)
	}
	w := doUploadQuery(t, r, "clash-dir", "new payload that must never land", "?overwrite=1")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	var resp uploadResp
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(resp.Saved) != 0 {
		t.Fatalf("clash-dir unexpectedly saved: %v", resp.Saved)
	}
	if len(resp.Skipped) != 1 || resp.Skipped[0]["name"] != "clash-dir" || resp.Skipped[0]["reason"] == "" {
		t.Fatalf("skipped = %v, want exactly 1 entry for clash-dir with reason", resp.Skipped)
	}

	// 同名目录原样（未被文件替换），旧文件内容原样（未被任何半截内容污染）
	info, err := os.Stat(filepath.Join(projPath, "clash-dir"))
	if err != nil || !info.IsDir() {
		t.Fatalf("clash-dir not intact after failed upload: %v", err)
	}
	got, err := os.ReadFile(target)
	if err != nil || string(got) != "V1-original-content" {
		t.Fatalf("target polluted: %q (%v)", got, err)
	}

	// 失败请求自身的 tmp 已清理（手工残留是 SIGKILL 型产物，不在清理语义内）
	assertNoTmpResidue(t, projPath, filepath.Base(stale))

	// 残留不碍事：随后的正常上传同名文件（显式覆盖档）完整落盘，残留邻居原样惰性
	w2 := doUploadQuery(t, r, "keep.txt", "V2-complete-new-content", "?overwrite=1")
	if w2.Code != http.StatusOK {
		t.Fatalf("recovery upload status = %d, body=%s", w2.Code, w2.Body.String())
	}
	got2, err := os.ReadFile(target)
	if err != nil || string(got2) != "V2-complete-new-content" {
		t.Fatalf("target after recovery upload: %q (%v)", got2, err)
	}
	if _, err := os.Stat(stale); err != nil {
		t.Fatalf("stale tmp unexpectedly touched: %v", err)
	}
}

// TestUploadFiles_SameNameDefaultSkipped 同名默认跳过（P-20261003-230）：
// 缺省（不带 overwrite）上传命中既有目标 → saved 空、skipped 恰一条携稳定
// 原因「file already exists」（与 CreateFile/RenameFile 冲突同串的识别口径），
// 磁盘旧内容原样不动、无 tmp 残留——「改名/清理」是可行动面，静默替换不再是缺省
func TestUploadFiles_SameNameDefaultSkipped(t *testing.T) {
	r, projPath := setupUploadTest(t)

	target := filepath.Join(projPath, "keep.txt")
	if err := os.WriteFile(target, []byte("V1-original-content"), 0644); err != nil {
		t.Fatal(err)
	}

	w := doUpload(t, r, "keep.txt", "V2-must-not-land-by-default")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	var resp uploadResp
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(resp.Saved) != 0 {
		t.Fatalf("saved = %v, want empty (default must skip same name)", resp.Saved)
	}
	if len(resp.Skipped) != 1 || resp.Skipped[0]["name"] != "keep.txt" {
		t.Fatalf("skipped = %v, want exactly 1 entry for keep.txt", resp.Skipped)
	}
	if got := resp.Skipped[0]["reason"]; got != "file already exists" {
		t.Fatalf("skip reason = %q, want stable %q", got, "file already exists")
	}
	got, err := os.ReadFile(target)
	if err != nil || string(got) != "V1-original-content" {
		t.Fatalf("target content changed by default-skip upload: %q (%v)", got, err)
	}
	assertNoTmpResidue(t, projPath, "")
}

// TestUploadFiles_OverwriteReplacesAndSnapshots 显式覆盖档（?overwrite=1）：
// 命中既有目标照常替换为上传内容，且替换前旧内容留档本地历史（P-130 钩子，
// 与 WriteFile/RenameFile 同语义——「改了本地文件想更新目录副本」的误覆盖
// 后悔药）；全新文件（无既有目标）首建不留档
func TestUploadFiles_OverwriteReplacesAndSnapshots(t *testing.T) {
	r, projPath := setupUploadTest(t)

	target := filepath.Join(projPath, "keep.txt")
	if err := os.WriteFile(target, []byte("V1-original-content"), 0644); err != nil {
		t.Fatal(err)
	}

	// 全新文件首建：无旧内容可保，不产生历史版本
	w0 := doUploadQuery(t, r, "fresh.txt", "first-landing", "?overwrite=1")
	if w0.Code != http.StatusOK {
		t.Fatalf("fresh upload status = %d, body=%s", w0.Code, w0.Body.String())
	}
	if versions, err := store.Get().FileHistory.List("proj-upload", "fresh.txt"); err != nil || len(versions) != 0 {
		t.Fatalf("first landing must not snapshot: versions=%v err=%v", versions, err)
	}

	// 同名覆盖：目标替换为 V2 + 旧内容 V1 留档
	w := doUploadQuery(t, r, "keep.txt", "V2-complete-new-content", "?overwrite=1")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	var resp uploadResp
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(resp.Saved) != 1 || resp.Saved[0] != "keep.txt" {
		t.Fatalf("saved = %v, want [keep.txt]", resp.Saved)
	}
	got, err := os.ReadFile(target)
	if err != nil || string(got) != "V2-complete-new-content" {
		t.Fatalf("target after overwrite: %q (%v)", got, err)
	}
	versions, err := store.Get().FileHistory.List("proj-upload", "keep.txt")
	if err != nil || len(versions) != 1 {
		t.Fatalf("history versions = %v (err=%v), want exactly the pre-overwrite V1", versions, err)
	}
	content, err := store.Get().FileHistory.Content("proj-upload", "keep.txt", versions[0].ID)
	if err != nil || string(content) != "V1-original-content" {
		t.Fatalf("snapshot content = %q (err=%v), want V1-original-content", content, err)
	}
	assertNoTmpResidue(t, projPath, "")
}

// TestUploadFiles_SameNameDirSkippedByDefault 同名目录在缺省档按同名跳过：
// 文件落不上目录名（rename 文件→目录两平台均败），提前以稳定原因短路，
// 目录原样、无 tmp 残留
func TestUploadFiles_SameNameDirSkippedByDefault(t *testing.T) {
	r, projPath := setupUploadTest(t)

	if err := os.Mkdir(filepath.Join(projPath, "clash-dir"), 0755); err != nil {
		t.Fatal(err)
	}
	w := doUpload(t, r, "clash-dir", "payload")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	var resp uploadResp
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(resp.Saved) != 0 || len(resp.Skipped) != 1 || resp.Skipped[0]["reason"] != "file already exists" {
		t.Fatalf("saved=%v skipped=%v, want 1 skip with stable reason", resp.Saved, resp.Skipped)
	}
	info, err := os.Stat(filepath.Join(projPath, "clash-dir"))
	if err != nil || !info.IsDir() {
		t.Fatalf("clash-dir not intact after skipped upload: %v", err)
	}
	assertNoTmpResidue(t, projPath, "")
}

// assertNoTmpResidue 断言目录内除豁免名外无 .sc-tmp-* 残留
func assertNoTmpResidue(t *testing.T, dir, exempt string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	for _, e := range entries {
		if e.Name() == exempt {
			continue
		}
		if strings.Contains(e.Name(), ".sc-tmp-") {
			t.Fatalf("leftover tmp file: %s", e.Name())
		}
	}
}
