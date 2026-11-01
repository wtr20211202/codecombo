package gitops

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	shared "codecombo/server/api/shared"
	"codecombo/server/errmarkers"
	"codecombo/server/git"
)

// P-20261005-160 门禁：git 域错误面的 code 稳定断言——marker（P-29 errmarkers
// 文本标记）与 code（P-305 结构化错误码）成对附挂后，码值或绑定 status 漂移在
// 此翻红；同时断言 message 关键字共存（前端正则过渡层的兼容契约：迁移不回退
// 文本标记）。code 字面与共享注册表一一对应，复用 files 域 respCode 手法。

// seedStaleLock 在 fixture 仓库埋一把超龄 index.lock（mtime 拨回 10 分钟前，
// 阈值 5 分钟的遗留形态；素材同 git 包 indexlock_test）
func seedStaleLock(t *testing.T, f *fixtureRepo) string {
	t.Helper()
	lockPath := filepath.Join(f.path, ".git", "index.lock")
	if err := os.WriteFile(lockPath, []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}
	stale := time.Now().Add(-10 * time.Minute)
	if err := os.Chtimes(lockPath, stale, stale); err != nil {
		t.Fatal(err)
	}
	return lockPath
}

// useDevMode 显式回到 dev 模式（默认即 true）：dev 下 error 字段暴露 err 原文
// （含稳定 marker），本文件的关键字共存断言依赖该形态；防御性设一遍防未来
// 本包其他测试改动全局态后失明
func useDevMode(t *testing.T) {
	t.Helper()
	shared.SetDevMode(true)
	t.Cleanup(func() { shared.SetDevMode(true) })
}

// TestStageFiles_IndexLockStale_ErrorCode 写命令失败携遗留锁：500 + git.index_lock_stale
// + message 关键字共存（agent 自纠闭环：按 code 调 index-lock/cleanup → 重试；
// 前端按 marker 出修复条——双轨互不替代）
func TestStageFiles_IndexLockStale_ErrorCode(t *testing.T) {
	useDevMode(t)

	f := newFixtureRepo(t)
	r := setupGitopsTest(t, f)
	r.POST("/api/projects/:id/stage", StageFiles)
	r.POST("/api/projects/:id/index-lock/cleanup", CleanIndexLock)

	// 改动已跟踪文件后埋遗留锁 → 暂存（git add 写命令）必败
	f.write("a.txt", "changed\n")
	seedStaleLock(t, f)

	w := post(r, "/api/projects/p1/stage", `{"files":["a.txt"]}`)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500, body=%s", w.Code, w.Body.String())
	}
	if got := respCode(t, w.Body.Bytes()); got != "git.index_lock_stale" {
		t.Errorf("code = %q, want git.index_lock_stale", got)
	}
	// message 关键字共存：index.lock 原文 + 稳定标记（前端 KNOWN_ERROR_I18N 识别依据）
	if !strings.Contains(w.Body.String(), "index.lock") || !strings.Contains(w.Body.String(), git.IndexLockStaleMarker) {
		t.Errorf("error text must keep lock text + marker, got %s", w.Body.String())
	}

	// 自纠闭环：一键清理成功（遗留锁形态，非 fresh 拒绝）→ 锁消失
	w = post(r, "/api/projects/p1/index-lock/cleanup", `{}`)
	if w.Code != http.StatusOK {
		t.Fatalf("cleanup status = %d, body=%s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(f.path, ".git", "index.lock")); !os.IsNotExist(err) {
		t.Fatalf("stale lock should be removed, stat err=%v", err)
	}
}

// TestCleanIndexLock_FreshLock_ErrorCode 活锁拒绝：409 + git.index_lock_fresh
// （mtime 未达阈值，删了会损坏并发中的 git 操作——agent 自纠=等待后重试清理）
func TestCleanIndexLock_FreshLock_ErrorCode(t *testing.T) {
	useDevMode(t)

	f := newFixtureRepo(t)
	r := setupGitopsTest(t, f)
	r.POST("/api/projects/:id/index-lock/cleanup", CleanIndexLock)

	// 新锁（mtime=now）：存在但未达遗留阈值
	lockPath := filepath.Join(f.path, ".git", "index.lock")
	if err := os.WriteFile(lockPath, []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}

	w := post(r, "/api/projects/p1/index-lock/cleanup", `{}`)
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409, body=%s", w.Code, w.Body.String())
	}
	if got := respCode(t, w.Body.Bytes()); got != "git.index_lock_fresh" {
		t.Errorf("code = %q, want git.index_lock_fresh", got)
	}
	if !strings.Contains(w.Body.String(), "is fresh") {
		t.Errorf("error text must keep fresh-lock wording, got %s", w.Body.String())
	}
	// 误删保护：锁仍在
	if _, err := os.Stat(lockPath); err != nil {
		t.Fatalf("fresh lock must survive: %v", err)
	}
}

// TestGitErrCode_Classification 分类器单元断言：写队列忙标记 → git.write_busy、
// 普通错误/nil → 无码（保持无 code 旧形态的增量兼容约定）
func TestGitErrCode_Classification(t *testing.T) {
	if code, ok := gitErrCode(errors.New("x: " + git.GitWriteBusyMarker + ": 30s")); !ok || code != shared.CodeGitWriteBusy {
		t.Errorf("write-busy error: code=%q ok=%v, want git.write_busy", code, ok)
	}
	// 与注册表常量同源：marker 文本改动（须两侧同步的场景）分类不静默失明
	if code, ok := gitErrCode(errors.New("boom [" + errmarkers.IndexLockStale + ": 60s old]")); !ok || code != shared.CodeGitIndexLockStale {
		t.Errorf("stale-lock error: code=%q ok=%v, want git.index_lock_stale", code, ok)
	}
	if _, ok := gitErrCode(errors.New("fatal: not a git repository")); ok {
		t.Error("plain error must not carry a code")
	}
	if _, ok := gitErrCode(nil); ok {
		t.Error("nil error must not carry a code")
	}
}

// TestCloneRepo_ErrorCodes 克隆预检两码：400 + clone.url_invalid / clone.dest_exists
// （稳定原文 publicMsg 保留——前端 KNOWN_ERROR_I18N 行内映射契约不回退）
func TestCloneRepo_ErrorCodes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/api/clone", CloneRepo)

	postClone := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/clone", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w
	}

	// URL 形态非法（裸词含空白：无 scheme/@host:/路径前缀，且空白直接命中
	// unicode.IsSpace 拒收）→ 400 + clone.url_invalid。样例注意：预检从宽
	//（CJK 表意字符不拦，宁漏报不误拦），必须用确定拒收形态，否则会真启动
	// 异步克隆任务（clone_test.go 同款生命周期约束）
	w := postClone(`{"url":"not a repo url","dir":"` + filepath.ToSlash(t.TempDir()) + `"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("url-invalid status = %d, body=%s", w.Code, w.Body.String())
	}
	if got := respCode(t, w.Body.Bytes()); got != "clone.url_invalid" {
		t.Errorf("code = %q, want clone.url_invalid", got)
	}
	if !strings.Contains(w.Body.String(), errmarkers.CloneURLInvalid) {
		t.Errorf("error text must keep stable marker, got %s", w.Body.String())
	}

	// 目标目录非空 → 400 + clone.dest_exists
	dest := t.TempDir()
	if err := os.WriteFile(filepath.Join(dest, "occupied.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	w = postClone(`{"url":"/nonexistent-sc-precheck-src","dir":"` + filepath.ToSlash(dest) + `"}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("dest-exists status = %d, body=%s", w.Code, w.Body.String())
	}
	if got := respCode(t, w.Body.Bytes()); got != "clone.dest_exists" {
		t.Errorf("code = %q, want clone.dest_exists", got)
	}
	if !strings.Contains(w.Body.String(), errmarkers.CloneDestExists) {
		t.Errorf("error text must keep stable marker, got %s", w.Body.String())
	}
}

// respCode 解出响应体的 code 字段（缺字段 = 空串，断言即翻红）；
// 与 files 域 file_errorcode_test.go 同名同形（包私有，各自持有）
func respCode(t *testing.T, body []byte) string {
	t.Helper()
	var m struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("decode body: %v (%s)", err, body)
	}
	return m.Code
}
