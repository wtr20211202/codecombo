// Package userbin 服务进程视角的用户级 CLI 解析。
//
// 为什么存在：simple-coding 以守护进程/systemd 方式运行时，进程 PATH 不含
// nvm/fnm/cargo 等用户级工具链（.bashrc 不被加载）——交互 shell 里能跑的
// claude/codex/npm 等在服务端 exec.LookPath 全部失败，表现为「明明已安装、
// 设置页却显示未安装/功能不可用」。本包把「PATH → 用户级常见位置 → 交互
// 登录 shell」的兜底解析收敛为单一实现。
//
// 约定（防再犯）：服务端探测/派生**用户可自装**的 CLI（claude/codex/npm/
// rg 等，凡不是 OS 包管理器或安装器必进系统 PATH 的）一律用本包，禁止裸
// exec.LookPath。系统级硬依赖（git/tmux 等 OS 包）不受此限，但用户级安装
// 场景存在时也建议使用。api/tools 的 npm/dsh 解析含平台特化候选（nvm
// 目录结构差异），暂独立维护——新增解析需求一律走本包。
package userbin

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// probeLoginShellTimeout 登录 shell 探测兜底超时：交互 shell 会加载用户全部
// 配置（nvm/rbenv 初始化动辄数秒、坏配置可能挂住），无超时会拖死调用方
//（该探测发生在请求路径上：搜索加速/工具可用性判定）
const probeLoginShellTimeout = 10 * time.Second

// probeLoginShell 交互登录 shell 探测（变量化供测试注入）
var probeLoginShell = func(name string) (string, bool) {
	if runtime.GOOS == "windows" {
		return "", false
	}
	ctx, cancel := context.WithTimeout(context.Background(), probeLoginShellTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "bash", "-lic", "command -v "+name).CombinedOutput()
	if err != nil {
		return "", false
	}
	p := lastPathLine(string(out), name)
	if p == "" {
		return "", false
	}
	return p, true
}

// lastPathLine 从 shell 输出取最后一个以 / 开头且含 name 的词——
// 交互 shell 输出可能混有 motd/告警噪声（command -v 恒最后打印）
func lastPathLine(out, name string) string {
	p := ""
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "/") && strings.Contains(line, name) {
			if fields := strings.Fields(line); len(fields) > 0 {
				p = fields[len(fields)-1]
			}
		}
	}
	return p
}

// userCandidates 用户级常见安装位置（按名字参数化；系统 PATH 之外的兜底）。
// npm 用户 prefix、pipx、volta、yarn、nvm 多版本（取 semver 最新）、linuxbrew
func userCandidates(home, name string) []string {
	cands := []string{
		filepath.Join(home, ".local", "bin", name),
		filepath.Join(home, "bin", name),
		filepath.Join(home, ".npm-global", "bin", name),
		filepath.Join(home, ".volta", "bin", name),
		filepath.Join(home, ".yarn", "bin", name),
		filepath.Join("/home/linuxbrew", ".linuxbrew", "bin", name),
	}
	if runtime.GOOS == "windows" {
		// npm global 的 Windows 默认位置与 nvm-windows 当前版本 symlink
		if appdata := os.Getenv("AppData"); appdata != "" {
			cands = append(cands, filepath.Join(appdata, "npm", name+".cmd"))
			cands = append(cands, filepath.Join(appdata, "nvm", name+".cmd"))
		}
		return cands
	}
	if hits, _ := filepath.Glob(filepath.Join(home, ".nvm", "versions", "node", "*", "bin", name)); len(hits) > 0 {
		if p := newestNvmHit(hits); p != "" {
			cands = append(cands, p)
		}
	}
	return cands
}

// newestNvmHit nvm 多版本目录（…/versions/node/vX.Y.Z/bin/<name>）取 semver 最新
func newestNvmHit(hits []string) string {
	best, bestDir := "", ""
	for _, h := range hits {
		parts := strings.Split(filepath.ToSlash(h), "/")
		if len(parts) < 3 {
			continue
		}
		dir := parts[len(parts)-3]
		if !isSemverDir(dir) {
			continue
		}
		if best == "" || semverLess(bestDir, dir) {
			best, bestDir = h, dir
		}
	}
	return best
}

func isSemverDir(dir string) bool {
	parts := strings.Split(strings.TrimPrefix(dir, "v"), ".")
	if len(parts) < 2 || len(parts) > 3 {
		return false
	}
	for _, p := range parts {
		if p == "" {
			return false
		}
		for _, r := range p {
			if r < '0' || r > '9' {
				return false
			}
		}
	}
	return true
}

func semverLess(a, b string) bool {
	as, bs := semverNums(a), semverNums(b)
	for i := 0; i < 3; i++ {
		if as[i] != bs[i] {
			return as[i] < bs[i]
		}
	}
	return false
}

func semverNums(dir string) [3]int {
	var out [3]int
	parts := strings.Split(strings.TrimPrefix(dir, "v"), ".")
	for i := 0; i < len(parts) && i < 3; i++ {
		n := 0
		for _, r := range parts[i] {
			n = n*10 + int(r-'0')
		}
		out[i] = n
	}
	return out
}

func pickExecutable(cands []string) string {
	for _, p := range cands {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			if runtime.GOOS == "windows" || st.Mode()&0111 != 0 {
				return p
			}
		}
	}
	return ""
}

// ============== 解析结果缓存 ==============
// 成功 5min（用户换工具链版本后自愈）、失败 30s（运行中补装不必重启）。
// bash -lic 探测秒级开销，Available 类调用高频，不能每次付。
var (
	mu    sync.Mutex
	cache = map[string]resolveEntry{}
)

type resolveEntry struct {
	path string
	at   time.Time
}

// ResetCache 失效全部解析结果缓存：设置页「运行时检测」手动刷新通道（P-20261003-79）
// ——用户刚安装/卸载 CLI 后不等 TTL（成功 5min/失败 30s）立即如实重探
func ResetCache() {
	mu.Lock()
	defer mu.Unlock()
	cache = map[string]resolveEntry{}
}

// ResetCacheForTest 仅供测试使用：清空解析缓存（语义同 ResetCache，保留旧名
// 防既有测试调用面漂移）
func ResetCacheForTest() { ResetCache() }

// Resolve 解析 CLI 可执行文件全路径：PATH 快路径 → 用户级常见位置 →
// 交互登录 shell 兜底（Unix）。找不到返回 ("", false)。
// 结果带缓存（成功 5min / 失败 30s），失败也缓存——高频探测不反复付
// 秒级 shell 开销。
func Resolve(name string) (string, bool) {
	if name == "" {
		return "", false
	}
	mu.Lock()
	if e, ok := cache[name]; ok {
		ttl := 5 * time.Minute
		if e.path == "" {
			ttl = 30 * time.Second
		}
		if time.Since(e.at) < ttl {
			mu.Unlock()
			return e.path, e.path != ""
		}
	}
	mu.Unlock()

	path := resolve(name)

	mu.Lock()
	cache[name] = resolveEntry{path: path, at: time.Now()}
	mu.Unlock()
	return path, path != ""
}

func resolve(name string) string {
	if _, err := exec.LookPath(name); err == nil {
		return name
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		if p := pickExecutable(userCandidates(home, name)); p != "" {
			return p
		}
	}
	if p, ok := probeLoginShell(name); ok {
		return p
	}
	return ""
}

// Available 便捷形态：CLI 是否可用（内部走 Resolve 的同一缓存）
func Available(name string) bool {
	_, ok := Resolve(name)
	return ok
}

// ResolveBinPath 命令行首词二进制解析：命令行可带参数（自定义智能体如
// `aider --model x`），整串无法作为可执行文件探测，约定首词为二进制名。
// 解析失败返回空串（调用方按不可用处理，与 Available 口径一致）
func ResolveBinPath(command string) string {
	fields := strings.Fields(command)
	if len(fields) == 0 {
		return ""
	}
	p, _ := Resolve(fields[0])
	return p
}
