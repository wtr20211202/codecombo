package auth

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"codecombo/server/config"
)

// 进程级单例缓存：helper 配置文件路径
//
// 内容固定（[credential] + helper 链），所有 git op 共享同一文件路径，
// 启动期一次写入，零重复 I/O
var (
	cachedCfgPath string
	cfgOnce       sync.Once
)

// GetCachedHelperConfig 返回进程级单例的 GIT_CONFIG_GLOBAL 文件路径
//
// 配置内容固定：
//
//	[credential]
//	    helper =                                  ← 空值：清空 system config 继承的 helper（如系统 GCM）
//	    helper = "<exeAbsPath> credential-helper"
//	    helper = manager
//
// 启动期一次写入 <DataDir>/cache/git-config-helper（目录 0700 + 文件 0600），
// 所有 git op 共享同一文件路径，零重复 I/O
//
// cleanup 当前是 no-op：tmp 文件由 OS 在 <DataDir> 内回收；
// 进程退出后 sync.Once 失效，下次启动重新写
//
// 并发安全：sync.Once 保证只写一次；后续调用直接返回缓存路径
func GetCachedHelperConfig() (path string, cleanup func(), err error) {
	var cfgErr error
	cfgOnce.Do(func() {
		p, werr := writeHelperConfigFile()
		if werr != nil {
			cfgErr = werr
			return
		}
		cachedCfgPath = p
	})
	if cfgErr != nil {
		return "", nil, cfgErr
	}
	// cleanup 是 no-op：进程退出时由 OS 回收；下次启动 cfgOnce 重新写
	return cachedCfgPath, func() {}, nil
}

// writeHelperConfigFile 写 [credential] helper 配置到 <DataDir>/cache/git-config-helper
//
// 内容：
//
//	[credential]
//	    helper =                                  ← 空值：清空 system config 继承的 helper（如系统 GCM）
//	    helper = "<exeAbsPath> credential-helper"
//	    helper = manager                          ← 兜底（本系统 helper 未命中时）
//
// 设计要点：
//   - 必须用 helper =（空值）清空 system config 继承的 helper：git 读 helper 链顺序为
//     system → GIT_CONFIG_GLOBAL，系统装的 Git Credential Manager 会排在本系统 helper 之前
//     helper 之前，优先触发 OAuth 浏览器授权（如本地 Gitea 的 oauth/authorize）
//   - 空值只清空在它之前定义的 helper，之后的本系统 helper + manager 仍正常生效
//   - exeAbsPath 通过 os.Executable() + filepath.Abs() 解析，确保不同 cwd 下都能定位到本程序
//   - 文件权限 0600：仅当前用户可读写，避免其他用户篡改 helper 链
func writeHelperConfigFile() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("get exe path: %w", err)
	}
	absExe, err := filepath.Abs(exe)
	if err != nil {
		return "", fmt.Errorf("abs exe path: %w", err)
	}

	// Windows 下 os.Executable() 返回反斜杠路径，但 git config 把 \ 当转义字符，
	// 直接写入会让 git 报 "bad config line N" 拒绝读取，导致所有 HTTPS clone 失败。
	// filepath.ToSlash 把 \ 转 / —— git config 在所有平台都接受正斜杠路径。
	helperLine := fmt.Sprintf(`helper = "%s credential-helper"`, filepath.ToSlash(absExe))
	// helper =（空值）清空 system config 继承的 helper（如系统安装的 Git Credential Manager）：
	// git 读 helper 链顺序为 system → GIT_CONFIG_GLOBAL，若不清空，系统 GCM 会排在本系统 helper 之前
	// helper 之前被优先调用，进而对未识别 host 触发 OAuth 浏览器授权（如本地 Gitea）。
	// 空值只清空在它之前定义的 helper，之后的本系统 helper + manager 仍生效。
	content := fmt.Sprintf("[credential]\n\thelper =\n\t%s\n\thelper = manager\n", helperLine)

	dir := filepath.Join(config.DataDir(), "cache")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", fmt.Errorf("mkdir cache: %w", err)
	}
	path := filepath.Join(dir, "git-config-helper")
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		return "", fmt.Errorf("write helper config: %w", err)
	}
	return path, nil
}

// ResetHelperConfigCacheForTest 重置进程级 helper config 缓存
// 仅供外部包（如 server/git）的测试调用，避免 sync.Once 跨测试干扰
// 生产代码不应调用此函数
func ResetHelperConfigCacheForTest() {
	cachedCfgPath = ""
	cfgOnce = sync.Once{}
}
