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
// 宽限期内继续探活，仍无上游才按失败返回。（P-20261118-4 注记两条收口路径
// 都不烧满 launchReadyTimeout 60s：外部实例占端口（EADDRINUSE）秒退形态——
// 探活成功走 externalOwner 即刻收口（<1s）、探活连败走本宽限（≤5s））
const launchExitGrace = 5 * time.Second

// dshLaunchOutcome launchAndWait 的结果集（P-20261118-4 由 5 个裸返回值聚合：
// 外部占用判读/端口占用归因/探测 base 入响应后返回值越过 5 个，聚合防调用
// 点参数错位——DshLaunch/重启/回退三个调用点同构取用）
type dshLaunchOutcome struct {
	Available     bool
	TokenCaptured bool
	LogPath       string
	SpawnErr      error
	LogTail       string
	// ExternalOwner 探活可用但本次拉起的包装进程已退出且日志无新令牌：监听
	// 端口的是外部运行的实例（第二实例撞 EADDRINUSE 秒退后探到外部进程的
	// 典型形态）。重启/升级链据此显式报「重启未生效：端口被外部进程占用」，
	// 不再静默无效被误判为新版本已加载
	ExternalOwner bool
	// NotReady deadline 收口时拨号通而 HTTP 持续不通的显式态（P-20261118-6
	// 双层判活）：进程在听但 node 事件循环/磁盘被拖慢，HTTP 层迟迟不应答——
	// 不谎报就绪也不假阴性（available=true + NotReady=true，前端提示「已监听
	// 但未就绪」而非笼统成功）
	NotReady bool
	// PortBusy 启动日志明示端口占用（EADDRINUSE / address already in use）：
	// 探活失败但日志归因明确的边缘形态（端口被不响应 TCP 探测的对象占据）
	// 的兜底提示；与 ExternalOwner 并存时二者同源
	PortBusy bool
	// ProbeBase 就绪等待实际探测的本机上游 base（就绪失败时随响应下发——
	// base 被设置导入带偏时一眼可见，衔接空态诊断块）
	ProbeBase string
}

// launchAndWait 拉起 dsh 并等待就绪 + 捕获 token（DshLaunch 与升级重启共用）。
// pid 落盘 DataDir/dsh-web.pid（升级重启/停止需定位进程）。
// 包装进程退出（命令不存在/端口冲突/自守护启动）时快速失败并回传日志尾部，
// 不再干等满 launchReadyTimeout——那正是「一键启动卡一分钟」的体感来源
func launchAndWait() dshLaunchOutcome {
	var out dshLaunchOutcome
	launchMu.Lock()
	defer launchMu.Unlock()
	cfg := readConfig()
	out.ProbeBase = cfg.Base
	cmdStr, _ := resolveLaunchCommand(cfg)
	logPath := dshWebLogPathFn()
	out.LogPath = logPath
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		slog.Warn("dsh launch: open log file failed", "path", logPath, "err", err)
		out.SpawnErr = err
		return out
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
		out.SpawnErr = err
		return out
	}
	logFile.Close()
	_ = os.WriteFile(filepath.Join(config.DataDir(), "dsh-web.pid"),
		[]byte(strconv.Itoa(cmd.Process.Pid)), 0644)
	waitCh := make(chan error, 1)
	go func() { waitCh <- cmd.Wait() }() // 收尸防僵尸；dsh 进程独立存活

	exitedAt := time.Time{}
	deadline := time.Now().Add(launchReadyTimeout)
	alive := false // 最近一轮拨号结果（deadline 收口时区分 notReady 与真失败）
	for time.Now().Before(deadline) {
		select {
		case <-waitCh: // 包装进程已退出（原因在日志尾部，探活/宽限后由 available 反映）
			if exitedAt.IsZero() {
				exitedAt = time.Now()
			}
		default:
		}
		if !out.TokenCaptured {
			if b, err := os.ReadFile(logPath); err == nil {
				if tok, ok := captureLaunchToken(b); ok {
					saveDshToken(tok)
					out.TokenCaptured = true
				}
			}
		}
		if alive, _ = probeAvailableBase(readConfig().Base); alive {
			// 端口可连但令牌未捕获：等一轮让「EADDRINUSE 秒退」落定（探活拨号
			// 快于包装器退出通知的送达，不 drain 会把秒退误判成前台正常形态）
			// 并给令牌打印留窗口（listen 先于 URL 打印的时序差，含 nohup 自守护
			// 形态）——落定后：令牌出现=本次拉起；包装仍活=前台正常形态；包装
			// 已退出且仍无令牌=端口被外部实例占用（监听方非本次拉起）
			if !out.TokenCaptured {
				select {
				case <-waitCh:
					if exitedAt.IsZero() {
						exitedAt = time.Now()
					}
				default:
				}
				time.Sleep(300 * time.Millisecond)
				if b, err := os.ReadFile(logPath); err == nil {
					if tok, okT := captureLaunchToken(b); okT {
						saveDshToken(tok)
						out.TokenCaptured = true
					}
				}
				select {
				case <-waitCh:
					if exitedAt.IsZero() {
						exitedAt = time.Now()
					}
				default:
				}
			}
			// 双层判活（P-20261118-6，P-20261118-4 复审执行要点 R5-1）：拨号通=
			// 活性信号，HTTP 通（任意状态码响应）=就绪判据。有令牌或包装仍活
			// （监听方大概率是本次拉起）时以 HTTP 就绪收口；HTTP 慢的环境继续
			// 等（磁盘卡顿拖慢 node 响应时拨号早已通，若按拨号收口会把「未就绪」
			// 谎报为就绪）——deadline 收口见环外 NotReady 分支
			if out.TokenCaptured || exitedAt.IsZero() {
				if httpProbeReady(readConfig().Base) {
					out.Available = true
					break
				}
			} else {
				// 包装已退出且仍无令牌：端口被外部实例占用。收口不依赖 HTTP
				// 就绪（外部实例可能同样响应缓慢，等它只会白烧 deadline——
				// 重启链「重启未生效」的归因必须及时）
				out.Available = true
				out.ExternalOwner = true
				break
			}
		}
		if !exitedAt.IsZero() && time.Since(exitedAt) >= launchExitGrace && !alive {
			break // 包装已退出且宽限期内上游拨号也不通：注定起不来，快速失败
		}
		time.Sleep(300 * time.Millisecond)
	}
	if !out.Available && alive {
		// deadline 收口（NotReady 显式态）：deadline 内拨号通而 HTTP 持续不通
		// → available=true + NotReady=true——不谎报就绪也不假阴性（卡顿机磁盘
		// 拖慢 HTTP 响应场景两全）
		out.Available = true
		out.NotReady = true
	}
	// token 可能晚于端口就绪打印（实测 0.1.5：就绪即返回会让 settings 留下
	// 过期 token）——就绪后再补捕获最多 5s；进程已退出且上游没起来时无 token
	// 可补，跳过（快速失败路径不多等）；externalOwner 形态同理——本次拉起的
	// 进程已死（端口在听的是外部实例），日志不会再出现令牌行，等待无意义
	if (out.Available && !out.ExternalOwner) || exitedAt.IsZero() {
		for i := 0; i < 10 && !out.TokenCaptured; i++ {
			time.Sleep(500 * time.Millisecond)
			if b, err := os.ReadFile(logPath); err == nil {
				if tok, ok := captureLaunchToken(b); ok {
					saveDshToken(tok)
					out.TokenCaptured = true
				}
			}
		}
	}
	out.LogTail = tailFile(logPath, 600)
	out.PortBusy = logTailSaysPortBusy(out.LogTail)
	if !out.Available {
		// 服务日志补一行：失败详情只落在 dsh-web.log 与 API 响应体里，后端日志
		// 一片安静会让「到底有没有失败/为什么」无从查起（logTail 即日志尾部）
		slog.Warn("dsh launch not ready", "cmd", cmdStr, "logPath", logPath, "logTail", out.LogTail)
	}
	return out
}

// logTailSaysPortBusy 启动日志明示端口占用（跨运行时关键词：node 的
// listen EADDRINUSE 与 go/其他运行时的 address already in use 变体）
func logTailSaysPortBusy(tail string) bool {
	s := strings.ToLower(tail)
	return strings.Contains(s, "eaddrinuse") || strings.Contains(s, "address already in use")
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
	if ok, _ := probeAvailableBase(cfg.Base); ok {
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"available": true, "spawned": false, "tokenCaptured": false}})
		return
	}
	ownHint := dshDataDirWritableHint()
	out := launchAndWait()
	if out.SpawnErr != nil {
		shared.Error(c, http.StatusInternalServerError, "launch dsh failed",
			fmt.Errorf("%v\n%s", out.SpawnErr, out.LogTail))
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"available":     out.Available,
		"spawned":       true,
		"tokenCaptured": out.TokenCaptured,
		"logPath":       out.LogPath,
		"logTail":       out.LogTail,
		"ownHint":       ownHint,
		"externalOwner": out.ExternalOwner,
		"notReady":      out.NotReady,
		"portBusy":      out.PortBusy,
		"probeBase":     out.ProbeBase,
	}})
}

// stopDsh 停止本机 dsh（P-20261118-4 守卫收窄：外部管理的 dsh 生命周期归
// 用户——收窄是实现向「本系统不会结束非自己拉起的进程」承诺对齐）。
// 返回 owned=是否持有「进程由本系统拉起」的归属证据（pid 文件在案）：
//   - owned=true：pid 定位+核验+杀（非 Windows 核验 cmdline 含 dsh，防 pid
//     复用误杀）→ pkill 兜底（WSL 等跨系统拓扑：DshLaunchCommand =
//     "wsl.exe dsh web …" 时 dsh 跑在 WSL 里，Windows 侧 pid 够不着，经同一
//     执行环境 pkill -f "<dsh> web"；启发式边界注记：启动命令在案≠本系统
//     拉起——显式配置过启动命令后改用 systemd 常驻的用户仍会被 pkill 命中，
//     与承诺存在残余缝隙，如实注记不做伪证）→ 等待上游端口由活变死（最多 10s）
//   - owned=false：pid 文件缺失=无证据表明 dsh 由本系统管理 → 不执行 pkill
//     （防杀外部 node/systemd 进程）且不做端口等待——外部进程可能继续持
//     端口，白烧 10s 等待无意义，重启链由 launchAndWait 的探测自行感知
func stopDsh() (owned bool) {
	pidFile := filepath.Join(config.DataDir(), "dsh-web.pid")
	b, readErr := os.ReadFile(pidFile)
	if readErr != nil {
		return false // pid 文件缺失：无归属证据，守卫收窄（外部进程归用户）
	}
	owned = true
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
	_ = os.Remove(pidFile)
	// 经同一执行环境停止 dsh：包装器 = dsh 二进制之前的部分（wsl.exe 等），
	// pkill 限定匹配 "<dsh> web"，避免全机误杀；仅 owned（pid 在案）时执行
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
		if ok, _ := probeAvailableBase(cfg.Base); !ok {
			return owned
		}
		time.Sleep(500 * time.Millisecond)
	}
	return owned
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
	out := launchAndWait()
	if out.SpawnErr != nil {
		shared.Error(c, http.StatusInternalServerError, "restart dsh failed",
			fmt.Errorf("%v\n%s", out.SpawnErr, out.LogTail))
		return
	}
	// externalOwner 显式随响应下发（P-20261118-4 评审必改1）：外部 dsh 占端口
	// 时新实例 EADDRINUSE 秒退、探活探到的是外部进程——available=true 但重启
	// 静默无效，缺此字段前端会误判「新版本已加载」（restartPortBusy 的既有
	// 条件 tokenCaptured&&!valid 在 tokenCaptured=false 时不成立，横幅不触发）
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"ok":            out.Available,
		"available":     out.Available,
		"tokenCaptured": out.TokenCaptured,
		"logPath":       out.LogPath,
		"logTail":       out.LogTail,
		"spawned":       true,
		"externalOwner": out.ExternalOwner,
		"notReady":      out.NotReady,
		"portBusy":      out.PortBusy,
		"probeBase":     out.ProbeBase,
	}})
}
