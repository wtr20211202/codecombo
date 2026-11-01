package remote

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/ssh"
)

// ============== 本地-远端 Git 对照端点单测（P-20261004-34） ==============
//
// 远端侧经进程内 fake exec SSH 服务端（密码认证 + session 通道 exec 请求，
// 记录收到的命令串并回放罐装三合一输出）覆盖完整链路：命令模板构造/引号
// 包裹、三节解析、降级归因、behind 推算、路径记忆回填。本地侧用真实临时
// git 仓库（本包既有测试同款依赖 git CLI）。主机凭据用明文口令（无 enc:
// 前缀经 DecryptIfNeeded 原样通过，importexport 测试同款）。

// fakeExecSSHServer 进程内 SSH 服务端：密码认证，session 通道接受 exec 请求，
// 命令处理回调产出 stdout 与退出码（记录全部命令供断言）
type fakeExecSSHServer struct {
	t   *testing.T
	ln  net.Listener
	cfg *ssh.ServerConfig

	mu      sync.Mutex
	cmds    []string
	handler func(cmd string) (stdout string, exit int)
}

func newFakeExecSSHServer(t *testing.T, password string, handler func(cmd string) (string, int)) *fakeExecSSHServer {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate host key: %v", err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatalf("signer: %v", err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	s := &fakeExecSSHServer{t: t, ln: ln, handler: handler}
	s.cfg = &ssh.ServerConfig{
		PasswordCallback: func(conn ssh.ConnMetadata, pass []byte) (*ssh.Permissions, error) {
			if string(pass) == password {
				return &ssh.Permissions{}, nil
			}
			return nil, fmt.Errorf("auth rejected")
		},
	}
	s.cfg.AddHostKey(signer)
	go s.serve()
	t.Cleanup(func() { _ = ln.Close() })
	return s
}

func (s *fakeExecSSHServer) port() int { return s.ln.Addr().(*net.TCPAddr).Port }

// commands 迄今收到的全部命令串（快照）
func (s *fakeExecSSHServer) commands() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.cmds...)
}

func (s *fakeExecSSHServer) serve() {
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			return
		}
		sconn, chans, reqs, err := ssh.NewServerConn(conn, s.cfg)
		if err != nil {
			_ = conn.Close()
			continue
		}
		go s.handleConn(sconn, chans, reqs)
	}
}

func (s *fakeExecSSHServer) handleConn(sconn *ssh.ServerConn, chans <-chan ssh.NewChannel, reqs <-chan *ssh.Request) {
	defer sconn.Close()
	go ssh.DiscardRequests(reqs)
	for ch := range chans {
		if ch.ChannelType() != "session" {
			_ = ch.Reject(ssh.UnknownChannelType, "unsupported")
			continue
		}
		channel, requests, err := ch.Accept()
		if err != nil {
			continue
		}
		go s.handleSession(channel, requests)
	}
}

// handleSession 处理单个 exec 会话：解出命令串 → 回调产出 → 写 stdout →
// 回 exit-status → 半关（客户端扫描器读到 EOF 收尾）
func (s *fakeExecSSHServer) handleSession(channel ssh.Channel, requests <-chan *ssh.Request) {
	defer channel.Close()
	for req := range requests {
		if req.Type != "exec" {
			_ = req.Reply(false, nil)
			continue
		}
		// x/crypto 已剥去请求名与 want_reply：req.Payload 即
		// uint32 命令长度 + 命令字节（RFC 4254 §6.5 的末段）
		if len(req.Payload) < 4 {
			_ = req.Reply(false, nil)
			continue
		}
		cmdLen := binary.BigEndian.Uint32(req.Payload[0:4])
		if int(4+cmdLen) > len(req.Payload) {
			_ = req.Reply(false, nil)
			continue
		}
		cmd := string(req.Payload[4 : 4+cmdLen])
		s.mu.Lock()
		s.cmds = append(s.cmds, cmd)
		handler := s.handler
		s.mu.Unlock()
		_ = req.Reply(true, nil)

		stdout, exit := handler(cmd)
		_, _ = channel.Write([]byte(stdout))
		status := make([]byte, 4)
		binary.BigEndian.PutUint32(status, uint32(exit))
		_, _ = channel.SendRequest("exit-status", false, status)
		_ = channel.CloseWrite()
		return
	}
}

// ============== 测试装配 ==============

func setupCompareEnv(t *testing.T) {
	t.Helper()
	store.SetDefault(store.New(filestore.New(t.TempDir())))
	t.Cleanup(func() { store.SetDefault(nil) })
	gin.SetMode(gin.TestMode)
}

func createCompareHost(t *testing.T, port int) string {
	t.Helper()
	rh, err := store.Get().RemoteHost.Create(config.RemoteHost{
		Name: "cmp-host", Host: "127.0.0.1", Port: port, User: "e2e",
		AuthType: config.AuthTypePassword, Password: "tpass",
	})
	if err != nil {
		t.Fatalf("create remote host: %v", err)
	}
	return rh.ID
}

func createCompareProject(t *testing.T, dir string) string {
	t.Helper()
	p := config.ProjectConfig{ID: "cmp-proj", Name: "cmp-proj", Path: dir}
	if err := store.Get().Project.Create(p); err != nil {
		t.Fatalf("create project: %v", err)
	}
	return p.ID
}

func doGetCompare(t *testing.T, hostID, query string) (*httptest.ResponseRecorder, gitCompareResp) {
	t.Helper()
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodGet, "/git-compare?"+query, nil)
	c.Params = gin.Params{{Key: "id", Value: hostID}}
	GitCompareRemoteHost(c)
	// 本包 GET 惯例 = {"data": ...} 包装
	var wrapped struct {
		Data gitCompareResp `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &wrapped); err != nil {
		t.Fatalf("decode response: %v\nbody: %s", err, w.Body.String())
	}
	return w, wrapped.Data
}

func doPutComparePath(t *testing.T, hostID, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodPut, "/git-compare-path", io.NopCloser(strings.NewReader(body)))
	c.Request.Header.Set("Content-Type", "application/json")
	c.Params = gin.Params{{Key: "id", Value: hostID}}
	SaveGitComparePath(c)
	return w
}

func initLocalRepo(t *testing.T) (dir, head string) {
	t.Helper()
	dir = t.TempDir()
	run := func(args ...string) string {
		gitArgs := append([]string{
			"-c", "user.name=e2e", "-c", "user.email=e2e@test.local"}, args...)
		cmd := exec.Command("git", gitArgs...)
		cmd.Dir = dir // 显式锚定临时仓库（缺省 cwd 是测试进程目录）
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("git %v: %v: %s", args, err, err.(*exec.ExitError).Stderr)
		}
		return strings.TrimSpace(string(out))
	}
	run("init")
	// autocrlf 关闭：提交内容字节稳定，跨平台行为一致
	run("config", "core.autocrlf", "false")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("v1\n"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	run("add", ".")
	run("commit", "-m", "base")
	run("commit", "--allow-empty", "-m", "second")
	head = run("rev-parse", "HEAD")
	return dir, head
}

// cannedProbe 组装三合一罐装输出（fake 远端回放体）
func cannedProbe(head, branch string, dirty int) string {
	return fmt.Sprintf("%s\n%s\n%s\n%s\n%s\n%d\n",
		gitCmpMarkerHead, head, gitCmpMarkerBranch, branch, gitCmpMarkerDirty, dirty)
}

// ============== 用例 ==============

// TestGitCompare_FullChainAndBehind 完整链路：真实本地仓库 + fake 远端——
// 两侧 HEAD/分支/脏计数并排、命令模板进命令串（路径引号包裹）、behind 提示
// （远端 HEAD=本地 HEAD~1 → remoteBehind 1）
func TestGitCompare_FullChainAndBehind(t *testing.T) {
	setupCompareEnv(t)
	dir, head := initLocalRepo(t)
	parent := gitHeadAt(t, dir, "HEAD~1")

	var gotCmd string
	srv := newFakeExecSSHServer(t, "tpass", func(cmd string) (string, int) {
		gotCmd = cmd
		return cannedProbe(parent, "main", 3), 0
	})
	hostID := createCompareHost(t, srv.port())
	projID := createCompareProject(t, dir)

	w, resp := doGetCompare(t, hostID, "projectId="+projID+"&remotePath=/srv/app")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", w.Code, w.Body.String())
	}

	// 命令模板断言：三段探针 + 路径原样内联（无特殊字符时 shellQuote 直通；
	// 特殊字符路径的引号包裹由 TestBuildRemoteGitProbeCmd_Quoting 覆盖）
	if !strings.Contains(gotCmd, "rev-parse HEAD") ||
		!strings.Contains(gotCmd, "branch --show-current") ||
		!strings.Contains(gotCmd, "status --porcelain") {
		t.Fatalf("probe template missing sections: %q", gotCmd)
	}
	if !strings.Contains(gotCmd, "git -C /srv/app rev-parse HEAD") {
		t.Fatalf("remote path not inlined in command: %q", gotCmd)
	}

	// 本地侧：真实仓库 HEAD/分支/脏计数
	if !resp.Local.Available || resp.Local.Head != head {
		t.Fatalf("local side: %+v want head=%s", resp.Local, head)
	}
	if resp.Local.DirtyCount != 0 {
		t.Fatalf("local dirty = %d, want 0", resp.Local.DirtyCount)
	}
	// 远端侧：罐装输出解析
	if !resp.Remote.Available || resp.Remote.Head != parent ||
		resp.Remote.Branch != "main" || resp.Remote.DirtyCount != 3 {
		t.Fatalf("remote side: %+v", resp.Remote)
	}
	// behind：远端 HEAD 是本地 HEAD~1 → 远端落后本地 1
	if resp.Behind == nil || resp.Behind.Relation != "remoteBehind" || resp.Behind.RemoteBehindCount != 1 {
		t.Fatalf("behind: %+v want remoteBehind 1", resp.Behind)
	}
	if resp.PathRemembered {
		t.Fatalf("explicit remotePath must not be flagged as remembered")
	}
	if len(srv.commands()) != 1 {
		t.Fatalf("expected exactly one SSH round-trip, got %d commands", len(srv.commands()))
	}
}

// TestGitCompare_RememberedPathLifecycle 显式路径对照后经 PUT 记忆，下次对照
// 缺省远端路径回填记忆（PathRemembered=true）；空路径 PUT = 清记忆
func TestGitCompare_RememberedPathLifecycle(t *testing.T) {
	setupCompareEnv(t)
	dir, head := initLocalRepo(t)

	srv := newFakeExecSSHServer(t, "tpass", func(string) (string, int) {
		return cannedProbe(head, "main", 0), 0
	})
	hostID := createCompareHost(t, srv.port())
	projID := createCompareProject(t, dir)

	// 1) 无记忆且缺省路径 → 400 稳定拒绝
	w, _ := doGetCompare(t, hostID, "projectId="+projID)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("no-path no-memory: status = %d, want 400", w.Code)
	}

	// 2) PUT 记忆路径
	if wr := doPutComparePath(t, hostID, `{"projectId":"`+projID+`","remotePath":"/srv/app"}`); wr.Code != http.StatusOK {
		t.Fatalf("PUT path: status = %d, body=%s", wr.Code, wr.Body.String())
	}

	// 3) 缺省远端路径再对照 → 记忆回填
	_, resp := doGetCompare(t, hostID, "projectId="+projID)
	if resp.RemotePath != "/srv/app" || !resp.PathRemembered {
		t.Fatalf("remembered path: path=%q remembered=%v", resp.RemotePath, resp.PathRemembered)
	}
	if !resp.Remote.Available || resp.Remote.Head != head {
		t.Fatalf("remote side after memory: %+v", resp.Remote)
	}
	// 同 HEAD → same
	if resp.Behind == nil || resp.Behind.Relation != "same" {
		t.Fatalf("behind: %+v want same", resp.Behind)
	}

	// 4) 空路径 PUT = 清记忆，再对照回到 400
	if wr := doPutComparePath(t, hostID, `{"projectId":"`+projID+`","remotePath":""}`); wr.Code != http.StatusOK {
		t.Fatalf("PUT clear: status = %d", wr.Code)
	}
	w, _ = doGetCompare(t, hostID, "projectId="+projID)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("after clear: status = %d, want 400", w.Code)
	}
}

// TestGitCompare_NonGitRemoteDegrade 远端非 git 目录优雅降级：
// rev-parse 错误原文 → notGitRepo 归因，对照仍 200 且本地侧照常返回
func TestGitCompare_NonGitRemoteDegrade(t *testing.T) {
	setupCompareEnv(t)
	dir, _ := initLocalRepo(t)

	srv := newFakeExecSSHServer(t, "tpass", func(string) (string, int) {
		return fmt.Sprintf("%s\nfatal: not a git repository (or any of the parent directories): .git\n%s\n%s\n0\n",
			gitCmpMarkerHead, gitCmpMarkerBranch, gitCmpMarkerDirty), 0
	})
	hostID := createCompareHost(t, srv.port())
	projID := createCompareProject(t, dir)

	_, resp := doGetCompare(t, hostID, "projectId="+projID+"&remotePath=/srv/app")
	if resp.Remote.Available {
		t.Fatalf("remote must degrade for non-git dir: %+v", resp.Remote)
	}
	if resp.Remote.UnavailableReason != "notGitRepo" {
		t.Fatalf("reason = %q, want notGitRepo", resp.Remote.UnavailableReason)
	}
	if !resp.Local.Available || resp.Local.Head == "" {
		t.Fatalf("local side must stay available: %+v", resp.Local)
	}
	if resp.Behind != nil {
		t.Fatalf("behind must be absent when remote head unknown: %+v", resp.Behind)
	}
}

// TestGitCompare_UnreachableHost 主机拨号失败 → unreachable 降级（200 结构化返回）
func TestGitCompare_UnreachableHost(t *testing.T) {
	setupCompareEnv(t)
	dir, _ := initLocalRepo(t)
	hostID := createCompareHost(t, 1) // 端口 1 无人监听
	projID := createCompareProject(t, dir)

	_, resp := doGetCompare(t, hostID, "projectId="+projID+"&remotePath=/srv/app")
	if resp.Remote.Available || resp.Remote.UnavailableReason != "unreachable" {
		t.Fatalf("remote: %+v want unreachable", resp.Remote)
	}
	if !resp.Local.Available {
		t.Fatalf("local side must stay available: %+v", resp.Local)
	}
}

// TestGitCompare_UnknownAncestry 远端 HEAD 本地不可见（未 fetch 的远端提交）
// → behind 诚实 unknown 不猜
func TestGitCompare_UnknownAncestry(t *testing.T) {
	setupCompareEnv(t)
	dir, _ := initLocalRepo(t)

	phantom := strings.Repeat("ab", 20) // 40 位合法形态、本地不存在的对象
	srv := newFakeExecSSHServer(t, "tpass", func(string) (string, int) {
		return cannedProbe(phantom, "main", 0), 0
	})
	hostID := createCompareHost(t, srv.port())
	projID := createCompareProject(t, dir)

	_, resp := doGetCompare(t, hostID, "projectId="+projID+"&remotePath=/srv/app")
	if resp.Behind == nil || resp.Behind.Relation != "unknown" {
		t.Fatalf("behind: %+v want unknown", resp.Behind)
	}
}

// TestGitCompare_PathValidation 路径校验黑名单：控制字符 / 超长 / 标记前缀拒绝
func TestGitCompare_PathValidation(t *testing.T) {
	cases := []struct {
		name string
		path string
	}{
		{"empty", "  "},
		{"newline injection", "/srv/a\nb"},
		{"marker prefix", "/srv/@@SC-GITCMP-HEAD@@"},
		{"too long", "/" + strings.Repeat("a", 1100)},
	}
	for _, tc := range cases {
		if got := gitComparePathError(tc.path); got == "" {
			t.Fatalf("%s: expected rejection for %q", tc.name, tc.path)
		}
	}
	if got := gitComparePathError("/srv/app v2 (测试)"); got != "" {
		t.Fatalf("normal path with spaces/CJK rejected: %v", got)
	}
}

// TestGitCompare_ProjectNotFound 项目不存在 → 404
func TestGitCompare_ProjectNotFound(t *testing.T) {
	setupCompareEnv(t)
	srv := newFakeExecSSHServer(t, "tpass", func(string) (string, int) { return "", 0 })
	hostID := createCompareHost(t, srv.port())
	w, _ := doGetCompare(t, hostID, "projectId=nope&remotePath=/srv/app")
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}

// TestParseRemoteGitProbe 解析器表驱动：真实 git 输出形态与降级形态
func TestParseRemoteGitProbe(t *testing.T) {
	head40 := strings.Repeat("1234abcd", 5)
	t.Run("三节齐全", func(t *testing.T) {
		out := fmt.Sprintf("%s\n%s\n%s\nfeature/x\n%s\n      12\n",
			gitCmpMarkerHead, head40, gitCmpMarkerBranch, gitCmpMarkerDirty)
		head, branch, headErr, dirty := parseRemoteGitProbe(out)
		if head != head40 || branch != "feature/x" || headErr != "" || dirty != 12 {
			t.Fatalf("got head=%q branch=%q err=%q dirty=%d", head, branch, headErr, dirty)
		}
	})
	t.Run("detachedHead空分支", func(t *testing.T) {
		out := fmt.Sprintf("%s\n%s\n%s\n\n%s\n0\n",
			gitCmpMarkerHead, head40, gitCmpMarkerBranch, gitCmpMarkerDirty)
		head, branch, _, dirty := parseRemoteGitProbe(out)
		if head != head40 || branch != "" || dirty != 0 {
			t.Fatalf("got head=%q branch=%q dirty=%d", head, branch, dirty)
		}
	})
	t.Run("空输出全零值", func(t *testing.T) {
		head, branch, headErr, dirty := parseRemoteGitProbe("")
		if head != "" || branch != "" || headErr != "" || dirty != 0 {
			t.Fatalf("expected all zero, got %q %q %q %d", head, branch, headErr, dirty)
		}
	})
}

// TestBuildRemoteGitProbeCmd_Quoting 特殊字符路径的引号包裹：单引号成对转义、
// 空格/$/反引号原样进引号内；模板本体固定三段
func TestBuildRemoteGitProbeCmd_Quoting(t *testing.T) {
	cmd := buildRemoteGitProbeCmd(`/srv/my app'$x`)
	// 单引号内的单引号转义为 '"'"'（shellQuote 惯例），其余字符原样
	if !strings.Contains(cmd, `git -C '/srv/my app'"'"'$x' rev-parse HEAD`) {
		t.Fatalf("quoting wrong: %q", cmd)
	}
	for _, want := range []string{"rev-parse HEAD", "branch --show-current", "status --porcelain"} {
		if !strings.Contains(cmd, want) {
			t.Fatalf("template missing %q: %q", want, cmd)
		}
	}
}

func gitHeadAt(t *testing.T, dir, ref string) string {
	t.Helper()
	out, err := exec.Command("git", "-C", dir, "rev-parse", ref).Output()
	if err != nil {
		t.Fatalf("git rev-parse %s: %v", ref, err)
	}
	return strings.TrimSpace(string(out))
}
