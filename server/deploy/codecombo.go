package deploy

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"codecombo/server/sshclient"
)

// CodecomboDeployer 推送 codecombo 二进制 + systemd 服务
//
// 安装布局（二进制放服务用户可写的目录——自更新换包需要 rename 二进制所在
// 目录，root 所有的系统目录会让换包必然 permission denied；家目录执行的
// SELinux 差异由部署末尾的 ensureSELinuxAllowlist 按需白名单处理）：
//
//	二进制  /home/<user>/.codecombo/bin/codecombo
//	数据    /home/<user>/.codecombo（unit 不再下发数据目录 env——首启走默认
//	        路径解析 + 数据目录自动迁移 ~/.simple-coding → ~/.codecombo）
//
// 升级顺序（评审修正版，防双实例双目录分叉）：装新（停旧服务 → 装新二进制 →
// 装新 unit/服务定义）→ 启新触发数据迁移 → 验证存活 → 再卸旧四形态残留
// （旧 unit 文件/launchd plist/@reboot 旧行/SELinux 旧模块/polkit 旧规则/
// sudoers 旧文件）。旧部署器零卸载代码，先卸后装中断会两头落空——装新先行
// 保证任一时刻至少一个可运行形态
type CodecomboDeployer struct{}

// codecomboBinPath 计算指定服务用户的二进制安装路径：
// 数据目录下 bin/codecombo（服务用户可写，是自更新换包的前提）
func codecomboBinPath(user string) string {
	return fmt.Sprintf("/home/%s/.codecombo/bin/codecombo", user)
}

// legacyDataDirOf 旧版数据目录（升级检测与迁移前置判断）
func legacyDataDirOf(user string) string {
	return fmt.Sprintf("/home/%s/.simple-coding", user)
}

func (d *CodecomboDeployer) ID() string          { return "codecombo" }
func (d *CodecomboDeployer) Name() string        { return "deploy.tools.codecombo.name" }
func (d *CodecomboDeployer) Category() string    { return CategorySelfHost }
func (d *CodecomboDeployer) Description() string { return "deploy.tools.codecombo.description" }
func (d *CodecomboDeployer) DependsOn() []string { return []string{"init_user"} }
func (d *CodecomboDeployer) Steps() []string {
	return []string{
		"deploy.steps.preflight",
		"deploy.steps.upload",
		"deploy.steps.installService",
		"deploy.steps.selinux",
		"deploy.steps.verify",
	}
}

// defaultServicePort 服务端口默认值（schema 默认与 resolvePort 兜底共用同一常量，避免两处字面量漂移）
const defaultServicePort = "9999"

// defaultBindHost 绑定地址默认值：远程部署的语义就是「从局域网其他机器访问」，
// 开箱即用绑定 0.0.0.0；首次设密允许局域网来源（服务端有同源限流与审计）
const defaultBindHost = "0.0.0.0"

// 运行方式：service = systemd 服务（开机自启/崩溃恢复，推荐）；
// direct = 直接后台进程（用户域运行，无 SELinux 问题；@reboot 提供开机拉起，
// 进程崩溃不自动恢复）。direct 复用二进制自带的 start/stop/restart/status 守护命令
const (
	runModeService = "service"
	runModeDirect  = "direct"
)

// 沙箱加固开关（systemd NoNewPrivileges）：默认开启——服务进程及其派生的
// 全部终端/智能体禁止 sudo/setuid 提权，防被劫持的智能体横向提权；
// 终端内确需 sudo 的场景可显式关闭。direct 模式无 systemd 单元，本参数不生效
const (
	sandboxOn  = "on"
	sandboxOff = "off"
)

func (d *CodecomboDeployer) AllowMultiple() bool { return false }
func (d *CodecomboDeployer) ParamsSchema() []ParamSpec {
	return []ParamSpec{
		{
			Key:         "port",
			Label:       "deploy.tools.codecombo.params.port",
			Type:        "text",
			Default:     defaultServicePort,
			Placeholder: "deploy.tools.codecombo.params.port.placeholder",
			Help:        "deploy.tools.codecombo.params.port.help",
		},
		{
			Key:         "host",
			Label:       "deploy.tools.codecombo.params.host",
			Type:        "text",
			Default:     defaultBindHost,
			Placeholder: "deploy.tools.codecombo.params.host.placeholder",
			Help:        "deploy.tools.codecombo.params.host.help",
		},
		{
			Key:     "runMode",
			Label:   "deploy.tools.codecombo.params.runMode",
			Type:    "select",
			Default: runModeService,
			Options: []ParamOption{
				{Value: runModeService, Label: "deploy.tools.codecombo.params.runMode.options.service"},
				{Value: runModeDirect, Label: "deploy.tools.codecombo.params.runMode.options.direct"},
			},
			Help: "deploy.tools.codecombo.params.runMode.help",
		},
		{
			Key:     "sandbox",
			Label:   "deploy.tools.codecombo.params.sandbox",
			Type:    "select",
			Default: sandboxOn,
			Options: []ParamOption{
				{Value: sandboxOn, Label: "deploy.tools.codecombo.params.sandbox.options.on"},
				{Value: sandboxOff, Label: "deploy.tools.codecombo.params.sandbox.options.off"},
			},
			Help: "deploy.tools.codecombo.params.sandbox.help",
		},
	}
}

// buildSystemdUnit 按端口与绑定地址生成服务单元。
// 数据目录 env 刻意不下发（P-20261025-1）：二进制按默认路径解析 ~/.codecombo，
// 首启自动迁移旧目录 ~/.simple-coding（显式下发旧路径会让迁移引擎按 skip
// 规则跳过，或新 unit 发新路径命中 skip 直用空目录——两侧都不迁移）；
// 二进制在数据目录 bin/ 下（服务用户可写——自更新换包的前提）。
// PATH 显式下发且含 ~/.local/bin：systemd 默认 PATH 只有系统目录，用户级
// 安装的工具（npm 用户 prefix/pipx 等）一键启动、升级链路都找不到——这是
// 新部署环境「手动能跑、服务内 not found」的常见根因（nvm 目录无法在 unit
// 里通配，由 dsh 启动路径的运行时解析兜底）。
// 沙箱加固：NoNewPrivileges 默认开启（服务进程及其派生的全部终端/智能体禁止
// sudo/setuid 提权），可在部署参数中关闭；不加 ProtectSystem=strict——
// Agent 技能要写 ~/.claude，全盘只读会破坏 AI 助手能力，与文档模板保持一致
func buildSystemdUnit(port, bindHost, user, binPath string, sandbox bool) string {
	sandboxLine := ""
	if sandbox {
		sandboxLine = "NoNewPrivileges=true\n"
	}
	return `[Unit]
Description=Codecombo - Lightweight Coding Platform
After=network.target

[Service]
Type=simple
User=` + user + `
ExecStart=` + binPath + ` --serve --port=` + port + ` --host ` + bindHost + `
Restart=on-failure
WorkingDirectory=/home/` + user + `
Environment=HOME=/home/` + user + `
Environment=PATH=/home/` + user + `/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
` + sandboxLine + `# tmux 持久化终端：KillMode=process 只杀主进程，脱管的 tmux server（含其中的
# 智能体进程）随重启存活，服务重启后可重新 attach；默认 control-group 会整组
# 清扫，"会话重启存活"即失效。PrivateTmp 必须关闭：tmux socket 落在
# /tmp/tmux-<uid>/，私有 tmp 命名空间下重启后看不到旧 socket，恢复扫描必空
KillMode=process

[Install]
WantedBy=multi-user.target
`
}

// resolveBindHost 解析绑定地址参数：空值回退 0.0.0.0（远程部署默认开放局域网），
// 拒绝含空白或非法形态的输入
func resolveBindHost(params map[string]string) (string, error) {
	host := strings.TrimSpace(params["host"])
	if host == "" {
		host = defaultBindHost
	}
	if strings.ContainsAny(host, " \t;|&") {
		return "", fmt.Errorf("invalid bind host: %s", host)
	}
	return host, nil
}

// resolveRunMode 解析运行方式：空值回退 systemd 服务
func resolveRunMode(params map[string]string) string {
	if params["runMode"] == runModeDirect {
		return runModeDirect
	}
	return runModeService
}

// resolveSandbox 解析沙箱加固开关：默认开启，仅显式 "off" 关闭
func resolveSandbox(params map[string]string) bool {
	return params["sandbox"] != sandboxOff
}

// buildDaemonStartCmd 构造直接模式的启动命令：经二进制自带 start 守护命令
// 后台运行（自带 PID 管理），数据目录走默认解析 + 首启自动迁移
//（不下发 SC_DATA_DIR/CC_DATA_DIR——理由同 buildSystemdUnit），@reboot 计划
// 任务亦复用同一命令
func buildDaemonStartCmd(port, bindHost, binPath string) string {
	return fmt.Sprintf(
		`%s start --port=%s --host=%s`,
		binPath, port, bindHost,
	)
}

// resolvePort 解析端口参数（默认 9999），非法值直接报错
func resolvePort(params map[string]string) (string, error) {
	port := params["port"]
	if port == "" {
		port = defaultServicePort
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return "", fmt.Errorf("invalid port: %s", port)
	}
	return port, nil
}

// Deploy 流程：preflight（探测平台+本地二进制）→ upload → installService
// → selinux（Enforcing 自动放宽并提示）→ verify → 卸旧四形态残留
func (d *CodecomboDeployer) Deploy(ctx context.Context, p DeployParams) error {
	log := p.Log
	if p.Cfg == nil || p.Cfg.BinaryDir == "" {
		return fmt.Errorf("binaryDir not configured")
	}
	port, err := resolvePort(p.Params)
	if err != nil {
		return err
	}
	bindHost, err := resolveBindHost(p.Params)
	if err != nil {
		return err
	}
	runMode := resolveRunMode(p.Params)

	log.LogKV("preflight", LevelInfo, "deploy.log.codecombo.detectingPlatform", nil)
	out, err := p.SSH.Exec(ctx, execOpts("uname -s && uname -m"), nil)
	if err != nil || len(out.Stdout) < 2 {
		msg := "uname failed"
		if err != nil {
			msg = err.Error()
		}
		log.LogKV("preflight", LevelFail, "deploy.log.codecombo.unameFailed",
			map[string]any{"error": msg})
		return fmt.Errorf("preflight: %s", msg)
	}
	unameS := strings.TrimSpace(out.Stdout[0])
	unameM := strings.TrimSpace(out.Stdout[1])
	// 本地二进制双名查找（P-20261025-1）：管理员 BinaryDir 过渡期混存两代名，
	// 正名 codecombo-{os}-{arch} 优先、旧名 simple-coding-{os}-{arch} 回落
	var binaryName, localPath string
	for _, candidate := range matchBinaryNameCandidates(unameS, unameM) {
		cp := filepath.Join(p.Cfg.BinaryDir, candidate)
		if _, err := os.Stat(cp); err == nil {
			binaryName, localPath = candidate, cp
			break
		}
	}
	if localPath == "" {
		binaryName = matchBinaryName(unameS, unameM)
		localPath = filepath.Join(p.Cfg.BinaryDir, binaryName)
		log.LogKV("preflight", LevelFail, "deploy.log.codecombo.binaryNotFound",
			map[string]any{"path": localPath})
		return fmt.Errorf("binary not found: %s", localPath)
	}
	log.LogKV("preflight", LevelOK, "deploy.log.codecombo.platformDetected",
		map[string]any{"os": unameS, "arch": unameM, "binary": binaryName})

	log.LogKV("upload", LevelInfo, "deploy.log.codecombo.uploading",
		map[string]any{"path": localPath})
	// 唯一临时名：并发部署不互相踩踏（安装阶段以 %q 引用，规避特殊字符）。
	// 升级路径刻意把新二进制装进旧数据目录（.simple-coding 尚在时）：新服务
	// 首启的数据目录迁移把旧目录整体改名到 .codecombo，新二进制随之落位
	// ExecStart 路径——直接装新路径会提前造出 .codecombo 目录，迁移引擎按
	// 「目标已存在」走合并，脚手架与用户数据分叉的面变大
	uploadTmp := fmt.Sprintf("/tmp/codecombo.upload.%d", time.Now().UnixNano())
	if err := p.SSH.UploadFile(localPath, sshclient.UploadOptions{
		RemotePath: uploadTmp,
		Mode:       0755,
	}); err != nil {
		log.LogKV("upload", LevelFail, "deploy.log.codecombo.uploadFailed",
			map[string]any{"error": err.Error()})
		return fmt.Errorf("upload binary: %w", err)
	}
	// 平台相关安装（二进制统一装入服务用户可写的目录——自更新换包需要
	// rename 二进制所在目录，root 所有的系统目录会让换包必然 permission
	// denied；家目录执行的 SELinux 差异由部署末尾 ensureSELinuxAllowlist
	// 的按需白名单处理）：
	//   Linux  → 数据目录 bin/（systemd/direct 两模式共用）
	//   macOS  → 家目录 bin/（launchd 用户域运行）
	var binPath string
	if unameS == "Darwin" {
		// macOS：无 systemd/SELinux/cld 约定，二进制装家目录 .codecombo/bin。
		// 旧 .simple-coding 存在 → 装进旧目录（首启迁移把整个旧目录改名到
		// .codecombo，新二进制随之落位 plist 钉住的最终路径）
		installRoot := "$HOME/.codecombo"
		binPath = "$HOME/.codecombo/bin/codecombo"
		probe, lerr := p.SSH.Exec(ctx, execOpts(`test -d "$HOME/.simple-coding" && echo yes || echo no`), nil)
		if lerr == nil && len(probe.Stdout) > 0 && strings.TrimSpace(probe.Stdout[0]) == "yes" {
			installRoot = "$HOME/.simple-coding"
		}
		if _, err := p.SSH.Exec(ctx, execOpts(fmt.Sprintf(
			`mkdir -p %s/bin && mv %q %s && chmod 0755 %s`,
			installRoot, uploadTmp, binPath, binPath)), nil); err != nil {
			log.LogKV("upload", LevelFail, "deploy.log.codecombo.uploadFailed",
				map[string]any{"error": err.Error()})
			return fmt.Errorf("install binary: %w", err)
		}
	} else {
		// chown 必须覆盖数据目录根：全新机器上 sudo mkdir -p 会把 .codecombo
		// 连同 bin 一起建成 root 所有，只 chown bin 会让服务（cld）写不进自己的
		// 数据目录（data/、PID 文件、日志全挂）；存量数据目录已是 cld 所有时为 no-op。
		// 旧数据目录 .simple-coding 存在 → bin 装旧目录（随首启迁移改名落位
		// codecomboBinPath 的最终路径，ExecStart/plist 钉迁移后路径）
		legacyDir := legacyDataDirOf(cldUser)
		probe, lerr := p.SSH.Exec(ctx, execOpts(fmt.Sprintf(`test -d %q && echo yes || echo no`, legacyDir)), nil)
		legacyExists := lerr == nil && len(probe.Stdout) > 0 && strings.TrimSpace(probe.Stdout[0]) == "yes"
		binDir := fmt.Sprintf("/home/%s/.codecombo/bin", cldUser)
		chownRoot := fmt.Sprintf("/home/%s/.codecombo", cldUser)
		if legacyExists {
			binDir = legacyDir + "/bin"
			chownRoot = legacyDir
		}
		binPath = codecomboBinPath(cldUser)
		if _, err := execOrFail(ctx, p, "upload", "install binary", execOpts(fmt.Sprintf(
			`sudo mkdir -p %q && sudo install -m 0755 %q %q && sudo chown -R %s %q && rm -f %q`,
			binDir, uploadTmp, binPath, cldUser, chownRoot, uploadTmp)), nil); err != nil {
			return err
		}
		// 存量升级清理：旧版本部署把二进制装在 /usr/local/bin（unit 已改指
		// 新路径），遗留文件 best-effort 清理
		_, _ = p.SSH.Exec(ctx, execOpts(`rm -f /usr/local/bin/simple-coding`), nil)
	}
	log.LogKV("upload", LevelOK, "deploy.log.codecombo.binaryUploaded", nil)

	// macOS（Darwin）：无 systemd，走 launchd；无 SELinux，launchd 用户域运行
	if unameS == "Darwin" {
		plistDir := "$HOME/Library/LaunchAgents"
		// 旧版 launchd 部署先卸（com.simple-coding）：KeepAlive 会把旧二进制
		// 拉回前台抢端口——装新前的停旧是升级顺序的第一闸
		legacyPlist := "$HOME/Library/LaunchAgents/com.simple-coding.plist"
		_, _ = p.SSH.Exec(ctx, execOpts(
			`launchctl unload ` + legacyPlist + ` 2>/dev/null; rm -f ` + legacyPlist), nil)
		plist := plistDir + "/com.codecombo.plist"
		if _, err := p.SSH.Exec(ctx, execOpts(fmt.Sprintf(
			`mkdir -p %s && cat > %s << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.codecombo</string>
  <key>ProgramArguments</key><array>
    <string>%s</string><string>--serve</string><string>--port=%s</string><string>--host=%s</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
PLIST`, plistDir, plist, binPath, port, bindHost)), nil); err != nil {
			log.LogKV("installService", LevelFail, "deploy.log.codecombo.uploadUnitFailed",
				map[string]any{"error": err.Error()})
			return fmt.Errorf("write launchd plist: %w", err)
		}
		if _, err := p.SSH.Exec(ctx, execOpts(
			`launchctl unload `+plist+` 2>/dev/null; launchctl load `+plist), nil); err != nil {
			log.LogKV("installService", LevelFail, "deploy.log.codecombo.serviceNotActive",
				map[string]any{"error": "launchctl load failed"})
			return fmt.Errorf("launchctl load: %w", err)
		}
		log.LogKV("installService", LevelOK, "deploy.log.codecombo.serviceStarted", nil)
		return d.verifyHTTP(ctx, p, port)
	}

	log.LogKV("installService", LevelInfo, "deploy.log.codecombo.writingUnit", nil)
	// 直接进程模式：不装 unit、不需要 SELinux 处理（用户域运行），
	// 用二进制自带 start 守护命令后台运行（自带 PID 管理，先停后启），
	// @reboot 提供开机拉起。管理命令：codecombo stop / restart / status
	if runMode == runModeDirect {
		startCmd := buildDaemonStartCmd(port, bindHost, binPath)
		// 停旧两形态（best-effort）：新路径 daemon stop（重装幂等）+ 旧数据目录
		// 的旧名二进制 stop（旧 daemon 的 pid 文件还在旧目录，能自己停自己）
		_, _ = p.SSH.Exec(ctx, execOpts(strings.Replace(startCmd, " start ", " stop ", 1)+" 2>/dev/null || true"), nil)
		_, _ = p.SSH.Exec(ctx, execOpts(fmt.Sprintf(
			`%s/bin/simple-coding stop 2>/dev/null || true`, legacyDataDirOf(cldUser))), nil)
		if _, err := p.SSH.Exec(ctx, execOpts(startCmd), nil); err != nil {
			log.LogKV("installService", LevelFail, "deploy.log.codecombo.daemonStartFailed",
				map[string]any{"error": err.Error()})
			return fmt.Errorf("start daemon: %w", err)
		}
		log.LogKV("installService", LevelOK, "deploy.log.codecombo.daemonStarted", nil)
		cronLine := fmt.Sprintf("@reboot %s", startCmd)
		// 过滤关键字用产品名而非完整路径：同时清掉旧部署（/usr/local/bin）遗留的行
		if _, err := p.SSH.Exec(ctx, execOpts(fmt.Sprintf(
			`(crontab -l 2>/dev/null | grep -v 'simple-coding' | grep -v 'codecombo' ; echo '%s') | crontab -`,
			cronLine)), nil); err != nil {
			log.LogKV("installService", LevelWarn, "deploy.log.codecombo.cronInstallFailed",
				map[string]any{"error": err.Error()})
		} else {
			log.LogKV("installService", LevelOK, "deploy.log.codecombo.cronInstalled", nil)
		}
		log.LogKV("installService", LevelWarn, "deploy.log.codecombo.directNotice", nil)
		return d.verifyHTTP(ctx, p, port)
	}

	if err := p.SSH.UploadBytes([]byte(buildSystemdUnit(port, bindHost, cldUser, binPath, resolveSandbox(p.Params))), sshclient.UploadOptions{
		RemotePath: "/etc/systemd/system/codecombo.service",
		Mode:       0644,
	}); err != nil {
		log.LogKV("installService", LevelFail, "deploy.log.codecombo.uploadUnitFailed",
			map[string]any{"error": err.Error()})
		return fmt.Errorf("upload unit: %w", err)
	}
	// 升级顺序核心闸：启新前必须先停旧服务（同端口冲突 + 同数据目录双写）。
	// 停旧 best-effort：旧 unit 不存在（全新机）时报错忽略。disable 不删文件
	// ——旧 unit 文件由验证通过后的卸旧阶段统一移除
	if _, err := p.SSH.Exec(ctx, execOpts(
		`sudo systemctl stop simple-coding 2>/dev/null; sudo systemctl disable simple-coding 2>/dev/null; true`), nil); err != nil {
		log.LogKV("installService", LevelWarn, "deploy.log.codecombo.legacyStopFailed", nil)
	}
	if _, err := execOrFail(ctx, p, "installService", "systemctl", execOpts(`
sudo systemctl daemon-reload
sudo systemctl enable codecombo
sudo systemctl restart codecombo
`), nil); err != nil {
		return err
	}
	log.LogKV("installService", LevelOK, "deploy.log.codecombo.serviceStarted", nil)

	// 自更新配套：换包子进程以服务用户身份执行 `systemctl restart`，系统服务
	// 默认要求鉴权——同时安装两代 polkit 机制的放行规则（均只放行本单元重启；
	// 服务带 NoNewPrivileges 时 sudo/setuid 不可用，polkit 走 D-Bus 授权不受
	// 影响；新版 polkit 对 localauthority pkla 保持向后兼容，双装互不冲突）：
	//   rules.d/*.rules          → polkit ≥ 0.106 的 JS 规则（RHEL7+/openEuler/
	//                              Fedora/SUSE/Debian 12+/Ubuntu 23.10+ 等）
	//   localauthority/50-local.d/*.pkla → 旧版 ≤ 0.105 的 pkla 规则
	//                              （Debian 11 / Ubuntu 22.04 等仍在用）
	// 失败仅告警：中心未锁定时更新仍可用，锁定态更新需管理员手动放行
	polkitRule := fmt.Sprintf(`polkit.addRule(function(action, subject) {
    if (action.id == "org.freedesktop.systemd1.manage-units" &&
        subject.user == %q &&
        action.lookup("unit") == "codecombo.service") {
        return polkit.Result.YES;
    }
});`, cldUser)
	polkitPkla := fmt.Sprintf(`[Allow codecombo self-update restart]
Identity=unix-user:%s
Action=org.freedesktop.systemd1.manage-units
ResultAny=yes
`, cldUser)
	if _, err := p.SSH.Exec(ctx, execOpts(fmt.Sprintf(
		`sudo mkdir -p /etc/polkit-1/rules.d /etc/polkit-1/localauthority/50-local.d && sudo tee /etc/polkit-1/rules.d/10-codecombo-restart.rules > /dev/null <<'RULE'
%s
RULE
sudo tee /etc/polkit-1/localauthority/50-local.d/10-codecombo-restart.pkla > /dev/null <<'PKLA'
%s
PKLA
`, polkitRule, polkitPkla)), nil); err != nil {
		log.LogKV("installService", LevelWarn, "deploy.log.codecombo.polkitRuleFailed",
			map[string]any{"error": err.Error()})
	} else {
		log.LogKV("installService", LevelInfo, "deploy.log.codecombo.polkitRuleInstalled", nil)
	}

	if err := d.ensureSELinuxAllowlist(ctx, p, port); err != nil {
		return err
	}

	log.LogKV("verify", LevelInfo, "deploy.log.codecombo.checkingStatus", nil)
	out, err = p.SSH.Exec(ctx, execOpts("systemctl is-active codecombo"), nil)
	if err != nil || out.ExitCode != 0 || len(out.Stdout) == 0 || strings.TrimSpace(out.Stdout[0]) != "active" {
		msg := "service not active"
		if err != nil {
			msg = err.Error()
		} else if len(out.Stdout) > 0 {
			msg = "status: " + strings.TrimSpace(out.Stdout[0])
		}
		log.LogKV("verify", LevelFail, "deploy.log.codecombo.serviceNotActive",
			map[string]any{"error": msg})
		return fmt.Errorf("verify: %s", msg)
	}
	log.LogKV("verify", LevelOK, "deploy.log.codecombo.serviceActive", nil)
	// 验证通过后才卸旧（升级顺序最后一环；中断点恢复语义：任一环节失败时旧
	// 形态残留仍在但新服务已接管，重跑部署幂等续清）
	d.removeLegacyArtifacts(ctx, p)
	return nil
}

// removeLegacyArtifacts 旧部署四形态残留清理（全部 best-effort，逐项失败不
// 阻断）：旧 systemd unit 文件、旧 launchd plist、旧 SELinux 白名单模块、
// 旧 polkit 规则与 sudoers 文件、迁移随行搬来的旧名二进制。
// crontab 旧行在 direct 模式安装时已随 grep -v 一并清除
func (d *CodecomboDeployer) removeLegacyArtifacts(ctx context.Context, p DeployParams) {
	log := p.Log
	// 旧 unit 文件（disable 已在停旧时做过；daemon-reload 让 systemd 忘掉它）
	_, _ = p.SSH.Exec(ctx, execOpts(
		`sudo rm -f /etc/systemd/system/simple-coding.service && sudo systemctl daemon-reload`), nil)
	// 旧 launchd plist（装新前已 unload+rm；此处对 direct 模式升级兜底）
	_, _ = p.SSH.Exec(ctx, execOpts(`rm -f "$HOME/Library/LaunchAgents/com.simple-coding.plist"`), nil)
	// 旧 SELinux 白名单模块（新模块 codecombo-autowhitelist 已在位才卸旧，防
	// 中间态裸奔）
	_, _ = p.SSH.Exec(ctx, execOpts(
		`semodule -l 2>/dev/null | grep -q '^codecombo-autowhitelist' && sudo semodule -r simple-coding-autowhitelist 2>/dev/null || true`), nil)
	// 旧 polkit 规则（放行对象 simple-coding.service 已不存在）
	_, _ = p.SSH.Exec(ctx, execOpts(
		`sudo rm -f /etc/polkit-1/rules.d/10-simple-coding-restart.rules /etc/polkit-1/localauthority/50-local.d/10-simple-coding-restart.pkla`), nil)
	// 旧 sudoers 文件（init_user 现写 99-codecombo）
	_, _ = p.SSH.Exec(ctx, execOpts(`sudo rm -f /etc/sudoers.d/99-simple-coding`), nil)
	// 迁移随行搬来的旧名二进制（.simple-coding/bin/simple-coding 随目录改名
	// 进了 .codecombo/bin；新版服务只认 codecombo）
	_, _ = p.SSH.Exec(ctx, execOpts(
		`rm -f "/home/` + cldUser + `/.codecombo/bin/simple-coding" "$HOME/.codecombo/bin/simple-coding" 2>/dev/null; true`), nil)
	log.LogKV("cleanup", LevelInfo, "deploy.log.codecombo.legacyCleaned", nil)
}

// ensureSELinuxAllowlist systemd 部署模式的 SELinux 按需处理：
// Enforcing 下服务写家目录数据目录会被拒（属主正确也拦），策略是——
//  1. 服务已启动并触发过写入，采集与本服务相关的 AVC 拒绝记录；
//  2. 有拒绝且目标机具备 audit2allow/ausearch 工具 → 生成并安装**只放行本服务
//     被拒操作**的白名单模块（保持 SELinux Enforcing，不削弱整机防护），重启服务生效；
//  3. 有拒绝但工具缺失 → 回退：临时 setenforce 0 并持久化 Permissive，提示用户；
//  4. 无拒绝（Disabled/Permissive/已放行）→ 不动。
//
// 全程通过部署日志告知用户做了什么、为什么、如何恢复 Enforcing
func (d *CodecomboDeployer) ensureSELinuxAllowlist(ctx context.Context, p DeployParams, port string) error {
	log := p.Log
	out, err := p.SSH.Exec(ctx, execOpts("getenforce 2>/dev/null || true"), nil)
	if err != nil {
		return nil // getenforce 不可用：目标无 SELinux，跳过
	}
	mode := strings.TrimSpace(strings.Join(out.Stdout, " "))
	if mode != "Enforcing" {
		return nil
	}
	log.LogKV("selinux", LevelWarn, "deploy.log.codecombo.selinuxDetected",
		map[string]any{"mode": mode})

	// 采集与本服务相关的 AVC 拒绝（服务启动时已触发过数据目录写入尝试）
	avcOut, aerr := p.SSH.Exec(ctx, execOpts(
		// AVC 采集对两代服务名并集（升级链上旧服务触发过的拒绝同样要放行）
		`ausearch -m avc -ts recent 2>/dev/null | grep -iE 'simple-coding|codecombo' | tail -50 || true`), nil)
	hasDenial := aerr == nil && len(avcOut.Stdout) > 0
	denialSample := ""
	if hasDenial {
		denialSample = strings.TrimSpace(strings.Join(avcOut.Stdout, " "))
		if len(denialSample) > 300 {
			denialSample = denialSample[:300]
		}
	}

	const moduleName = "codecombo-autowhitelist"
	if hasDenial {
		// 工具存在性检查：audit2allow 在 policycoreutils-python-utils 包里
		tool, terr := p.SSH.Exec(ctx, execOpts(`command -v audit2allow >/dev/null && echo yes || echo no`), nil)
		hasTool := terr == nil && strings.TrimSpace(strings.Join(tool.Stdout, "")) == "yes"
		if hasTool {
			log.LogKV("selinux", LevelInfo, "deploy.log.codecombo.selinuxWhitelistGenerating",
				map[string]any{"sample": denialSample})
			if _, err := p.SSH.Exec(ctx, execOpts(fmt.Sprintf(
				`ausearch -m avc -ts recent -c codecombo 2>/dev/null | audit2allow -M %s && sudo semodule -i %s.pp && sudo systemctl restart codecombo`,
				moduleName, moduleName)), nil); err != nil {
				log.LogKV("selinux", LevelWarn, "deploy.log.codecombo.selinuxWhitelistFailed",
					map[string]any{"error": err.Error()})
				return d.fallbackPermissive(ctx, p)
			}
			log.LogKV("selinux", LevelWarn, "deploy.log.codecombo.selinuxWhitelistInstalled",
				map[string]any{"module": moduleName})
			return nil // 白名单已生效且服务已重启，直接进入 verify
		}
		// 有拒绝但工具缺失：回退 Permissive
		log.LogKV("selinux", LevelWarn, "deploy.log.codecombo.selinuxNoTool", nil)
		return d.fallbackPermissive(ctx, p)
	}

	// 无 AVC 记录：要么没被拒（无需处理），要么审计子系统不可用。
	// 以服务健康为准：不健康且 Enforcing → 回退 Permissive 保可用；健康 → 不动
	healthOut, herr := p.SSH.Exec(ctx, execOpts(fmt.Sprintf(
		`curl -s -o /dev/null -w '%%{http_code}' --max-time 5 http://127.0.0.1:%s/api/health`, port)), nil)
	healthy := herr == nil && strings.TrimSpace(strings.Join(healthOut.Stdout, "")) == "200"
	if !healthy {
		log.LogKV("selinux", LevelWarn, "deploy.log.codecombo.selinuxNoDenialButUnhealthy", nil)
		return d.fallbackPermissive(ctx, p)
	}
	return nil
}

// fallbackPermissive 回退方案：临时 setenforce 0 + 持久化 Permissive（工具缺失
// 或白名单生成失败时的可用性保底），并显著告知用户影响与恢复路径
func (d *CodecomboDeployer) fallbackPermissive(ctx context.Context, p DeployParams) error {
	if _, err := p.SSH.Exec(ctx, execOpts("sudo setenforce 0"), nil); err != nil {
		log := p.Log
		log.LogKV("selinux", LevelFail, "deploy.log.codecombo.selinuxRelaxFailed",
			map[string]any{"error": err.Error()})
		return fmt.Errorf("setenforce 0: %w", err)
	}
	_, _ = p.SSH.Exec(ctx, execOpts(
		`sudo sed -i.bak -E 's/^SELINUX=enforcing$/SELINUX=permissive/' /etc/selinux/config 2>/dev/null || true`), nil)
	p.Log.LogKV("selinux", LevelWarn, "deploy.log.codecombo.selinuxRelaxed", nil)
	return nil
}

// verifyHTTP 直接进程模式验证：目标机本机 curl 健康端点（systemctl 不可用）
func (d *CodecomboDeployer) verifyHTTP(ctx context.Context, p DeployParams, port string) error {
	log := p.Log
	log.LogKV("verify", LevelInfo, "deploy.log.codecombo.checkingStatus", nil)
	out, err := p.SSH.Exec(ctx, execOpts(fmt.Sprintf(
		`curl -s -o /dev/null -w '%%{http_code}' --max-time 5 http://127.0.0.1:%s/api/health`, port)), nil)
	code := strings.TrimSpace(strings.Join(out.Stdout, " "))
	if err != nil || code != "200" {
		msg := "health check failed"
		if code != "" {
			msg = "http status: " + code
		} else if err != nil {
			msg = err.Error()
		}
		log.LogKV("verify", LevelFail, "deploy.log.codecombo.serviceNotActive",
			map[string]any{"error": msg})
		return fmt.Errorf("verify: %s", msg)
	}
	log.LogKV("verify", LevelOK, "deploy.log.codecombo.serviceActive", nil)
	return nil
}

// matchBinaryName 根据 uname 输出返回对应二进制名（正名，首个候选）
func matchBinaryName(unameS, unameM string) string {
	return matchBinaryNameCandidates(unameS, unameM)[0]
}

// matchBinaryNameCandidates 产物名候选序：codecombo-{os}-{arch} 优先，
// simple-coding-{os}-{arch} 回落（管理员 BinaryDir 过渡期混存两代名，P-20261025-1）
func matchBinaryNameCandidates(unameS, unameM string) []string {
	var osName string
	switch unameS {
	case "Linux":
		osName = "linux"
	case "Darwin":
		osName = "darwin"
	default:
		osName = strings.ToLower(unameS)
	}
	var arch string
	switch unameM {
	case "x86_64", "amd64":
		arch = "amd64"
	case "aarch64", "arm64":
		arch = "arm64"
	default:
		arch = strings.ToLower(unameM)
	}
	suffix := ""
	if osName == "windows" {
		suffix = ".exe"
	}
	return []string{
		fmt.Sprintf("codecombo-%s-%s%s", osName, arch, suffix),
		fmt.Sprintf("simple-coding-%s-%s%s", osName, arch, suffix),
	}
}

func init() {
	Register(&CodecomboDeployer{})
}
