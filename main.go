package main

import (
	"codecombo/server/app"
	"codecombo/server/config"
	"codecombo/server/git/auth"
	"crypto/tls"
	"crypto/x509"
	"embed"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	// providers 经 init() 自注册 provider 表并桥接 auth 查找口
	//（roadmap M2.1：原显式 SetProviderLookup 调用已迁入该包 init）
	_ "codecombo/server/git/auth/providers"
	"codecombo/server/update"
	"strconv"
	"strings"
	"time"
	// 内嵌 IANA tz 数据库（P-20261005-217 定时任务 per-task 时区的前置）：
	// Windows 无系统 zoneinfo、精简容器镜像常无 /usr/share/zoneinfo——而容器
	// 默认 UTC 恰是跨时区错点的主场景，不内嵌则 LoadLocation 全平台静默回落
	// 本地时区。二进制 +~450KB，换取三平台时区语义一致（stdlib，零第三方依赖）
	_ "time/tzdata"
)

// 通过 -ldflags 注入；version 兜底 dev（semver 比较器视为最旧，不会误报有更新）
var (
	version   = "dev"
	commit    = "none"
	buildTime = "unknown"
)

//go:embed all:web/dist
var webFS embed.FS

//go:embed docs/whatsnew.md
var whatsNewMD string

// startPort 保存通过 --port/-p 传入的端口（0 表示使用配置文件默认值）
var startPort int

// startHost 保存通过 --host/-H 传入的绑定地址（"" 表示使用配置文件默认值）
var startHost string

// startTLS / startNoTLS / startTLSCert / startTLSKey TLS 命令行覆盖：
// --tls/--no-tls 显式开/关（默认未配置即开）；--tls-cert/--tls-key 成对指定证书
var (
	startTLS     bool
	startNoTLS   bool
	startTLSCert string
	startTLSKey  string
)

// findFlag 在 os.Args 中查找长/短 flag 的值，支持 "--name value"、"-X value"、"--name=value" 三种形式
// 未找到或末尾缺值时 found=false；返回值原样，不做 TrimSpace（由调用方决定是否容忍空白）
func findFlag(long, short string) (string, bool) {
	for i, arg := range os.Args {
		if (arg == long || arg == short) && i+1 < len(os.Args) {
			return os.Args[i+1], true
		}
		if strings.HasPrefix(arg, long+"=") {
			return strings.TrimPrefix(arg, long+"="), true
		}
	}
	return "", false
}

// parsePortFlag 从参数中提取 --port/-p 值，返回端口（0 表示未指定）
func parsePortFlag() int {
	val, found := findFlag("--port", "-p")
	if !found {
		return 0
	}
	port, err := strconv.Atoi(val)
	if err != nil || port < 1 || port > 65535 {
		fmt.Printf("error: invalid port: %s\n", val)
		os.Exit(1)
	}
	return port
}

// parseHostFlag 从参数中提取 --host/-H 值，返回绑定地址（"" 表示未指定）
// 拒绝空字符串，避免误传导致绑定失败；具体 IP 格式由 net.Listen 自然报错
func parseHostFlag() string {
	val, found := findFlag("--host", "-H")
	if !found {
		return ""
	}
	host := strings.TrimSpace(val)
	if host == "" {
		fmt.Println("error: empty host value")
		os.Exit(1)
	}
	return host
}

// applyCLIOverrides 用 CLI flag 覆盖 cfg.Server 的 Port/Host/TLS
// cmdStart 与 serve 共用：cmdStart 用于计算 probe addr 与构造 daemon args，
// serve 用于让下游 router 看到最终值
func applyCLIOverrides(cfg *config.Config) {
	if startPort > 0 {
		cfg.Server.Port = startPort
	}
	if startHost != "" {
		cfg.Server.Host = startHost
	}
	if startTLSCert != "" && startTLSKey != "" {
		cfg.Server.TLSCertFile = startTLSCert
		cfg.Server.TLSKeyFile = startTLSKey
	}
	// TLS 布尔覆盖（指针写入，区分"显式开/关"与"未配置=默认开"）：
	// CLI --tls/--no-tls 优先，SC_TLS env 次之；两者都未出现时保持配置原值
	switch {
	case startTLS:
		cfg.Server.TLSEnabled = boolPtr(true)
	case startNoTLS:
		cfg.Server.TLSEnabled = boolPtr(false)
	}
	// CC_TLS / SC_TLS（旧名兼容双读一个版本期）/ CC_TLS_CERT / CC_TLS_KEY：
	// TLS 覆盖的 env 通道（优先级低于 CLI flag）。cmdStart → daemon 用它传递
	// 覆盖——daemon 是全新进程，不继承本进程的 flag 解析结果；经 env 继承与
	// 数据目录 env 同机制。CC_TLS=0/false 显式关闭（e2e 与本地明文调试的关闭
	// 通道）。SC_ 旧名回落与 CC_DATA_DIR 同策略：读得到即生效并留痕
	switch strings.ToLower(getenvCompat("CC_TLS", "SC_TLS")) {
	case "1", "true":
		cfg.Server.TLSEnabled = boolPtr(true)
	case "0", "false":
		cfg.Server.TLSEnabled = boolPtr(false)
	}
	if v := getenvCompat("CC_TLS_CERT", "SC_TLS_CERT"); v != "" {
		cfg.Server.TLSCertFile = v
	}
	if v := getenvCompat("CC_TLS_KEY", "SC_TLS_KEY"); v != "" {
		cfg.Server.TLSKeyFile = v
	}
}

// getenvCompat 环境变量新旧名双读（CC_ 正名优先、SC_ 旧名回落一个版本期）。
// 回落即留痕：设置页/启动日志的兼容告警消费 config.LegacyEnvUsed 之外，
// 这里单独在 stderr 留一行——外部脚本/远端 unit 用旧名的静默回落必须可见，
// 否则下一版本移除兼容层时表现为「环境变量突然失效」的假象
func getenvCompat(canonical, legacy string) string {
	if v := os.Getenv(canonical); v != "" {
		return v
	}
	if v := os.Getenv(legacy); v != "" {
		fmt.Fprintf(os.Stderr, "warning: env %s uses legacy SC_ name (%s); rename to %s before the compat window closes\n", legacy, legacy, canonical)
		return v
	}
	return ""
}

// boolPtr 小工具：构造指针字段值
func boolPtr(b bool) *bool { return &b }

// hasFlag 判断布尔 flag 是否出现（不取值；findFlag 是取值型，布尔旗标放
// 参数末尾时会被误判为缺值）
func hasFlag(name string) bool {
	for _, arg := range os.Args[1:] {
		if arg == name {
			return true
		}
	}
	return false
}

// parseTLSFlags 解析 TLS 相关 flag：
//   - --tls / --no-tls：显式开/关（默认未配置即开；同时出现报错）
//   - --tls-cert PATH / --tls-key PATH：成对出现时按指定证书启用
//
// 返回 (auto, noTls, cert, key)；单侧证书缺失直接退出
func parseTLSFlags() (bool, bool, string, string) {
	tlsGiven := hasFlag("--tls")
	noTls := hasFlag("--no-tls")
	if tlsGiven && noTls {
		fmt.Println("error: --tls and --no-tls are mutually exclusive")
		os.Exit(1)
	}
	cert, certGiven := findFlag("--tls-cert", "")
	key, keyGiven := findFlag("--tls-key", "")
	if certGiven != keyGiven {
		fmt.Println("error: --tls-cert and --tls-key must be provided together")
		os.Exit(1)
	}
	return tlsGiven || (certGiven && keyGiven), noTls, cert, key
}

// applyDataDirFlag 应用 --data-dir/-d 显式数据目录。
// 机制：直接覆写 CC_DATA_DIR 环境变量（SC_DATA_DIR 旧名同值双写一个版本期，
// 兼容旧版二进制被显式降级拉起的形态）——DataDir() 的唯一数据源就是该变量，
// 且 daemon / credential-helper 子进程经 env 继承自动生效，
// 因此无需像 --port/--host 那样向 daemon 转发参数。
// 优先级：--data-dir flag > CC_DATA_DIR/SC_DATA_DIR 环境变量 > ~/.codecombo 默认。
// 必须在进入任何子命令前调用：config.Load 的 cfgOnce 会固化首次 DataDir() 结果
func applyDataDirFlag() {
	val, found := findFlag("--data-dir", "-d")
	if !found {
		return
	}
	dir := strings.TrimSpace(val)
	if dir == "" {
		fmt.Println("error: empty data-dir value")
		os.Exit(1)
	}
	// 双写正名与旧名：本版二进制读 CC_ 优先；显式降级回旧版二进制时旧名仍生效
	if err := os.Setenv("CC_DATA_DIR", dir); err != nil {
		fmt.Printf("error: cannot apply data-dir: %v\n", err)
		os.Exit(1)
	}
	_ = os.Setenv("CC_DATA_DIR", dir)
}

func main() {
	// 子命令分发：codecombo credential-helper [get|store|erase]
	// git 通过 GIT_CONFIG_GLOBAL 配置的 helper 路径调用此子命令
	// 必须在 parsePortFlag / CLI 路由之前执行：helper 子进程不需要 port、也不应触发 daemon 解析
	if len(os.Args) >= 2 && os.Args[1] == "credential-helper" {
		// provider 查找口由 providers 包 init() 自注册（import 副作用）
		os.Exit(auth.RunCredentialHelper(os.Args[2:], os.Stdin, os.Stdout))
		return
	}

	startPort = parsePortFlag()
	startHost = parseHostFlag()
	startTLS, startNoTLS, startTLSCert, startTLSKey = parseTLSFlags()
	applyDataDirFlag()

	// 数据目录一次性迁移（P-20261025-1）：~/.simple-coding → ~/.codecombo。
	// 位置约束：必须在 applyDataDirFlag 之后（显式路径参与 skip 判定）、任何
	// config.Load/DataDir 消费者之前。--serve 命中拒绝态（旧实例存活等）直接
	// 退出——带伤启动会在新目录里建出空数据面（master-key/凭据库假性清空）；
	// 非服务子命令（stop/status 等）告警续跑：它们的职责恰是找到并停掉旧
	// 实例，pid 文件查找有旧目录兼容口（config.OpenLegacyPidCompat）
	if err := config.EnsureDataDirMigrated(); err != nil {
		if len(os.Args) >= 2 && os.Args[1] == "--serve" {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "warning: data dir migration deferred: %v\n", err)
	}
	// SC_ 旧名回落告警（兼容期可见性）：显式 SC_DATA_DIR 指到外部路径时本进程
	// 以回落形态运行——用户必须知道，否则兼容层移除时数据面"神秘换目录"
	if config.LegacyEnvUsed() {
		fmt.Fprintln(os.Stderr, "warning: SC_DATA_DIR legacy env detected — rename it to CC_DATA_DIR (SC_ compat reads are scheduled for removal)")
	}

	// 内部标记：实际运行服务器（装配流程已下沉 server/app 组合根）
	if len(os.Args) >= 2 && os.Args[1] == "--serve" {
		// Windows 服务上下文（P-20261103-4）：SCM 启动的进程必须经 svc.Run
		// 对话上报状态/响应停止——裸 --serve 前台逻辑被 sc.exe 注册后启动必然
		// 1053（30 秒无状态上报）。serve 实际执行体打包为闭包传给服务 handler
		if isWindowsService() {
			_ = runWindowsService(func() {
				app.Run(app.Options{
					Version:    version,
					Commit:     commit,
					BuildTime:  buildTime,
					WebFS:      webFS,
					WhatsNewMD: whatsNewMD,
					SignalCh:   setupSignalNotify(),
					Port:       startPort,
					Host:       startHost,
					TLSAuto:    startTLS,
					NoTLS:      startNoTLS,
					TLSCert:    startTLSCert,
					TLSKey:     startTLSKey,
				})
			})
			return
		}
		app.Run(app.Options{
			Version:    version,
			Commit:     commit,
			BuildTime:  buildTime,
			WebFS:      webFS,
			WhatsNewMD: whatsNewMD,
			SignalCh:   setupSignalNotify(),
			Port:       startPort,
			Host:       startHost,
			TLSAuto:    startTLS,
			NoTLS:      startNoTLS,
			TLSCert:    startTLSCert,
			TLSKey:     startTLSKey,
		})
		return
	}

	if len(os.Args) < 2 {
		printHelp()
		return
	}

	switch arg := os.Args[1]; arg {
	case "start":
		cmdStart()
	case "stop":
		cmdStop()
	case "restart":
		cmdRestart()
	case "status":
		cmdStatus()
	case "update":
		cmdUpdate()
	case "_do_update":
		cmdDoUpdate()
	case "uninstall":
		cmdUninstall()
	case "reset-lock":
		cmdResetLock()
	case "version", "-v", "--version":
		printVersion()
	case "help", "-h", "--h", "-help", "--help":
		printHelp()
	default:
		fmt.Printf("unknown command: %s\n\n", arg)
		printHelp()
		os.Exit(1)
	}
}

func printVersion() {
	fmt.Printf("codecombo %s (commit-id=%s, build-time=%s)\nRuntime: %s %s/%s\n", version, commit, buildTime, runtime.Version(), runtime.GOOS, runtime.GOARCH)
}

func printHelp() {
	fmt.Println(`codecombo - 可视化 Git 编码管理平台

Usage:
  codecombo [command]

Commands:
  start       Start the server as a background daemon
  stop        Stop a running server
  restart     Restart the server
  status      Show server status
  update      Trigger an update via a running server (verified, auto-rollback; npm installs: npm i -g codecombo@latest)
  uninstall   Remove all codecombo data
  reset-lock  Reset global lock config (use when password is forgotten)
  version     Show version information
  help        Show this help message

Options:
  -h, --help      Show help
  -v, --version   Show version
  -p, --port PORT Specify server port (default: 9999)
  -H, --host HOST Specify bind host (default: 127.0.0.1; use 0.0.0.0 for LAN access)
  -d, --data-dir DIR Specify data directory (default: ~/.codecombo; overrides CC_DATA_DIR)
      --tls / --no-tls  Force TLS on/off (default: enabled; env CC_TLS=0 also disables)
      --tls-cert FILE / --tls-key FILE  Use CA-issued certificate instead of self-signed`)
}

// ==================== start ====================

func cmdStart() {
	// 检查是否已经在运行
	if isRunning() {
		pid, _ := readPID()
		fmt.Printf("codecombo is already running (PID %d)\n", pid)
		os.Exit(1)
	}

	cfg := config.Load()
	applyCLIOverrides(cfg)

	exe, err := os.Executable()
	if err != nil {
		fmt.Printf("error: cannot determine executable path: %v\n", err)
		os.Exit(1)
	}

	// 解析可执行文件的真实路径
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		exe, _ = filepath.Abs(exe)
	}

	args := []string{"--serve"}
	if startPort > 0 {
		args = append(args, "--port", strconv.Itoa(startPort))
	}
	if startHost != "" {
		args = append(args, "--host", startHost)
	}
	cmd := exec.Command(exe, args...)
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.Stdin = nil

	// TLS 覆盖经 env 传给 daemon（子进程自动继承，与数据目录 env 同机制）；
	// CC_ 正名 + SC_ 旧名双写一个版本期（显式降级回旧版二进制时旧名仍生效）
	if startTLS || startNoTLS || startTLSCert != "" {
		env := []string{}
		if startTLS {
			env = append(env, "CC_TLS=1", "SC_TLS=1")
		}
		if startNoTLS {
			env = append(env, "CC_TLS=0", "SC_TLS=0")
		}
		if startTLSCert != "" {
			env = append(env, "CC_TLS_CERT="+startTLSCert, "SC_TLS_CERT="+startTLSCert)
		}
		if startTLSKey != "" {
			env = append(env, "CC_TLS_KEY="+startTLSKey, "SC_TLS_KEY="+startTLSKey)
		}
		cmd.Env = append(os.Environ(), env...)
	}

	// 后台运行，脱离终端（平台特定）
	setDaemonAttrs(cmd)

	if err := cmd.Start(); err != nil {
		fmt.Printf("error: failed to start server: %v\n", err)
		os.Exit(1)
	}

	// 等待启动完成（最多5秒）。探测通道与展示地址分离：
	//   - 展示地址恒为主端口（TLS 开启即 https://主端口）——历史缺陷：本机
	//     证书不可读（全新数据目录，自签证书由守护进程启动时才生成）时探测
	//     回退到明文回环辅助端口，并把该探测地址当启动地址打印，用户误以为
	//     端口变成了 主端口+1 且没有 TLS
	//   - 探测优先 pinned-cert 直探主端口；证书不可读时改探回环辅助端口
	//     （仅用于就绪判定，不进入任何展示文案）
	displayAddr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port)
	probeScheme := "http"
	// 探测主机与绑定主机分离（通配绑定场景）：绑定 0.0.0.0/:: /空 时 TLS 主机名
	// 校验没有可用名字——自签证书 SAN 只含 localhost/主机名/回环/网卡 IP，永远
	// 不含 0.0.0.0，按绑定主机原样探测握手必败（实测 --host 0.0.0.0 时探测烧满
	// 30s 误报 "not ready"，服务实际早已监听）。通配绑定改探 127.0.0.1：拨号
	// 等价命中本服务，且自签证书必含该回环 IP SAN；绑定具体地址时维持原样
	// （自定义证书可能恰好只覆盖该地址/域名，回环反而不在 SAN 里）
	probeHost := strings.Trim(cfg.Server.Host, "[]")
	switch strings.ToLower(probeHost) {
	case "", "0.0.0.0", "::":
		probeHost = "127.0.0.1"
	}
	probeAddr := net.JoinHostPort(probeHost, strconv.Itoa(cfg.Server.Port))
	client := &http.Client{Timeout: 2 * time.Second}
	tlsOn := cfg.Server.TLSEnabledOrDefault() || (startTLSCert != "" && startTLSKey != "") || startTLS
	loopbackFallback := false
	// 回环辅助端口与运行侧同语义：config.loopbackPort 覆盖默认主端口+1
	loopbackPort := cfg.Server.LoopbackPort
	if loopbackPort == 0 {
		loopbackPort = cfg.Server.Port + 1
	}
	if tlsOn {
		probeScheme = "https"
		certPath := startTLSCert
		if certPath == "" {
			certPath = filepath.Join(config.DataDir(), "certs", "cert.pem")
		}
		if pemData, rerr := os.ReadFile(certPath); rerr == nil {
			pool := x509.NewCertPool()
			pool.AppendCertsFromPEM(pemData)
			client.Transport = &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}
		} else {
			probeScheme, probeAddr = "http", fmt.Sprintf("127.0.0.1:%d", loopbackPort)
			loopbackFallback = true
		}
	}
	started := false
	daemonDied := false
	// 探测窗口 30s：新 exe 首次启动被杀软扫描/冷启动可远超 5s（Windows 实测）；
	// 期间 daemon 死亡（如端口被占崩溃）立即终止等待走失败路径
	for i := 0; i < 300; i++ {
		time.Sleep(100 * time.Millisecond)
		resp, err := client.Get(probeScheme + "://" + probeAddr)
		if err == nil {
			resp.Body.Close()
			started = true
			break
		}
		if pid, perr := readPID(); perr == nil && !isProcessAlive(pid) {
			daemonDied = true
			break
		}
	}

	if started {
		host := displayAddr
		if strings.HasPrefix(host, "0.0.0.0") {
			host = "localhost" + strings.TrimPrefix(host, "0.0.0.0")
		}
		if tlsOn {
			fmt.Printf("codecombo started at https://%s\n", host)
			if loopbackFallback {
				fmt.Printf("(plain-HTTP loopback helper for local CLI/agent callbacks: http://127.0.0.1:%d — not LAN reachable)\n", loopbackPort)
			}
			if plainPort, ok := cfg.Server.HTTPPortOrDefault(cfg.Server.Port); ok {
				// host 含主端口（displayAddr 形态），伴随口自带端口——只取主机部分
				companionHost := host
				if i := strings.LastIndex(companionHost, ":"); i >= 0 {
					companionHost = companionHost[:i]
				}
				if companionHost == "" {
					companionHost = "127.0.0.1"
				}
				fmt.Printf("(plain-HTTP companion: http://%s:%d — credentials unencrypted on this port; disable with \"httpPort\": 0)\n", companionHost, plainPort)
			}
		} else {
			fmt.Printf("codecombo started at http://%s\n", host)
		}
	} else {
		// 探测超时 ≠ 必然失败：新 exe 首次启动被杀软扫描/冷启动可能远超 5s
		// （Windows 侧实测：探测 5s 报失败，服务随后正常就绪监听）。PID 文件
		// 在 gin 装配早期写入（server/app/app.go），存活即可判定「仍在启动」，
		// 如实提示而非误报；日志是按天滚动文件（dailyHandler），文件名带日期，
		// 提示今天真实文件而非拼错的常量名
		// 今日日志路径：新前缀优先，旧前缀存量兜底（P-20261025-1 标识切换过渡期）
		today := time.Now().Format("2006-01-02")
		todayLog := filepath.Join(config.DataDir(), "logs", "codecombo-"+today+".log")
		if _, err := os.Stat(todayLog); err != nil {
			legacyLog := filepath.Join(config.DataDir(), "logs", "simple-coding-"+today+".log")
			if _, lerr := os.Stat(legacyLog); lerr == nil {
				todayLog = legacyLog
			}
		}
		if !daemonDied {
			if pid, perr := readPID(); perr == nil && isProcessAlive(pid) {
				fmt.Printf("server process is alive (PID %d) but not ready within 30s — it may still be starting; run 'status' in a moment\n", pid)
				fmt.Println("logs:", todayLog)
				os.Exit(1)
			}
		}
		fmt.Println("error: server failed to start, check today's log at", todayLog)
		os.Exit(1)
	}
}

// ==================== stop ====================

func cmdStop() {
	pid, err := readPID()
	if err != nil {
		// PID 文件缺失：可能是直接 --serve 启动后异常退出残留，或以非 start 方式启动
		// 回退：通过端口扫描找当前监听 9999 的进程
		cfg := config.Load()
		port := cfg.Server.Port
		if startPort > 0 {
			port = startPort
		}
		if pidByPort, perr := findPIDByPort(port); perr == nil && pidByPort > 0 {
			// 端口巧合防御：同端口可能是完全无关的进程（实测 WSL 的端口转发
			// wslrelay 会占 [::1]:9998），Kill 前必须确认是本服务
			if !looksLikeOurServer(port) {
				fmt.Printf("port %d is listening but not a codecombo server; refusing to stop it\n", port)
				return
			}
			fmt.Printf("PID file missing, found server by port %d (PID %d)\n", port, pidByPort)
			if !isProcessAlive(pidByPort) {
				fmt.Printf("codecombo is not running (stale PID %d)\n", pidByPort)
				return
			}
			pid = pidByPort
		} else {
			fmt.Printf("codecombo is not running (PID file not found at %s)\n", pidFilePath())
			// 兜底探测默认端口：配置端口没有，但默认端口 9999 上可能跑着其他
			// 数据目录的实例（实测场景：e2e 常驻实例占 9999，config 指向其他
			// 端口）。只探测不杀——给出精确的停止命令，杀不杀由用户决定
			if port != 9999 {
				if pidByPort, perr := findPIDByPort(9999); perr == nil && pidByPort > 0 && looksLikeOurServer(9999) {
					fmt.Printf("found a codecombo server on default port 9999 (PID %d, different data dir?) — stop it with: stop -p 9999\n", pidByPort)
				}
			}
			fmt.Println("If server is still listening, find the process manually:")
			fmt.Printf("  - Windows: netstat -ano | findstr :%d  (or)  stop -p <端口>\n", port)
			fmt.Printf("  - Unix:    lsof -i:%d  (or)  ss -tlnp sport = :%d\n", port, port)
			return
		}
	}

	if !isProcessAlive(pid) {
		removePIDFile()
		fmt.Printf("codecombo is not running (stale PID %d)\n", pid)
		return
	}

	// 优雅停机优先（A8）：回环关机端点让服务走 srv.Shutdown（在途请求收尾、
	// 模块 Stop 钩子执行）；旧版本二进制无此端点或已卡死时回退 Kill
	if gracefulStop(pid) {
		removePIDFile()
		fmt.Printf("codecombo stopped gracefully (PID %d)\n", pid)
		return
	}

	proc, _ := os.FindProcess(pid)
	if err := proc.Kill(); err != nil {
		// Kill 报错常见于优雅停机尾声的竞态（进程已在退出，句柄失效）：
		// 复核一次，进程确实消失即视为停止成功
		time.Sleep(500 * time.Millisecond)
		if !isProcessAlive(pid) {
			removePIDFile()
			fmt.Printf("codecombo stopped (PID %d)\n", pid)
			return
		}
		// Windows 上 "Access is denied" 的常见原因与处置：
		//   1. 目标进程以管理员身份运行而当前终端非提升 → 用管理员终端重试
		//   2. 目标进程被系统保护（如杀毒软件锁定）→ 用任务管理器手动结束
		if runtime.GOOS == "windows" && isAccessDenied(err) {
			fmt.Printf("failed to stop server (PID %d): Access is denied.\n", pid)
			fmt.Println("  Common causes and fixes:")
			fmt.Println("    1. The server was started from an elevated (Administrator) terminal.")
			fmt.Println("       → Run this stop command from the same elevated terminal, or use Task Manager.")
			fmt.Println("    2. Antivirus / security software is protecting the process.")
			fmt.Println("    3. The server is running as a Windows service (use services.msc to stop).")
			os.Exit(1)
		}
		fmt.Printf("failed to stop server (PID %d): %v\n", pid, err)
		os.Exit(1)
	}

	// 等待进程退出
	for i := 0; i < 50; i++ {
		time.Sleep(100 * time.Millisecond)
		if !isProcessAlive(pid) {
			break
		}
	}

	removePIDFile()
	fmt.Printf("codecombo stopped (PID %d)\n", pid)
}

// isAccessDenied 判断 Kill 错误是否为 Windows 的 ERROR_ACCESS_DENIED
func isAccessDenied(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "Access is denied") ||
		strings.Contains(err.Error(), "Access Denied")
}

// looksLikeOurServer 探测端口上是否真的是本服务（/api/health 免锁且响应形态独特）
// ——端口扫描回退的 Kill 前置防御，绝不误杀端口巧合的无关进程
func looksLikeOurServer(port int) bool {
	// TLS 启用时主端口是 https：明文回环辅助端口优先（PID 第三行）；
	// PID 缺失则按固定证书尝试 https 探测
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	if lp := readPIDLoopback(); lp > 0 {
		base = fmt.Sprintf("http://127.0.0.1:%d", lp)
	}
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(base + "/api/health")
	if err != nil {
		resp = probeHTTPSWithPinnedCert(port, "/api/health", client)
		if resp == nil {
			return false
		}
	}
	defer func() {
		if resp != nil {
			resp.Body.Close()
		}
	}()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	return err == nil && strings.Contains(string(body), `"checks"`) && strings.Contains(string(body), `"status"`)
}

// probeHTTPSWithPinnedCert 以本地自签证书为信任根探测 https 端点（证书校验
// 完整保留，仅信任本机磁盘上这份证书）；非 TLS 端口或证书不可读返回 nil
func probeHTTPSWithPinnedCert(port int, path string, fallback *http.Client) *http.Response {
	certPath := filepath.Join(config.DataDir(), "certs", "cert.pem")
	pemData, err := os.ReadFile(certPath)
	if err != nil {
		return nil
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pemData) {
		return nil
	}
	client := &http.Client{
		Timeout:   2 * time.Second,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}},
	}
	resp, err := client.Get(fmt.Sprintf("https://127.0.0.1:%d%s", port, path))
	if err != nil {
		return nil
	}
	return resp
}

// gracefulStop 通过本机关机端点（POST /api/shutdown）触发优雅停机（A8）。
// 服务受理并退出返回 true；旧版本二进制无此端点 / 绑定非回环地址 / 服务卡死
// 返回 false，调用方回退 Kill
func gracefulStop(pid int) bool {
	port := 0
	if lp := readPIDLoopback(); lp > 0 {
		// TLS 启用：走明文回环辅助端口（关机端点 CSRF 头语义不变）
		port = lp
	} else if _, p, err := readPIDPort(); err == nil {
		port = p
	}
	if port <= 0 {
		port = config.Load().Server.Port
		if startPort > 0 {
			port = startPort
		}
	}
	req, err := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/api/shutdown", port), nil)
	if err != nil {
		return false
	}
	// 自定义头是端点的 CSRF 约束之一，cmdStop 作为本机进程自然可以携带
	req.Header.Set("X-SC-Shutdown", "1")
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		return false
	}
	// 已受理：等待进程退出（最多 8s）
	for i := 0; i < 80; i++ {
		time.Sleep(100 * time.Millisecond)
		if !isProcessAlive(pid) {
			return true
		}
	}
	return false
}

// ==================== restart ====================

func cmdRestart() {
	if isRunning() {
		fmt.Println("stopping codecombo...")
		cmdStop()
		time.Sleep(500 * time.Millisecond)
	}
	fmt.Println("starting codecombo...")
	cmdStart()
}

// ==================== status ====================

func cmdStatus() {
	pid, port, err := readPIDPort()
	if err != nil || !isProcessAlive(pid) {
		fmt.Println("codecombo is not running")
		if err == nil {
			removePIDFile()
		}
		return
	}

	cfg := config.Load()
	if port == 0 {
		port = cfg.Server.Port
	}
	// scheme 随 TLS 配置展示；优先用 PID 文件第四行的实际监听协议——
	// SC_TLS env / CLI 覆盖不落盘，status 是全新进程读不到当时的覆盖，
	// 只看配置文件会把明文实例报成 https（实测误导）
	scheme := readPIDScheme()
	if scheme == "" {
		scheme = "https"
		if !cfg.Server.TLSEnabledOrDefault() {
			scheme = "http"
		}
	}
	fmt.Printf("codecombo is running (PID %d, %s://%s:%d)\n", pid, scheme, cfg.Server.Host, port)
}

// ==================== uninstall ====================

func cmdUninstall() {
	dataDir := config.DataDir()

	if isRunning() {
		fmt.Println("stopping codecombo...")
		cmdStop()
		time.Sleep(300 * time.Millisecond)
	}

	fmt.Printf("removing %s...\n", dataDir)
	if err := os.RemoveAll(dataDir); err != nil {
		fmt.Printf("error: failed to remove data directory: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("codecombo uninstalled successfully")
}

// ==================== reset-lock ====================

// cmdResetLock 重置全局锁配置
//
// 增强行为：检测服务是否在运行——
//   - 运行中：先停止服务（内存中的旧密码随之失效），再删除 lock 配置。
//   - 未运行：直接删除 lock 配置。
//
// 重置后回到「首次设置密码」状态：重启服务后浏览器会引导设置新密码，
// 不再落入公开已知的默认口令 admin（安全 backlog A3）。
func cmdResetLock() {
	wasRunning := isRunning()
	if wasRunning {
		fmt.Println("server is running, stopping it before reset...")
		cmdStop()
		time.Sleep(300 * time.Millisecond)
	}

	if err := resetLock(); err != nil {
		fmt.Fprintf(os.Stderr, "reset-lock failed: %v\n", err)
		os.Exit(1)
	}

	if wasRunning {
		fmt.Println("lock configuration has been reset and the running server stopped.")
		fmt.Println("you will be asked to set a new password on next startup.")
		fmt.Println("run 'codecombo start' to restart the server.")
	} else {
		fmt.Println("lock configuration has been reset. you will be asked to set a new password on next startup.")
	}
}

// resetLock 删除 docstore 中的 lock config 文档，服务无需运行即可执行
func resetLock() error {
	// 实际路径：~/.codecombo/data/lock/config.json（跨平台用 filepath.Join 拼装）
	lockFile := filepath.Join(config.DataDir(), "data", "lock", "config.json")
	if err := os.Remove(lockFile); err != nil {
		// 文件不存在视为已重置，不报错
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	return nil
}

// ==================== PID 文件管理 ====================

// pidFilePath 返回 pid 文件路径：数据目录下 codecombo.pid（P-20261025-1 起
// 新名；写侧 app.writePIDFile 同名）。CLI 读取侧带旧形态兼容：新名不存在时
// 依次回落数据目录旧名、旧默认目录新/旧名——覆盖「迁移被拒（旧实例存活）
// 时用户用新版 CLI 停旧实例」与「旧目录尚在」的过渡形态。找到哪个用哪个，
// 读不到时错误信息展示首选新路径。
// 旧默认目录的跨界查找仅限「本进程按默认目录运行」（两个数据目录 env 均
// 未设）：显式 -d/env 指定外部目录（e2e 数据面/多实例）绝不跨界——否则
// 会读到真实实例的 pid 文件误杀主实例（并行槽位误杀主实例是实测踩过的旧坑）
func pidFilePath() string {
	dirs := []string{config.DataDir()}
	if os.Getenv("CC_DATA_DIR") == "" && os.Getenv("SC_DATA_DIR") == "" {
		if legacy := config.LegacyDefaultDir(); legacy != "" && legacy != config.DataDir() {
			dirs = append(dirs, legacy)
		}
	}
	if p := config.OpenLegacyPidCompat(dirs...); p != "" {
		return p
	}
	return filepath.Join(config.DataDir(), "codecombo.pid")
}

func readPID() (int, error) {
	data, err := os.ReadFile(pidFilePath())
	if err != nil {
		return 0, err
	}
	line := strings.SplitN(strings.TrimSpace(string(data)), "\n", 2)[0]
	return strconv.Atoi(line)
}

func readPIDPort() (int, int, error) {
	data, err := os.ReadFile(pidFilePath())
	if err != nil {
		return 0, 0, err
	}
	// 按行解析（文件还可能有 loopback/scheme 行——SplitN 取"第二段"会把
	// 后续行拼进端口号导致 Atoi 失败，端口被误判为 0 回退配置默认）
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	pid, err := strconv.Atoi(lines[0])
	if err != nil {
		return 0, 0, err
	}
	port := 0
	if len(lines) > 1 {
		port, _ = strconv.Atoi(strings.TrimSpace(lines[1]))
	}
	return pid, port, nil
}

// readPIDLoopback 读取 PID 文件第三行的明文回环辅助端口（TLS 启用时存在，
// >0 有效；0 = 未启用或旧版本 PID 文件无此行）
func readPIDLoopback() int {
	data, err := os.ReadFile(pidFilePath())
	if err != nil {
		return 0
	}
	parts := strings.SplitN(strings.TrimSpace(string(data)), "\n", 3)
	if len(parts) < 3 {
		return 0
	}
	p, _ := strconv.Atoi(parts[2])
	return p
}

// readPIDScheme 读取 PID 文件中的实际监听协议（https/http；旧版本 PID
// 文件无此行返回 ""，调用方回退配置推断）。scheme 行的位置随 loopback
// 行是否存在而漂移，按"前两行之后的协议字面量"扫描
func readPIDScheme() string {
	data, err := os.ReadFile(pidFilePath())
	if err != nil {
		return ""
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	for _, ln := range lines[min(2, len(lines)):] {
		if s := strings.TrimSpace(ln); s == "http" || s == "https" {
			return s
		}
	}
	return ""
}

func removePIDFile() {
	_ = os.Remove(pidFilePath())
}

func isRunning() bool {
	pid, err := readPID()
	if err != nil {
		return false
	}
	return isProcessAlive(pid)
}

// ==================== Update ====================

// offlineUpdateHint P-20261109-5：CLI 独立换包路径退役后的指引文案。旧离线
// 实现下载后不做 SHA256/ed25519 校验直接替换二进制（供应链面），且缺 npm 形态
// 闸/在途闸/通道口径/回滚健康检查，与 manager 形态（下载→验签→替换→重启→
// 失败回滚）保障缺位——不再保留第二条平行更新链，更新统一收口：运行中的
// 服务端（cmdUpdate 的 API 分支，与 manager 同保障）或包管理器
func offlineUpdateHint() string {
	exePath, _ := os.Executable()
	if update.IsNpmManaged(exePath) {
		return "npm-managed install: run `npm i -g codecombo@latest` to update (the in-app self-update yields to npm by design)"
	}
	return `codecombo is not running — the standalone CLI update path has been retired (it replaced the binary without signature verification).

To update:
  1. start codecombo first (codecombo start), then run codecombo update again — the update then runs inside the server (signature verification + auto-rollback on failure); the version panel in the web UI offers the same flow
  2. installed via a package manager? update through it (npm: npm i -g codecombo@latest)`
}

func cmdUpdate() {
	pid, port, err := readPIDPort()
	if err == nil && port > 0 && isProcessAlive(pid) {
		// 服务运行中，通过内部 API 触发更新——服务端 manager 全链承接
		//（npm 形态闸/在途闸/验签/失败回滚，P-20261109-5 起这是 CLI 唯一更新链）
		// Token 仅存储哈希，CLI 无法附带明文；但 RequireTokenAuth 在本机无 Token 配置时自动跳过。
		// TLS 默认开启后主端口是 https（自签），明文请求握手必失败——
		// 与 gracefulStop 一致优先用 PID 文件第三行的明文回环辅助端口
		if lp := readPIDLoopback(); lp > 0 {
			port = lp
		}
		url := fmt.Sprintf("http://localhost:%d/api/updates/apply", port)
		req, _ := http.NewRequest(http.MethodPost, url, nil)
		// 受理前服务端要先做一次更新源检查（缓存过期时外呼 GitHub API），
		// 10s 在慢链路上偏紧；受理后即返回，下载在服务端后台进行
		client := &http.Client{Timeout: 30 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			fmt.Printf("failed to trigger update via API: %s\n", err)
			os.Exit(1)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		// 202 = 已受理后台进行（P-20261109-10 异步化）；200 兼容旧服务端
		if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusAccepted {
			fmt.Println("update started (running in background — progress in the web UI version panel; result lands in the notification center)")
		} else {
			fmt.Printf("update failed (%d): %s\n", resp.StatusCode, string(body))
			os.Exit(1)
		}
		return
	}

	// 服务未运行：离线换包路径已退役（P-20261109-5，缘由见 offlineUpdateHint），
	// 只留指引不再自行下载替换二进制
	fmt.Println(offlineUpdateHint())
	os.Exit(1)
}

func cmdDoUpdate() {
	if len(os.Args) < 6 {
		fmt.Fprintln(os.Stderr, "internal command")
		os.Exit(1)
	}
	currentBinary := os.Args[2]
	newBinary := os.Args[3]
	port, _ := strconv.Atoi(os.Args[4])
	pid, _ := strconv.Atoi(os.Args[5])

	if err := update.DoUpdate(currentBinary, newBinary, port, pid); err != nil {
		fmt.Fprintf(os.Stderr, "update failed: %s\n", err)
		os.Exit(1)
	}
}
