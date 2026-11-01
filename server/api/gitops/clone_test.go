package gitops

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// ── 克隆目标目录预检（P-20261003-26）三态：非空 400 / 空目录放行 / 不存在放行 ──
// 400 走完整 handler 请求链断言；放行两态直接测 precheckDestDir——handler 放行态
// 会真 Start 异步任务，bogus URL 秒败后 notifyCloneDone 与 t.Cleanup(store 置 nil)
// 存在生命周期竞态（实测 panic），HTTP 层放行语义由 e2e clone-dest-precheck.spec
// 对真实实例断言，此处保持全封闭零 goroutine。

func TestCloneRepo_DestExistsRejected400(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/api/clone", CloneRepo)

	dest := t.TempDir()
	if err := os.WriteFile(filepath.Join(dest, "occupied.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/clone",
		strings.NewReader(`{"url":"/nonexistent-sc-precheck-src","dir":"`+filepath.ToSlash(dest)+`"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	// 稳定原文（前端 KNOWN_ERROR_I18N 按此匹配），且非任务启动形态（无 taskId）
	var resp struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("body not json: %v", err)
	}
	if resp.Error != errCloneDestExists.Error() {
		t.Fatalf("error = %q, want %q", resp.Error, errCloneDestExists.Error())
	}
}

func TestPrecheckDestDir_ThreeStates(t *testing.T) {
	empty := t.TempDir()
	nonEmpty := t.TempDir()
	if err := os.WriteFile(filepath.Join(nonEmpty, "occupied.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(t.TempDir(), "not-created-yet")

	if err := precheckDestDir(nonEmpty); err != errCloneDestExists {
		t.Fatalf("non-empty dir: err = %v, want %v", err, errCloneDestExists)
	}
	// git clone 语义允许克隆进空目录；目标目录不存在时由 git 创建——均放行
	if err := precheckDestDir(empty); err != nil {
		t.Fatalf("empty dir should pass, got %v", err)
	}
	if err := precheckDestDir(missing); err != nil {
		t.Fatalf("missing dir should pass, got %v", err)
	}
}

func TestPrecheckDestDir_PassThroughOnReadDirError(t *testing.T) {
	// 普通文件占位（ReadDir 报错）等不确定形态放行——预检只拦「确定非空目录」，
	// 其余交给异步任务由 git 报真实错误
	file := filepath.Join(t.TempDir(), "plain-file.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := precheckDestDir(file); err != nil {
		t.Fatalf("plain file at dest should pass through, got %v", err)
	}
}

// ── 克隆 URL 形态预检（P-20261003-70）三态：合法形态放行 / 打错形态拦截 /
// 异形但从宽放行——前端 web/src/utils/cloneUrl.test.ts 用同一张用例表，
// 改用例须两侧同步，保证双端同规则 ──
func TestPrecheckCloneURL_Forms(t *testing.T) {
	valid := []string{
		"https://github.com/user/repo.git",
		"http://gitea.lan:3000/user/repo.git",
		"git@github.com:user/repo.git",
		"ssh://git@gitlab.com:2222/user/repo.git", // 自定义端口 ssh:// 长形放行
		"file:///nonexistent-src",                 // 本地文件 URL（既有单测/e2e 夹具形态）
		"/nonexistent-sc-precheck-src",            // 本地绝对路径（既有单测夹具形态）
		`D:/workspace/repo`,                       // Windows 盘符路径
		`\\nas\share\repo`,                        // UNC 路径
		"./sibling/repo",
		"~/src/repo",
		"https://host/répo", // 非 ASCII 但非空白/全角——从宽放行（宁可漏报）
	}
	invalid := []string{
		"https//github.com/user/repo.git",      // 少冒号（提案动机形态）
		"git@github.com/user/repo.git",         // SCP 少冒号（@ 后无 :）
		"github.com/user/repo.git",             // 缺协议前缀也非本地路径形态
		"https://github.com/a b/repo.git",      // 含普通空格
		"https://github.com/a\u3000b/repo.git", // 全角空格（粘进中文空格）
		"https://github.com/a\u00a0b/repo.git", // NBSP（网页复制常见）
		"ｈｔｔｐｓ://github.com/user/repo.git",   // 全角字母
		"https://github.com/user/repo（备份）",    // 全角括号（CJK 标点）
	}
	for _, u := range valid {
		if err := precheckCloneURL(u); err != nil {
			t.Errorf("precheckCloneURL(%q) = %v, want nil", u, err)
		}
	}
	for _, u := range invalid {
		if err := precheckCloneURL(u); err != errCloneURLInvalid {
			t.Errorf("precheckCloneURL(%q) = %v, want %v", u, err, errCloneURLInvalid)
		}
	}
}

func TestCloneRepo_InvalidURLRejected400(t *testing.T) {
	// handler 级：URL 形态预检在任务启动前 400（稳定原文直出、无 taskId），
	// 与 dest-exists 同款全封闭请求链断言，零 goroutine
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/api/clone", CloneRepo)

	req := httptest.NewRequest(http.MethodPost, "/api/clone",
		strings.NewReader(`{"url":"https//github.com/user/repo.git","dir":"D:/tmp/whatever"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		Error  string `json:"error"`
		TaskID string `json:"taskId"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("body not json: %v", err)
	}
	if resp.Error != errCloneURLInvalid.Error() {
		t.Fatalf("error = %q, want %q", resp.Error, errCloneURLInvalid.Error())
	}
	if resp.TaskID != "" {
		t.Fatalf("task should not start, got taskId=%q", resp.TaskID)
	}
}
