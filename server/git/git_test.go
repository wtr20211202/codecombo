package git

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"codecombo/server/git/auth"
	"codecombo/server/model"
	"codecombo/server/store"
)

// resetInjections 测试结束后清理全局注入，避免污染其他测试
func resetInjections() {
	broadcastFn = nil
	pathResolverFn = nil
}

// TestLogGitCmd_SuccessNoBroadcast 验证成功时不触发广播
func TestLogGitCmd_SuccessNoBroadcast(t *testing.T) {
	t.Cleanup(resetInjections)
	called := false
	broadcastFn = func(projectID string, msg model.WSMessage) { called = true }
	pathResolverFn = func(workDir string) string { return "proj-1" }

	logGitCmd([]string{"status"}, "/repo", time.Millisecond, nil, "", "On branch main")

	if called {
		t.Fatal("success path should not broadcast")
	}
}

// TestLogGitCmd_FailureBroadcasts 验证失败时广播字段完整
func TestLogGitCmd_FailureBroadcasts(t *testing.T) {
	t.Cleanup(resetInjections)
	var got model.WSMessage
	var gotProjectID string
	broadcastFn = func(projectID string, msg model.WSMessage) {
		gotProjectID = projectID
		got = msg
	}
	pathResolverFn = func(workDir string) string { return "proj-1" }

	logGitCmd([]string{"push", "origin"}, "/repo", time.Millisecond,
		errors.New("exit status 1"), "fatal: no upstream", "")

	if gotProjectID != "proj-1" {
		t.Fatalf("projectID = %q, want proj-1", gotProjectID)
	}
	if got.Type != "git.command" {
		t.Fatalf("Type = %q, want git.command", got.Type)
	}
	log, ok := got.Data.(model.CommandLog)
	if !ok {
		t.Fatalf("Data type = %T, want model.CommandLog", got.Data)
	}
	if log.Command != "git" {
		t.Errorf("Command = %q, want git", log.Command)
	}
	if log.Args != "push origin" {
		t.Errorf("Args = %q, want 'push origin'", log.Args)
	}
	if log.Error != "fatal: no upstream" {
		t.Errorf("Error = %q, want 'fatal: no upstream'", log.Error)
	}
	if log.Output != "" {
		t.Errorf("Output = %q, want empty", log.Output)
	}
	if log.WorkDir != "/repo" {
		t.Errorf("WorkDir = %q, want /repo", log.WorkDir)
	}
	if log.Timestamp == "" {
		t.Error("Timestamp should not be empty")
	}
	if _, err := time.Parse(time.RFC3339, log.Timestamp); err != nil {
		t.Errorf("Timestamp not RFC3339: %v", err)
	}
}

// TestLogGitCmd_PathResolverMissNoBroadcast 验证反查不到项目时不广播
func TestLogGitCmd_PathResolverMissNoBroadcast(t *testing.T) {
	t.Cleanup(resetInjections)
	called := false
	broadcastFn = func(projectID string, msg model.WSMessage) { called = true }
	pathResolverFn = func(workDir string) string { return "" }

	logGitCmd([]string{"fetch"}, "/unknown", time.Millisecond,
		errors.New("exit status 1"), "err", "")

	if called {
		t.Fatal("should not broadcast when projectID not resolved")
	}
}

// TestLogGitCmd_NoInjectionNoPanic 验证未注入时不 panic
func TestLogGitCmd_NoInjectionNoPanic(t *testing.T) {
	t.Cleanup(resetInjections)
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("panicked: %v", r)
		}
	}()
	logGitCmd([]string{"status"}, "/repo", time.Millisecond,
		errors.New("exit status 1"), "err", "")
}

// resetAuthResolvers 测试结束后清理全局 resolver，避免污染其他测试
func resetAuthResolvers() {
	globalHTTPSResolver = nil
	globalSSHResolver = nil
}

// stubSSHResolver 测试用 SSHResolver，可控制返回的 injection
type stubSSHResolver struct {
	inj *auth.SSHInjection
	err error
}

func (s *stubSSHResolver) ResolveForSSH(ctx context.Context, host, repoPath string) (*auth.SSHInjection, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.inj, nil
}

// TestBuildAuthEnvForHTTPS 验证 HTTPS URL 时 env 包含 GIT_CONFIG_GLOBAL
// helper config 文件由 auth.GetCachedHelperConfig 进程级单例提供
func TestBuildAuthEnvForHTTPS(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	t.Cleanup(resetAuthResolvers)
	auth.ResetHelperConfigCacheForTest()

	env, cleanup, err := buildAuthEnv("https://github.com/owner/repo.git", "")
	if err != nil {
		t.Fatalf("buildAuthEnv: %v", err)
	}
	defer cleanup()

	found := false
	for _, e := range env {
		if strings.HasPrefix(e, "GIT_CONFIG_GLOBAL=") {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("GIT_CONFIG_GLOBAL not in env: %v", env)
	}
}

// TestBuildAuthEnvForSSHWithoutKey 验证 SSH URL 但 resolver 返回空 injection 时不注入 GIT_SSH_COMMAND
// 模拟 KeyPathSSHResolver 在 host 无对应 SSH key 时的行为（返回空 injection）
func TestBuildAuthEnvForSSHWithoutKey(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	t.Cleanup(resetAuthResolvers)
	// 注入 stub resolver，返回空 injection（模拟无 key 场景）
	SetAuthResolvers(nil, &stubSSHResolver{inj: &auth.SSHInjection{}})

	env, cleanup, err := buildAuthEnv("git@github.com:owner/repo.git", "")
	if err != nil {
		t.Fatalf("buildAuthEnv: %v", err)
	}
	defer cleanup()

	for _, e := range env {
		if strings.HasPrefix(e, "GIT_SSH_COMMAND=") {
			t.Errorf("GIT_SSH_COMMAND should not be set when resolver returns empty injection: %v", env)
		}
	}
}

// TestBuildAuthEnvForSSHWithKey 验证 SSH URL 且 resolver 返回 GIT_SSH_COMMAND 时 env 正确包含
func TestBuildAuthEnvForSSHWithKey(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	t.Cleanup(resetAuthResolvers)
	SetAuthResolvers(nil, &stubSSHResolver{
		inj: &auth.SSHInjection{
			Env: []string{"GIT_SSH_COMMAND=ssh -i /tmp/key"},
		},
	})

	env, cleanup, err := buildAuthEnv("git@github.com:owner/repo.git", "")
	if err != nil {
		t.Fatalf("buildAuthEnv: %v", err)
	}
	defer cleanup()

	found := false
	for _, e := range env {
		if strings.HasPrefix(e, "GIT_SSH_COMMAND=") {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("GIT_SSH_COMMAND not in env: %v", env)
	}
}

// TestBuildAuthEnvAlwaysSetsTerminalPromptAndDataDir 验证基础 env 必含 GIT_TERMINAL_PROMPT=0 和 SC_DATA_DIR
// 不论 URL 协议为何，git 子进程都必须禁止 TTY 交互式 prompt 和能定位 simple-coding 数据目录
func TestBuildAuthEnvAlwaysSetsTerminalPromptAndDataDir(t *testing.T) {
	t.Setenv("CC_DATA_DIR", t.TempDir())
	t.Cleanup(resetAuthResolvers)

	env, _, _ := buildAuthEnv("https://x.com/y/z.git", "")

	hasTerminal, hasDataDir := false, false
	for _, e := range env {
		if e == "GIT_TERMINAL_PROMPT=0" {
			hasTerminal = true
		}
		if strings.HasPrefix(e, "SC_DATA_DIR=") {
			hasDataDir = true
		}
	}
	if !hasTerminal {
		t.Error("GIT_TERMINAL_PROMPT=0 missing")
	}
	if !hasDataDir {
		t.Error("SC_DATA_DIR missing")
	}
}

// TestHostFromURL 验证从多种 URL 格式提取 host
//
// 覆盖 git@host:path / ssh://[user@]host[:port]/path / https://host/path 三类
//
// 旧 git 包内手写 hostFromURL 与 store.HostFromURL 输出对 SSH scheme 端口的处理存在分歧：
// hostFromURL 走 strings.IndexAny(s, ":/") 截到第一个 : 或 /，对 ssh://git@host:2222/path
// 返回 "host"（端口被截掉，但 SSH 鉴权需要带端口的 host 才能匹配 SSHKey.Host）；
// 改用 store.HostFromURL 后非标准端口会保留（仅 80/443/22 三个标准端口被 strip）
func TestHostFromURL(t *testing.T) {
	cases := []struct {
		name string
		url  string
		want string
	}{
		{"https", "https://github.com/owner/repo.git", "github.com"},
		{"http", "http://gitea.local/owner/repo.git", "gitea.local"},
		{"git-ssh", "git@github.com:owner/repo.git", "github.com"},
		{"ssh-scheme", "ssh://git@github.com:22/owner/repo.git", "github.com"},
		{"ssh-no-port", "ssh://git@gitea.com/owner/repo.git", "gitea.com"},
		// 非标准端口的 ssh:// URL 旧实现会丢失端口（返 "gitea.com"），新实现保留端口
		{"ssh-non-standard-port", "ssh://git@gitea.com:2222/owner/repo.git", "gitea.com:2222"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := store.HostFromURL(tc.url); got != tc.want {
				t.Errorf("store.HostFromURL(%q) = %q, want %q", tc.url, got, tc.want)
			}
		})
	}
}
