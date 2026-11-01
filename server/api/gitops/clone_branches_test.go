package gitops

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// ── 克隆前远端分支预取（P-20261003-93）──
// handler 走真实 git：本地仓库当远端（file://，零网络零凭据）。

// initBranchesRepo 建一个带两个 feature 分支的临时仓库（本地远端夹具）
func initBranchesRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		out, err := exec.Command("git", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-b", "main", dir)
	run("-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init")
	run("-C", dir, "branch", "feat/x")
	run("-C", dir, "branch", "feat/a")
	return dir
}

// localFileURL 本地目录 → file:// URL（Windows 盘符补前导 /，跨平台同 git 包测试）
func localFileURL(t *testing.T, dir string) string {
	t.Helper()
	p := filepath.ToSlash(dir)
	if p != "" && p[0] != '/' {
		p = "/" + p
	}
	u := url.URL{Scheme: "file", Path: p}
	return u.String()
}

func postCloneBranches(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/api/clone/branches", ListCloneBranches)
	req := httptest.NewRequest(http.MethodPost, "/api/clone/branches", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestListCloneBranches_LocalRemote200(t *testing.T) {
	dir := initBranchesRepo(t)
	w := postCloneBranches(t, `{"url":"`+localFileURL(t, dir)+`"}`)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		Data []string `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("body not json: %v", err)
	}
	want := []string{"feat/a", "feat/x", "main"}
	if !reflect.DeepEqual(resp.Data, want) {
		t.Fatalf("branches = %v, want %v", resp.Data, want)
	}
}

func TestListCloneBranches_BogusURL502StableMarker(t *testing.T) {
	w := postCloneBranches(t, `{"url":"`+localFileURL(t, filepath.Join(t.TempDir(), "no-such-repo"))+`"}`)

	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	// 稳定前缀 + 类别标记（不存在路径 → repository not found），detail 为 git 原文
	var resp struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("body not json: %v", err)
	}
	if !strings.HasPrefix(resp.Error, lsRemoteBranchesErrPrefix+": repository not found") {
		t.Fatalf("error = %q, want prefix %q", resp.Error, lsRemoteBranchesErrPrefix+": repository not found")
	}
}

func TestListCloneBranches_MissingURL400(t *testing.T) {
	w := postCloneBranches(t, `{}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
}

func TestClassifyLsRemoteError(t *testing.T) {
	cases := []struct {
		stderr string
		want   string
	}{
		// HTTPS 凭据失败
		{"fatal: Authentication failed for 'https://github.com/x/y.git/'", "authentication failed"},
		{"fatal: could not read Username for 'https://github.com': terminal prompts disabled", "authentication failed"},
		// SSH 权限失败
		{"git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository", "authentication failed"},
		// 网络不通
		{"fatal: unable to access 'https://x.github.com/y.git/': Could not resolve host: x.github.com", "remote unreachable"},
		{"ssh: connect to host 127.0.0.1 port 2222: Connection refused", "remote unreachable"},
		{"timed out after 10s", "remote unreachable"},
		// 仓库不存在（GitHub 对私有/不存在仓库同报此文案）
		{"ERROR: Repository not found.\nfatal: Could not read from remote repository.", "repository not found"},
		{"fatal: '/tmp/x' does not appear to be a git repository", "repository not found"},
		// 未识别：空类别（handler 落前缀+原文形态）
		{"some totally unknown git error", ""},
	}
	for _, tc := range cases {
		if got := classifyLsRemoteError(errString(tc.stderr)); got != tc.want {
			t.Errorf("classify(%q) = %q, want %q", tc.stderr, got, tc.want)
		}
	}
}

// errString 最小 error 实现（分类器只看 Error() 文本）
type errString string

func (e errString) Error() string { return string(e) }
