//go:build integration

// 集成测试包：通过 spawn 编译好的 simple-coding 二进制验证 helper 协议端到端正确性
// 用 -tags=integration 启用：go test -tags=integration ./server/git/auth/integration/ -v
// 默认 go test ./... 不会运行本目录测试，避免编译二进制的开销拖慢 CI
package integration

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/git/auth"
	"codecombo/server/store"
)

// TestHelperProtocolSmoke 验证 simple-coding credential-helper get 的 stdin/stdout 协议
//
// 端到端链路：
//  1. 编译 simple-coding 二进制到临时目录
//  2. 用独立 DataDir + SC_DATA_DIR env 隔离（不污染开发者本机配置）
//  3. 通过 filestore + credentialRepo 注入测试 cred（username=alice, password=secret123）
//  4. spawn `<exe> credential-helper get`
//  5. stdin 注入 git credential 协议格式：`protocol=https\nhost=127.0.0.1\n\n`
//  6. 断言 stdout 含 `username=alice` 和 `password=secret123`
//
// 这覆盖了 Plan 2 全链路的关键路径：
//   - main.go 子命令分发
//   - auth.SetProviderLookup 注入 providers.FindByPlatform（main.go 启动期）
//   - RunCredentialHelper 协议解析（parseHelperInput 安全过滤）
//   - HTTPSResolver.Resolve（按 host 查 cred + 按 AuthType 选 provider）
//   - BasicAuthProvider.Resolve（解密 Secret）
//   - 跨进程 master-key 一致性（SC_DATA_DIR 继承）
func TestHelperProtocolSmoke(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping integration test in short mode")
	}

	// 1. 独立 DataDir 隔离
	dataDir := t.TempDir()
	t.Setenv("CC_DATA_DIR", dataDir)

	// 2. 触发 master-key 生成（写入 <dataDir>/data/master-key）
	// 子进程通过继承 SC_DATA_DIR env 定位同一 master-key，从而能解密 Secret
	if _, err := config.EncryptToken("init"); err != nil {
		t.Fatalf("init master key: %v", err)
	}

	// 3. 注入测试 cred：host=127.0.0.1, username=alice, secret=secret123
	// 用 filestore + credentialRepo 走真实持久化路径（写入 <dataDir>/data/credentials/<uuid>）
	credRepo := store.NewCredentialRepo(filestore.New(dataDir))
	encSecret, err := config.EncryptToken("secret123")
	if err != nil {
		t.Fatalf("encrypt secret: %v", err)
	}
	cred := &store.Credential{
		Host:     "127.0.0.1",
		Platform: auth.PlatformGeneric,
		AuthType: store.AuthTypeBasic,
		Username: "alice",
		Secret:   encSecret,
		Status:   store.StatusActive,
	}
	if err := credRepo.Save(cred); err != nil {
		t.Fatalf("save cred: %v", err)
	}

	// 4. 编译 simple-coding 二进制
	exePath := buildSimpleCoding(t)

	// 5. spawn helper 子进程
	// stdin 按 git credential 协议：KV 行 + 空行终止
	stdin := "protocol=https\nhost=127.0.0.1\n\n"

	cmd := exec.Command(exePath, "credential-helper", "get")
	cmd.Env = append(os.Environ(), "SC_DATA_DIR="+dataDir)
	cmd.Stdin = strings.NewReader(stdin)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	// helper 子进程理论上瞬时返回；30s 超时兜底防止 hang
	if err := cmd.Start(); err != nil {
		t.Fatalf("start helper: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("helper exit: %v\nstdout=%q\nstderr=%q", err, stdout.String(), stderr.String())
		}
	case <-time.After(30 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatalf("helper timeout\nstdout=%q\nstderr=%q", stdout.String(), stderr.String())
	}

	// 6. 断言 stdout 协议格式
	out := stdout.String()
	if !strings.Contains(out, "username=alice") {
		t.Errorf("stdout missing 'username=alice'\nstdout=%q\nstderr=%q", out, stderr.String())
	}
	if !strings.Contains(out, "password=secret123") {
		t.Errorf("stdout missing 'password=secret123'\nstdout=%q\nstderr=%q", out, stderr.String())
	}
}

// buildSimpleCoding 编译 simple-coding 二进制到临时目录
//
// 通过 runtime.Caller 定位本测试文件路径，向上查找 go.mod 所在的项目根目录
// 使用 -o 写入 t.TempDir()，测试结束自动清理
func buildSimpleCoding(t *testing.T) string {
	t.Helper()

	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	// file 形如 .../server/git/auth/integration/helper_chain_test.go
	// 向上查找 go.mod 根
	root := filepath.Dir(file)
	for i := 0; i < 10; i++ {
		if _, err := os.Stat(filepath.Join(root, "go.mod")); err == nil {
			break
		}
		root = filepath.Dir(root)
	}
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		t.Fatalf("go.mod not found from %s", file)
	}

	exeName := "simple-coding-test"
	if runtime.GOOS == "windows" {
		exeName += ".exe"
	}
	exePath := filepath.Join(t.TempDir(), exeName)

	cmd := exec.Command("go", "build", "-o", exePath, ".")
	cmd.Dir = root
	var buildOut bytes.Buffer
	cmd.Stdout = &buildOut
	cmd.Stderr = &buildOut
	if err := cmd.Run(); err != nil {
		t.Fatalf("go build: %v\n%s", err, buildOut.String())
	}
	return exePath
}
