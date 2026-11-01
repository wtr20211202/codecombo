package tools

// 一键启动（自动捕获 launch token，免手动配置）与进程生命周期——原 dsh.go
// 「一键启动」节 + 启动命令解析/launchAndWait/stopDsh/launch·restart 端点
// 整体平移（P-20261003-314 纯搬运拆分，逻辑零改动）。平台子进程属性在
// dsh_spawn_{unix,windows}.go，CLI 路径解析通用原语在 dsh.go。

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	shared "codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// dshTokenRe 启动日志里的 launch token（行形如 dsh web: http://…/?token=xxx）。
// dsh 每次启动换新 token 且只打印到 stdout——自动捕获写回设置，
// 免去「每次重启手动同步 token」。字符类不预设 token 字母表（截断比多收更致命），
// 停在 URL/文本边界字符上；捕获时取最后一条，见 captureLaunchToken
var dshTokenRe = regexp.MustCompile(`token=([^&"'\s<>` + "`" + `()\\]+)`)

// captureLaunchToken 日志里最后一次出现的 launch token。dsh 可能不止打印一次
// URL：dsh-doctor 等看护进程重启 web 子进程时会在同一份日志追加新 token 行，
// 最后一条才是当前生效令牌——取首条会拿到已被轮换的旧值，落成「新令牌已捕获
// 仍提示未授权」。尾部标点裁剪防 prose 场景把句点收进 token
func captureLaunchToken(log []byte) (string, bool) {
	var last []byte
	for _, m := range dshTokenRe.FindAllSubmatch(log, -1) {
		last = m[1]
	}
	if last == nil {
		return "", false
	}
	return strings.TrimRight(string(last), ".,;:!?)]}\"'"), true
}

// saveDshToken token 写回设置并持久化（UpdateSettings 同款改取存路径）
func saveDshToken(token string) {
	sc := store.Get().Settings.Get()
	if sc == nil || sc.Server.DshWebToken == token {
		return
	}
	sc.Server.DshWebToken = token
	_ = store.Get().Settings.Save()
}

// dshWebLogPath SC 拉起实例的 stdout 日志（launch token 的事实源）
func dshWebLogPath() string {
	return filepath.Join(config.DataDir(), "dsh-web.log")
}

// 测试注入口（生产恒为真实实现）：令牌回收涉及真实设置持久化与日志路径，
// 测试必须隔离
var (
	dshWebLogPathFn = dshWebLogPath
	saveDshTokenFn  = saveDshToken
)

// refreshLocalToken 从启动日志重取最新 launch token（自动回收的取数步）。
// 日志缺失/无令牌行（实例非 SC 拉起或尚未打印）返回 false
func refreshLocalToken() (string, bool) {
	b, err := os.ReadFile(dshWebLogPathFn())
	if err != nil {
		return "", false
	}
	return captureLaunchToken(b)
}

func hasProxyEnv() bool {
	for _, k := range []string{"http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"} {
		if os.Getenv(k) != "" {
			return true
		}
	}
	return false
}

func withLoopbackNoProxy(cur string) string {
	if strings.Contains(","+cur+",", ",127.0.0.1,") {
		return cur
	}
	np := "localhost,127.0.0.1"
	if cur != "" {
		np += "," + cur
	}
	return np
}

// dshCmdDir 生效启动命令里 dsh 可执行文件所在目录：仅识别首 token 为绝对路径
// 的形态（平台兜底解析出的全路径、用户配置的全路径直启，含引号包裹）；裸命令
// 与 wsl.exe 等包装形态返回空。供子进程 PATH 注入用，见 dshChildEnv
func dshCmdDir(cmdStr string) string {
	s := strings.TrimSpace(cmdStr)
	if s == "" {
		return ""
	}
	if s[0] == '"' {
		end := strings.IndexByte(s[1:], '"')
		if end < 0 {
			return ""
		}
		s = s[1 : 1+end]
	} else if i := strings.IndexAny(s, " \t"); i >= 0 {
		s = s[:i]
	}
	if !filepath.IsAbs(s) {
		return ""
	}
	return filepath.Dir(s)
}

// prependEnvPath 把 dir 插到环境列表 PATH 的最前（无 PATH 则新增；Windows 下
// 键名可能写作 Path，按大小写不敏感匹配避免出现双键）——原地修改并返回 env
func prependEnvPath(env []string, dir string) []string {
	sep := ":"
	if runtime.GOOS == "windows" {
		sep = ";"
	}
	for i, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		if strings.EqualFold(k, "PATH") {
			env[i] = k + "=" + dir + sep + v
			return env
		}
	}
	return append(env, "PATH="+dir)
}

// dshChildEnv 组装 dsh 子进程环境：
//   - PATH prepend dsh 同目录：dsh 是 #!/usr/bin/env node 脚本，按全路径执行后
//     shebang 仍沿 PATH 找解释器——服务最小 PATH（部署 unit 未含 nvm bin）下
//     秒退，即「全路径解析成功仍 env: 'node': No such file or directory」的
//     根因；npm 全局包布局下 node 与包入口同目录，prepend 该目录即根治
//     （nvm/volta/yarn/fnm 同理）
//   - 代理出口注入（吸收自 dsh-web 脚本）：Node 的 fetch 默认不读代理环境变量，
//     LLM 端点多为公网域名，代理-only 主机上不注入则 dsh 的模型调用必挂；
//     no_proxy 必须覆盖回环，防止进程内部到 127.0.0.1 的请求被误送代理
func dshChildEnv(cmdStr string) []string {
	env := os.Environ()
	if dir := dshCmdDir(cmdStr); dir != "" {
		env = prependEnvPath(env, dir)
	}
	if hasProxyEnv() {
		env = append(env, "NODE_USE_ENV_PROXY=1")
		env = append(env, "no_proxy="+withLoopbackNoProxy(os.Getenv("no_proxy")))
	}
	return env
}

// dshDataDirWritableHint ~/.dsh 可写性探针（不可写给出可行动的处理建议；
// 可写返回空串）
func dshDataDirWritableHint() string {
	if runtime.GOOS == "windows" {
		return ""
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	dir := filepath.Join(home, ".dsh")
	if _, err := os.Stat(dir); err != nil {
		return "" // 尚未创建过，首次启动由 dsh 自建
	}
	probe := filepath.Join(dir, ".sc-write-probe")
	if f, err := os.Create(probe); err == nil {
		_ = f.Close()
		_ = os.Remove(probe)
		return ""
	}
	return fmt.Sprintf("%s is not writable (leftover ownership from a previous sudo/root launch?). "+
		"Fix: sudo chown -R \"$(id -un):$(id -gn)\" %s", dir, dir)
}

// launchMu 拉起互斥：并发两次 launch 会拉起两个 dsh，且后者 O_TRUNC 同一日志
// 会清掉前者的 token 捕获源
var launchMu sync.Mutex

// dshDefaultLaunchCommand 默认一键启动命令（DshLaunchCommand 未配置时）
const dshDefaultLaunchCommand = "dsh web --no-open"

// resolveLaunchCommand 生效启动命令。用户显式配置恒照用（含 wsl.exe 包装、
// 全路径等形态）；默认命令按平台兜底解析：
//   - Windows：本机无 dsh 而 WSL 有 → 回退 wsl.exe 并落盘设置（可见可改）
//   - Unix：systemd 最小 PATH 看不到 nvm/用户级 npm prefix——新部署环境
//     「手动能跑、一键启动报 not found」的最常见原因——解析出真实路径后
//     以全路径启动（不落盘：nvm 升级换版本目录后全路径会过期，每次解析廉价）
func resolveLaunchCommand(cfg dshConfig) (cmdStr string, wslFallback bool) {
	if cmdStr = strings.TrimSpace(cfg.LaunchCommand); cmdStr != "" {
		return cmdStr, false
	}
	cmdStr = dshDefaultLaunchCommand
	if runtime.GOOS == "windows" {
		switch {
		case windowsHasDsh():
			return cmdStr, false
		case wslHasDsh():
			cmdStr = "wsl.exe " + cmdStr
			if sc := store.Get().Settings.Get(); sc != nil {
				sc.Server.DshLaunchCommand = cmdStr
				_ = store.Get().Settings.Save()
			}
			return cmdStr, true
		default:
			return cmdStr, false
		}
	}
	if p := resolveUnixDshPath(); p != "" && p != "dsh" {
		cmdStr = dshQuoteIfNeeded(p) + strings.TrimPrefix(cmdStr, "dsh")
	}
	return cmdStr, false
}

func windowsHasDsh() bool {
	return exec.Command("cmd", "/C", "where", "dsh").Run() == nil
}

// wslHasDsh WSL 默认发行版的非交互 PATH 里是否有 dsh（wsl.exe 不存在/
// 无发行版时返回 false；首启 VM 的秒级开销只在 Windows 缺 dsh 时发生）
func wslHasDsh() bool {
	out, err := exec.Command("wsl.exe", "dsh", "--version").CombinedOutput()
	return err == nil && strings.TrimSpace(string(out)) != ""
}

// resolveUnixDshPath dsh 可执行文件全路径解析（Unix 默认启动命令用，找不到。
// 与 server/userbin 的通用实现同类——本函数含 dsh 特化候选与启动命令形态，
// 新增 CLI 解析需求优先用 userbin 而非复制本模式）
// 返回空——保留默认命令快速失败，原因经日志尾部直达 UI）：
//  1. PATH 探测：系统级安装（/usr/local/bin 等）即命中，到此为止
//  2. 用户级常见位置：~/.local/bin（npm 用户 prefix/pipx）、~/bin、
//     ~/.npm-global、volta、yarn；nvm 多版本目录取最新（semver 比较）
//  3. 交互登录 shell 探测兜底：fnm/asdf 等非常规工具链由 .bashrc 注入 PATH，
//     非交互 shell 拿不到——`bash -lic` 与用户手动成功的环境完全同源
func resolveUnixDshPath() string {
	if out, err := exec.Command("/bin/sh", "-c", "command -v dsh").Output(); err == nil {
		if p := lastDshPathLine(string(out)); p != "" {
			return p
		}
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		cands := []string{
			filepath.Join(home, ".local", "bin", "dsh"),
			filepath.Join(home, "bin", "dsh"),
			filepath.Join(home, ".npm-global", "bin", "dsh"),
			filepath.Join(home, ".volta", "bin", "dsh"),
			filepath.Join(home, ".yarn", "bin", "dsh"),
		}
		if hits, _ := filepath.Glob(filepath.Join(home, ".nvm", "versions", "node", "*", "bin", "dsh")); len(hits) > 0 {
			if p := pickNewestNvmDsh(hits); p != "" {
				cands = append(cands, p)
			}
		}
		if p := pickExecutable(cands); p != "" {
			return p
		}
	}
	// 交互登录 shell 兜底：带超时（同 userbin 探测超时语义，坏配置不挂请求）
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	out, err := exec.CommandContext(ctx, "bash", "-lic", "command -v dsh").CombinedOutput()
	cancel()
	if err == nil {
		if p := lastDshPathLine(string(out)); p != "" {
			return p
		}
	}
	return ""
}

// lastDshPathLine 从命令输出取最后一个形如绝对路径且指向 dsh 的词——
// 交互 shell 探测的输出可能混有 motd/告警等噪声（command -v 恒在最后打印）
func lastDshPathLine(out string) string {
	return lastPathLine(out, "dsh")
}

// dshQuoteIfNeeded 全路径含空白时加双引号（经 /bin/sh -c 执行；路径含引号
// 属病态场景，转义后不追求完美）
func dshQuoteIfNeeded(p string) string {
	if strings.ContainsAny(p, " \t") {
		return `"` + strings.ReplaceAll(p, `"`, `\"`) + `"`
	}
	return p
}

// launchExitGrace 包装进程退出后的宽限窗口：`nohup dsh web &` 这类自守护
// 命令的包装器会立刻退出而 dsh 存活，见退出就判死会误杀这种正常用法；
// 宽限期内继续探活，仍无上游才按失败返回
const launchExitGrace = 5 * time.Second

// launchAndWait 拉起 dsh 并等待就绪 + 捕获 token（DshLaunch 与升级重启共用）。
// pid 落盘 DataDir/dsh-web.pid（升级重启/停止需定位进程）。
// 包装进程退出（命令不存在/端口冲突/自守护启动）时快速失败并回传日志尾部，
// 不再干等满 launchReadyTimeout——那正是「一键启动卡一分钟」的体感来源
func launchAndWait() (available bool, tokenCaptured bool, logPath string, spawnErr error, logTail string) {
	launchMu.Lock()
	defer launchMu.Unlock()
	cfg := readConfig()
	cmdStr, _ := resolveLaunchCommand(cfg)
	logPath = dshWebLogPathFn()
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		slog.Warn("dsh launch: open log file failed", "path", logPath, "err", err)
		return false, false, logPath, err, ""
	}
	// 首行记录解析后的实际命令（默认命令经平台兜底解析，可能与配置不同）
	_, _ = logFile.WriteString("[sc] launch: " + cmdStr + "\n")
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd", "/C", cmdStr)
	} else {
		cmd = exec.Command("/bin/sh", "-c", cmdStr)
	}
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = dshSysProcAttr() // nohup 语义：脱离终端/会话独立存活
	cmd.Env = dshChildEnv(cmdStr)      // PATH 注入 dsh 同目录 + 代理出口，见 dshChildEnv
	if err := cmd.Start(); err != nil {
		logFile.Close()
		slog.Warn("dsh launch: spawn failed", "cmd", cmdStr, "err", err)
		return false, false, logPath, err, ""
	}
	logFile.Close()
	_ = os.WriteFile(filepath.Join(config.DataDir(), "dsh-web.pid"),
		[]byte(strconv.Itoa(cmd.Process.Pid)), 0644)
	waitCh := make(chan error, 1)
	go func() { waitCh <- cmd.Wait() }() // 收尸防僵尸；dsh 进程独立存活

	exitedAt := time.Time{}
	deadline := time.Now().Add(launchReadyTimeout)
	available = false
	for time.Now().Before(deadline) {
		select {
		case <-waitCh: // 包装进程已退出（原因在日志尾部，探活/宽限后由 available 反映）
			if exitedAt.IsZero() {
				exitedAt = time.Now()
			}
		default:
		}
		if !tokenCaptured {
			if b, err := os.ReadFile(logPath); err == nil {
				if tok, ok := captureLaunchToken(b); ok {
					saveDshToken(tok)
					tokenCaptured = true
				}
			}
		}
		if probeAvailable(readConfig()) {
			available = true
			break
		}
		if !exitedAt.IsZero() && time.Since(exitedAt) >= launchExitGrace {
			break // 包装已退出且宽限期内上游仍未就绪：注定起不来，快速失败
		}
		time.Sleep(300 * time.Millisecond)
	}
	// token 可能晚于端口就绪打印（实测 0.1.5：就绪即返回会让 settings 留下
	// 过期 token）——就绪后再补捕获最多 5s；进程已退出且上游没起来时无 token
	// 可补，跳过（快速失败路径不多等）
	if available || exitedAt.IsZero() {
		for i := 0; i < 10 && !tokenCaptured; i++ {
			time.Sleep(500 * time.Millisecond)
			if b, err := os.ReadFile(logPath); err == nil {
				if tok, ok := captureLaunchToken(b); ok {
					saveDshToken(tok)
					tokenCaptured = true
				}
			}
		}
	}
	tail := tailFile(logPath, 600)
	if !available {
		// 服务日志补一行：失败详情只落在 dsh-web.log 与 API 响应体里，后端日志
		// 一片安静会让「到底有没有失败/为什么」无从查起（logTail 即日志尾部）
		slog.Warn("dsh launch not ready", "cmd", cmdStr, "logPath", logPath, "logTail", tail)
	}
	return available, tokenCaptured, logPath, spawnErr, tail
}

// tailFile 取文本文件尾部（最多 max 字节；切在行中间时丢弃残行对齐，
// 恰好切在行边界则不多丢）；文件不存在返回空
func tailFile(path string, max int) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	if len(b) > max {
		cutMidLine := len(b) > max+1 && b[len(b)-max-1] != '\n'
		b = b[len(b)-max:]
		if cutMidLine {
			if i := bytes.IndexByte(b, '\n'); i >= 0 {
				b = b[i+1:]
			}
		}
	}
	return strings.TrimSpace(string(b))
}

// DshLaunch POST /api/tools/dsh/launch（launchAndWait 的薄壳）
func DshLaunch(c *gin.Context) {
	cfg := readConfig()
	if probeAvailable(cfg) {
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"available": true, "spawned": false, "tokenCaptured": false}})
		return
	}
	ownHint := dshDataDirWritableHint()
	available, tokenCaptured, logPath, spawnErr, logTail := launchAndWait()
	if spawnErr != nil {
		shared.Error(c, http.StatusInternalServerError, "launch dsh failed",
			fmt.Errorf("%v\n%s", spawnErr, logTail))
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"available":     available,
		"spawned":       true,
		"tokenCaptured": tokenCaptured,
		"logPath":       logPath,
		"logTail":       logTail,
		"ownHint":       ownHint,
	}})
}

// stopDsh 停止本机 dsh（三路覆盖，确保上游端口真正释放后再拉新实例）：
//  1. pid 文件定位 SC 自己拉起的进程（非 Windows 核验 cmdline 含 dsh，防止
//     pid 复用误杀）
//  2. 启动包装前缀（WSL 等跨系统拓扑：DshLaunchCommand = "wsl.exe dsh web …"
//     时 dsh 跑在 WSL 里，Windows 侧 pid/端口都够不着）——经同一执行环境
//     pkill -f "<dsh> web"（吸收自 dsh-web 脚本 stop 的命令匹配 + 端口兜底）
//  3. 等待上游端口释放（探活由活变死，最多 10s）
func stopDsh() {
	pidFile := filepath.Join(config.DataDir(), "dsh-web.pid")
	if b, readErr := os.ReadFile(pidFile); readErr == nil {
		if pid, perr := strconv.Atoi(strings.TrimSpace(string(b))); perr == nil && pid > 0 {
			killable := true
			if runtime.GOOS != "windows" {
				if cl, rerr := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid)); rerr == nil &&
					!strings.Contains(string(cl), "dsh") {
					killable = false // pid 已被无关进程复用：不杀
				}
			} else if out, terr := exec.Command("tasklist", "/FI",
				fmt.Sprintf("PID eq %d", pid), "/FO", "CSV", "/NH").CombinedOutput(); terr == nil {
				// Windows 无 /proc：按镜像名核验。pid 是我方 cmd /C（或 wsl.exe）
				// 包装进程，cmd.exe/wsl.exe 属预期；node.exe/dsh* 是免包装直启。
				// tasklist 失败时保守放行——僵尸 dsh 比误杀低概率更可容忍
				line := strings.ToLower(strings.TrimSpace(string(out)))
				killable = strings.Contains(line, "node.exe") || strings.Contains(line, "dsh") ||
					strings.Contains(line, "cmd.exe") || strings.Contains(line, "wsl.exe")
			}
			if killable {
				if runtime.GOOS == "windows" {
					// 树杀：pid 是包装器，dsh（node）是其子进程，只杀包装器会漏
					_ = exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(pid)).Run()
				} else if p, perr := os.FindProcess(pid); perr == nil {
					_ = p.Kill()
				}
			}
		}
	}
	_ = os.Remove(pidFile)
	// 经同一执行环境停止 dsh：包装器 = dsh 二进制之前的部分（wsl.exe 等），
	// pkill 限定匹配 "<dsh> web"，避免全机误杀
	launch := readConfig().LaunchCommand
	if launch == "" {
		launch = "dsh web --no-open"
	}
	fields := strings.Fields(launch)
	for i, f := range fields {
		if f == "web" && i > 0 {
			wrapper := fields[:i-1]
			pkill := append(append([]string{}, wrapper...), "pkill", "-f", fields[i-1]+" web")
			_ = exec.Command(pkill[0], pkill[1:]...).Run()
			break
		}
	}
	cfg := readConfig()
	for i := 0; i < 20; i++ {
		if !probeAvailableBase(cfg.Base) {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// DshUpgradeRestart POST /api/tools/dsh/upgrade/restart
// 升级安装完成后重启 dsh 加载新版本：停旧进程 → 重新拉起 → 等待就绪。
// 就绪失败不自动回退——由用户在 UI 选择「回退到升级前版本」。
// 与 DshRestart（本机 dsh 一键重启）共用同一重启实现
func DshUpgradeRestart(c *gin.Context) { restartDshProcess(c) }

// DshRestart POST /api/tools/dsh/restart
// 本机 dsh 一键重启（安装插件/改配置后生效用）：停旧进程 → 重新拉起 →
// 等待就绪 + launch token 自动捕获。仅本机目标有意义（外部目标不在本机
// 进程里，无从重启）
func DshRestart(c *gin.Context) { restartDshProcess(c) }

func restartDshProcess(c *gin.Context) {
	// 长操作：清零本响应读写 deadline（就绪等待最长 60s，逼近主 server 写超时）
	rc := http.NewResponseController(c.Writer)
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})
	stopDsh()
	available, tokenCaptured, logPath, spawnErr, logTail := launchAndWait()
	if spawnErr != nil {
		shared.Error(c, http.StatusInternalServerError, "restart dsh failed",
			fmt.Errorf("%v\n%s", spawnErr, logTail))
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"ok":            available,
		"available":     available,
		"tokenCaptured": tokenCaptured,
		"logPath":       logPath,
		"logTail":       logTail,
	}})
}
