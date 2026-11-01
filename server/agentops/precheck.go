package agentops

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
	"unicode/utf8"

	"codecombo/server/errmarkers"
	"codecombo/server/userbin"
)

// 运行时创建前预检（P-20261003-79）。
//
// 动机——创建 agent 会话此前对目标运行时零体检：CLI 缺失时选型静默回落其他
// 运行时/降级纯 shell（点名 claude 却得到 codex，用户不知因）；CLI「存在但
// 损坏」（安装残缺/启动即崩）时 Available 照样放行，会话起来即死/黑屏。
// 预检在创建链上把这两种失败换成带运行时名的明确报错（HTTP 侧 400）。
//
// 探测惯例同款（providers_builtin.go 注释）：二进制解析走 userbin（PATH →
// 用户级常见位置 → 登录 shell 兜底）——守护进程 PATH 不含用户工具链，裸
// exec.LookPath 会把「已安装」误报为「未安装」。

// versionQuickCheckTimeout 版本快检超时：TUI 类 CLI 冷启动可达秒级，2s 内
// 跑不完 --version 视为环境异常（完整启动由 PTY 会话承载，预检只判健康度）
const versionQuickCheckTimeout = 2 * time.Second

// runtimeVersionMaxRunes 版本行入库截断宽度（rune）：--version 首行正常是
// 「2.1.3 (Claude Code)」量级；包装脚本可能打印任意内容，防御性截断防止异常
// 超长首行经 meta 与会话快照载荷扩散
const runtimeVersionMaxRunes = 120

// versionProbe 版本快检执行体（变量化供测试注入；userbin.probeLoginShell 同款
// 惯例）。返回 (--version 输出首行, err)：首行供会话元数据 RuntimeVersion
// 快照（P-20261003-134，预检点顺取同一子进程不重复起探测）；stdout 优先、
// stderr 兜底（部分 CLI 把版本打到 stderr）。err 非 nil 时首行值无意义——
// 调用方以 err 为准
var versionProbe = func(bin string, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, bin, "--version")
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return firstVersionLine(stdout.String(), stderr.String()), err
}

// firstVersionLine 取输出中第一个非空行（按参数顺序：stdout 优先 stderr 兜底），
// 去首尾空白并截断到 runtimeVersionMaxRunes；全空返回空串（解析失败容忍，空值）
func firstVersionLine(outputs ...string) string {
	for _, out := range outputs {
		for _, line := range strings.Split(out, "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			if utf8.RuneCountInString(line) > runtimeVersionMaxRunes {
				return string([]rune(line)[:runtimeVersionMaxRunes]) + "…"
			}
			return line
		}
	}
	return ""
}

// PrecheckError 创建前预检失败。对外契约：Error() 原文是前端
// KNOWN_ERROR_I18N（web/src/api/http.ts）的稳定标记——「runtime <名> is not
// installed …」/「runtime <名> failed version quick check …」，改文案须两侧同步。
// 模板文本唯一事实源在 errmarkers 注册表（P-20261004-29）
type PrecheckError struct {
	// Runtime 运行时注册名（错误文案主体，前端据此插值）
	Runtime string
	// Missing true=二进制缺失；false=存在但版本快检失败（安装可能损坏）
	Missing bool
	// Err 版本快检底层错误（缺失时 nil，经 Unwrap 可取）
	Err error
}

func (e *PrecheckError) Error() string {
	if e.Missing {
		return fmt.Sprintf(errmarkers.PrecheckRuntimeMissingTemplate, e.Runtime)
	}
	if e.Err != nil {
		// 详情形态 = 基础模板 + ": 底层错误"（常量拼接，保持与注册表模板同源）
		return fmt.Sprintf(errmarkers.PrecheckVersionCheckTemplate+": %v", e.Runtime, e.Err)
	}
	return fmt.Sprintf(errmarkers.PrecheckVersionCheckTemplate, e.Runtime)
}

func (e *PrecheckError) Unwrap() error { return e.Err }

// PrecheckRuntime 按注册名预检：解析该运行时启动命令首词的二进制（缺失 →
// PrecheckError{Missing}），存在但 --version 快检失败/超时 →
// PrecheckError{version}。顺取语义（P-20261003-134）：第一返回值是预检同一
// 次 --version 子进程的输出首行（健康时为版本行，供会话元数据
// RuntimeVersion 落库），err 非 nil 时空串。两类豁免（返回 nil, ""）：
//   - 未注册名：选型链必回落 auto，由调用方对实际选定者补检
//   - 命令首词为路径形态（自定义智能体的包装脚本绝对路径等）：探测本就不
//     可达，「原样启动」是既有承诺（CustomProvider.Available 注释），失败在
//     终端可见不致黑屏
//
// 每次创建实时执行不缓存（创建低频；刚装好/刚修好立即创建不应吃到旧结论）
func PrecheckRuntime(name string) (string, error) {
	p := providerByName(name)
	if p == nil {
		return "", nil
	}
	cmd, ok := p.InteractiveCommand()
	if !ok || strings.TrimSpace(cmd) == "" {
		return "", nil
	}
	// 路径形态豁免：首词含分隔符 = 用户显式给出的可执行路径，探测覆盖与否
	// 不可知，预检不拦（CustomBinName 只在首词为裸名时才可靠）
	if fields := strings.Fields(cmd); len(fields) > 0 && strings.ContainsAny(fields[0], `/\`) {
		return "", nil
	}
	return PrecheckCommand(name, cmd)
}

// PrecheckCommand 对具体命令行做预检（首词为二进制名，CustomBinName 同款约定）。
// 第一返回值 = --version 输出首行（同一次子进程顺取，err 为 nil 时有意义）
func PrecheckCommand(runtimeName, command string) (string, error) {
	bin := userbin.ResolveBinPath(command)
	if bin == "" {
		return "", &PrecheckError{Runtime: runtimeName, Missing: true}
	}
	version, err := versionProbe(bin, versionQuickCheckTimeout)
	if err != nil {
		return "", &PrecheckError{Runtime: runtimeName, Err: err}
	}
	return version, nil
}

// providerByName 按注册名取 Provider（未注册返回 nil）
func providerByName(name string) Provider {
	providerMu.RLock()
	defer providerMu.RUnlock()
	for _, p := range providers {
		if p.Name() == name {
			return p
		}
	}
	return nil
}
