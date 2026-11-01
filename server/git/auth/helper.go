package auth

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log/slog"
	"regexp"
	"strings"

	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/store"
)

const (
	// helperInputMaxLineBytes 单行最大字节数（防超长行 OOM）
	// git credential protocol 的合法 key/value 远小于 8KB
	helperInputMaxLineBytes = 8 * 1024
	// helperInputMaxFields 单次 helper 调用允许的最大字段数
	// git credential protocol 实际使用约 10 个字段，32 留足余量
	helperInputMaxFields = 32
)

// helperFieldNameRe 字段名必须匹配此正则（^[a-zA-Z_][a-zA-Z0-9_]*$）
// 防止恶意 stdin 注入特殊字符字段名绕过后续处理
var helperFieldNameRe = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

// ProviderLookup 按 (authType, platform) 返回 CredentialProvider
// 由调用方注入，避免 auth 包反向依赖 providers 子包（会产生 import cycle）
// providers 包提供的实现：providers.FindByPlatform
type ProviderLookup func(authType, platform string) CredentialProvider

// defaultProviderLookup 默认实现：返回 nil（让 git 走下一个 helper）
// 生产中由 main.go 在调用 RunCredentialHelper 前注入 providers.FindByPlatform
var defaultProviderLookup ProviderLookup = func(authType, platform string) CredentialProvider {
	return nil
}

// SetProviderLookup 注入 provider 查找函数（main.go 启动期调用）
// 这是打破 auth ↔ providers import cycle 的关键：
// helper.go 在 auth 包内，不能 import providers；由 main.go 桥接
func SetProviderLookup(f ProviderLookup) {
	if f != nil {
		defaultProviderLookup = f
	}
}

// parseHelperInput 读 git credential helper 协议的 stdin KV
// 格式：每行 "key=value"，空行终止
//
// 安全约束（防 stdin 注入）：
//   - 值中含 \r / NUL 字节 → 拒绝（防止 CRLF 注入与二进制污染）
//   - 单行 > 8KB → 拒绝（防超长行 OOM）
//   - 总字段 > 32 → 拒绝（防资源耗尽）
//   - 字段名非法（非 [a-zA-Z_][a-zA-Z0-9_]*） → 跳过该行（不报错）
//   - 空行 → 终止解析
func parseHelperInput(r io.Reader) (map[string]string, error) {
	scanner := bufio.NewScanner(r)
	// 限制单行最大缓冲区，超长行触发 scanner.ErrBufferLong
	scanner.Buffer(make([]byte, 0, 4096), helperInputMaxLineBytes)

	kv := make(map[string]string, 8)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			break // 空行终止
		}
		if len(kv) >= helperInputMaxFields {
			return nil, fmt.Errorf("too many fields (max %d)", helperInputMaxFields)
		}
		// 拒绝值中含 CR / NUL（scanner 已按行分割 LF，但显式检查可挡住 CRLF 与 NUL 注入）
		if strings.ContainsAny(line, "\r\x00") {
			return nil, fmt.Errorf("invalid byte in line")
		}
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue // 无 '=' 或 key 为空 → 跳过
		}
		name := line[:eq]
		value := line[eq+1:]
		if !helperFieldNameRe.MatchString(name) {
			continue // 字段名非法 → 跳过
		}
		kv[name] = value
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read stdin: %w", err)
	}
	return kv, nil
}

// RunCredentialHelper 是 main.go 子命令分发入口
// 子命令字符串 "credential-helper"（连字符，git 调用）↔ Go 函数 RunCredentialHelper（驼峰）
//
// 永远返回 0：让 git 走下一个 helper（如 GCM）兜底
// 即使 cred 查询失败 / provider 报错 / 网络不可达，也只记日志不非零退出
func RunCredentialHelper(args []string, stdin io.Reader, stdout io.Writer) int {
	if len(args) < 1 {
		return 0
	}
	op := args[0]
	input, err := parseHelperInput(stdin)
	if err != nil {
		slog.Error("credential-helper parse input failed", "op", op, "err", err)
		return 0
	}

	switch op {
	case "get":
		return runHelperGet(input, stdout)
	case "store", "erase":
		// P0 no-op：不存储也不删除，让其他 helper 处理
		return 0
	}
	return 0
}

// runHelperGet 轻量路径：装配 HTTPSResolver 后单次调用 Resolve
//
// 设计要点：
//   - helper 子进程不走 main.go 启动期，自行构造 filestore + credentialRepo
//   - Providers map 注入基础 Provider（避免 auth 包反向 import providers）
//   - PlatformLookup 用全局 defaultProviderLookup（由 main.go 启动期注入）
//   - resolver 内部统一处理 expired 持久化 / LastUsedAt 异步更新
func runHelperGet(input map[string]string, stdout io.Writer) int {
	host := input["host"]
	if host == "" {
		return 0
	}
	// git credential 协议把端口放在独立的 port 字段，host 本身不含端口；
	// 而存储的 host 经 normalizeHost 会保留非标准端口（如本地 Gitea 的 localhost:3000），
	// 必须把 port 重组回 host，否则带端口的 HTTPS 凭据永远匹配不上
	if port := input["port"]; port != "" {
		host = host + ":" + port
	}

	resolver := newHelperResolver()
	resolved, err := resolver.Resolve(context.Background(), host)
	if err != nil {
		slog.Error("helper resolve error", "host", host, "err", err)
		return 0
	}
	if resolved == nil {
		// 无 cred / 无 provider / provider 返回 nil → 让 git 走下一个 helper
		return 0
	}

	// 输出给 git credential protocol：username / password 两行
	fmt.Fprintf(stdout, "username=%s\n", resolved.Username)
	fmt.Fprintf(stdout, "password=%s\n", resolved.Password)
	return 0
}

// newHelperResolver 装配 helper 子进程用的 HTTPSResolver
//
// helper 子进程不能依赖 store.Get()（store 在 main.go 启动期初始化）
// 这里自行构造 filestore.New(dataDir) → credentialRepo
// Providers 仅注册基础类型（basic 等），oauth-device 走 PlatformLookup 注入路径
//
// 注：Providers map 中不放 oauth-device 默认 provider——避免 auth 包反向 import providers
// 实际 oauth-device cred 由 PlatformLookup（defaultProviderLookup）兜底返回
func newHelperResolver() *HTTPSResolver {
	dataDir := config.DataDir()
	docStore := filestore.New(dataDir)
	credRepo := store.NewCredentialRepo(docStore)
	return &HTTPSResolver{
		Store:     credRepo,
		Providers: map[string]CredentialProvider{
			// 占位：basic 等无 platform 依赖的 provider 由 PlatformLookup 统一返回
			// 这里保持空 map，让 findProvider 一律走 PlatformLookup
		},
		PlatformLookup: defaultProviderLookup,
	}
}
