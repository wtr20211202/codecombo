package system

import (
	"fmt"
	"net/http"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"codecombo/server/agentops"
	terminalapi "codecombo/server/api/terminal"
	"codecombo/server/config"
	"codecombo/server/git"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// SelfCheck GET /api/selfcheck —— 本机环境体检（P-20261003-317）。
//
// 动机：远程主机有一键诊断（remotehost_diag），本机实例反而没有——新人配置
// 检查（tmux 装没装 / git LFS / agent 运行时可用性）要逐项手查，社区求助或提
// issue 时「附环境信息」也是高频诉求。本端点把零散存在的既有信号聚合为一张
// 只读体检单：git/git-lfs 工具链版本、tmux 可用性、agent 运行时清单与版本、
// 已登记 dev 端口（P-293 注册表）、应用 buildInfo、数据盘水位（P-12 既有探测）、
// 配置文件完整性（P-20261006-10 损坏降级态显影）。
//
// 形态：各条目 {item, status, detail, hint}——item 是稳定键（前端 i18n 映射
// 标题、agent 程序化分支），status 三态 ok/warn/fail（前端语义色），detail/hint
// 语言中立（版本号/路径/命令形态，Markdown 直出贴 issue）。体检只读无副作用；
// 子进程类探测（git/lfs）带 2s 超时上限防个别项卡住拖死整页，其余条目直读
// 内存/既有缓存探测面，无新增阻塞点。挂在全局 api 组（LockMiddleware+
// TokenAuth 同门控面），agent 经 ops 手册 selfcheck 节消费（排障第一步自查）。
//
// 平台注记：tmux 仅 Unix 承载持久会话（Windows 走 native PTY 后端），Windows
// 下该条目恒 ok 且如实注记 not applicable；磁盘水位复用 sysinfo.Usage 既有
// 双平台实现（statfs / GetDiskFreeSpaceEx），本文件不新增平台分支。
//
// 趋势留痕（P-20261005-169）：体检对环境仍只读，但每次 GET（手动/agent 体检）
// 与每日定时（selfcheck-snapshot 巡检，selfcheckhist.go）都把数值快照
//（磁盘/堆内存/活跃会话/终端数/goroutine）落 selfcheckhist 环形 20 条，响应
// 内联 hist = {runs, latest, prev?, delta?} 供面板头部「与上次」趋势条与
// agent 自算跨天趋势。远程主机趋势经 /api/remotehosts/diaghist（host 键枚举
// 只含现存远程主机），本机趋势独立 kind 无键空间交叉。

// selfCheckProbeTimeout 单项探测超时上限：git/lfs 版本是起子进程的探测，万一
// 在病态环境挂住（AV 扫描/网络盘 CWD 等）不应拖死整个体检请求；2s 与 agentops
// 版本快检同口径。超时后探测 goroutine 由 execGitProbe 自身的 60s 分类超时兜底
// 回收（通道带缓冲，泄漏以秒计且有界）。变量化供单测注入短超时
var selfCheckProbeTimeout = 2 * time.Second

// SelfCheckItem 体检单条目
type SelfCheckItem struct {
	// Item 稳定键：version / git / lfs / tmux / agent-runtimes / ports / disk / config
	Item string `json:"item"`
	// Status 三态：ok（通过）/ warn（警告，可用但有缺憾）/ fail（失败，核心能力受损）
	Status string `json:"status"`
	// Detail 语言中立明细（版本号/路径/水位数值），issue Markdown 直出
	Detail string `json:"detail"`
	// Hint 修复指引（语言中立，命令/路径形态）；ok 态通常为空
	Hint string `json:"hint,omitempty"`
}

// SelfCheck 体检端点（只读聚合，无 AgentGuard 高危面——与 /api/system/health 同族）。
// P-20261005-169 起 GET 顺带入账一条数值快照（selfcheckhist 环形 20 条）并在
// 响应内联与上一次的对比（hist 字段）——体检对环境的探测面仍只读，落盘的只有
// 本实例自身的趋势留痕（与远程诊断响应内联 compare 同构）
func SelfCheck(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"data": SelfCheckReport(), "hist": recordSelfCheckSnapshot()})
}

func init() {
	// 智能体手册登记：环境排障第一步自查（先体检后动手，缺什么装什么），
	// 与 sentinels 分节同款形态；Order 5 排在 meta/host-env 之前——排障入口
	// 前置（agentops 手册按 Order 升序输出）
	agentops.RegisterSection(agentops.Section{
		ID: "selfcheck", Title: "环境体检（排障第一步）", Order: 5,
		Summary: "GET /api/selfcheck 一张只读体检单聚合本机环境信号（git/lfs/tmux/agent 运行时/端口/版本/磁盘）——排障先自查，warn/fail 条目带 hint 修复指引；响应内联 hist 本机趋势快照（每日定时+每次体检入账，环形 20 条）",
		Body: `环境类问题（clone 失败/agent 起不来/磁盘写满）先调本端点自查，再按
warn/fail 条目的 hint 修复——与安装引导形成闭环，不要凭空猜环境缺什么。

- GET /api/selfcheck                          本机环境体检（只读无副作用）
  返回 {"data":[{item,status,detail,hint},...],"hist":{runs,latest,prev?,delta?}}：
  - item   稳定键：version / git / lfs / tmux / agent-runtimes / ports / disk / config
  - status 三态：ok=通过 / warn=警告（可用但有缺憾）/ fail=失败（核心能力受损）
  - detail 语言中立明细（版本号/路径/水位数值）
  - hint   修复指引（命令/路径形态，warn/fail 才有）
  - hist   本机趋势（P-20261005-169）：每次体检与每日定时各落一条数值快照
           （selfcheckhist 环形 20 条），prev=上一次快照、delta=本次-上次差值，
           字段同 latest；零值 = 未采集（如 diskAvailMB=0 表示数据盘不可观测）。
           跨天趋势自算：直接对多次调用的 latest 按时间排序比较即可
  - latest 数值快照字段：time / diskAvailMB / diskTotalMB（数据盘，MB）/
           memUsedMB（进程堆内存）/ activeSessions（OSC 运行点亮会话）/
           terminals（打开的终端总数）/ goroutines

## 各条目语义与处置

- git    fail = git 不可用：clone/commit 全不可用，装 git 后重启服务
- lfs    warn = 未装 git-lfs：仅操作 LFS 仓库需要，按 hint 装
- tmux   warn = Unix 未装/版本过旧（3.3+）：持久会话与重启恢复不可用，
         native 后端仍可用；Windows 恒 ok（native PTY 承载，条目注记 n/a）
- agent-runtimes warn = 无任何运行时可用：agent 会话起不来（shell 不受影响），
         按 hint 装任一运行时或在设置·Agent 注册自定义智能体
- disk   warn/fail = 数据盘水位超 80%/90%：先清理 artifacts/录制/构建缓存
- ports  ok = 已登记 dev 端口一览（登记面=探测/上报面，非全量 netstat）
- version ok = 应用构建信息（版本/提交/构建时间/Go 版本/平台）
- config warn = config.json 启动时损坏（已保全于 .corrupt-* 副本）：端口/
         代理等设置已回默认，按 hint 对比恢复后重启；改配置文件前先看本条

## 推荐用法（示例）

1) 接手排障任务先体检一遍，把 warn/fail 汇报给用户：
` + "```bash" + `
curl {{BASE}}/api/selfcheck -H "X-Lock-Token: $CC_LOCK_TOKEN"
# {"data":[{"item":"git","status":"ok","detail":"git version 2.51.0",...},...]}
` + "```" + `

2) 提 issue/求助时把整份体检单（JSON 或前端「复制为 Markdown」产物）附上，
   version 条目让维护者直接定位版本。`,
	})
}

// SelfCheckReport 聚合全部体检条目（导出供单测与未来复用）
func SelfCheckReport() []SelfCheckItem {
	items := make([]SelfCheckItem, 0, 8)
	items = append(items, versionItem(), gitItem(), lfsItem(),
		tmuxItem(), agentRuntimesItem(), portsItem(), diskItem(), configItem())
	return items
}

// versionItem 应用构建信息：恒 ok（自检基线行，issue 环境信息的主体）
func versionItem() SelfCheckItem {
	v, commit, buildTime := BuildInfo()
	return SelfCheckItem{
		Item:   "version",
		Status: "ok",
		Detail: fmt.Sprintf("codecombo %s (%s) built %s, %s, %s/%s",
			v, commit, buildTime, runtime.Version(), runtime.GOOS, runtime.GOARCH),
	}
}

// gitItem git 工具链：缺失 = fail（clone/commit 等核心能力全不可用）
func gitItem() SelfCheckItem {
	out, ok := probeVersionString(git.GitVersionOutput)
	if !ok {
		return SelfCheckItem{
			Item:   "git",
			Status: "fail",
			Detail: "git not found or probe timed out (2s)",
			Hint:   "install git (https://git-scm.com/downloads) and restart the service",
		}
	}
	return SelfCheckItem{Item: "git", Status: "ok", Detail: out}
}

// lfsItem git-lfs：可选能力（仅 LFS 仓库需要），缺失降级 warn 不算失败
func lfsItem() SelfCheckItem {
	out, ok := probeVersionString(git.LfsVersionOutput)
	if !ok {
		return SelfCheckItem{
			Item:   "lfs",
			Status: "warn",
			Detail: "git-lfs not detected (optional — only needed for LFS repositories)",
			Hint:   "install git-lfs (https://git-lfs.com) then run: git lfs install",
		}
	}
	return SelfCheckItem{Item: "lfs", Status: "ok", Detail: out}
}

// tmuxItem tmux 可用性（持久终端会话承载）：仅 Unix 适用——Windows 走 native
// PTY 后端，条目恒 ok 并如实注记；Unix 缺失/版本过旧 = warn（native 后端仍可
// 用，失去的是持久化与重启恢复）
func tmuxItem() SelfCheckItem {
	info := terminal.GetTmuxInfo()
	if runtime.GOOS == "windows" {
		return SelfCheckItem{
			Item:   "tmux",
			Status: "ok",
			Detail: "not applicable on windows (terminal uses the native PTY backend)",
		}
	}
	if info.Available {
		return SelfCheckItem{Item: "tmux", Status: "ok", Detail: fmt.Sprintf("%s at %s", info.Version, info.Path)}
	}
	detail := fmt.Sprintf("not available (required %s)", info.Required)
	hint := fmt.Sprintf("install tmux %s for persistent terminal sessions (native backend still works without it)", info.Required)
	if info.InstallCommand != "" {
		hint += ": " + info.InstallCommand
	}
	return SelfCheckItem{Item: "tmux", Status: "warn", Detail: detail, Hint: hint}
}

// agentRuntimesItem agent 运行时清单聚合：任一可用 = ok；全部缺失 = warn
// （agent 会话起不来但纯 shell 终端不受影响）。明细逐运行时列版本/缺失，
// 与 GET /api/agent-runtimes 同源（RuntimeInventory 唯一聚合点）
func agentRuntimesItem() SelfCheckItem {
	rows := terminalapi.RuntimeInventory()
	parts := make([]string, 0, len(rows))
	available := 0
	for _, r := range rows {
		if r.Available {
			available++
			if r.Version != "" {
				parts = append(parts, r.Name+" "+r.Version)
			} else {
				parts = append(parts, r.Name+" ok")
			}
			continue
		}
		parts = append(parts, r.Name+" missing")
	}
	detail := "no agent runtime registered"
	if len(parts) > 0 {
		detail = strings.Join(parts, ", ")
	}
	if available > 0 {
		return SelfCheckItem{Item: "agent-runtimes", Status: "ok",
			Detail: fmt.Sprintf("%d/%d available: %s", available, len(rows), detail)}
	}
	return SelfCheckItem{
		Item:   "agent-runtimes",
		Status: "warn",
		Detail: detail,
		Hint:   "install any agent runtime (claude/codex/dsh) or register a custom agent in Settings → Agent; shell terminals work without one",
	}
}

// portsItem 已登记 dev 端口（P-293 注册表，内存态）：信息性条目恒 ok——
// 登记面=探测/上报面，未登记不等于无监听（措辞对齐端口注册表诚实边界）
func portsItem() SelfCheckItem {
	entries := terminal.DefaultManager.ListDevPorts()
	if len(entries) == 0 {
		return SelfCheckItem{Item: "ports", Status: "ok", Detail: "no dev ports registered (registry = detected/reported only)"}
	}
	// 明细截前 8 条防超长注册表把体检单撑爆（上限 1024 条的极端场景），
	// 其余以计数注记——完整清单走 GET /api/terminals/ports
	const maxList = 8
	parts := make([]string, 0, maxList)
	for i, e := range entries {
		if i >= maxList {
			break
		}
		if e.Label != "" {
			parts = append(parts, fmt.Sprintf(":%d(%s)", e.Port, e.Label))
		} else {
			parts = append(parts, fmt.Sprintf(":%d", e.Port))
		}
	}
	detail := strings.Join(parts, " ")
	if len(entries) > maxList {
		detail += fmt.Sprintf(" +%d more", len(entries)-maxList)
	}
	return SelfCheckItem{Item: "ports", Status: "ok", Detail: detail}
}

// diskItem 数据盘水位（P-12 既有 diskVolumes 同源，ok/warn/crit 映射三态）：
// 数据卷不可观测 = fail（数据面落盘能力存疑）
func diskItem() SelfCheckItem {
	for _, v := range diskVolumes() {
		if v.Role != diskRoleData {
			continue
		}
		free := humanMB(v.TotalMB - v.UsedMB)
		detail := fmt.Sprintf("%s free / %s total (%.1f%% used) at %s", free, humanMB(v.TotalMB), v.UsedPercent, v.Path)
		switch v.Level {
		case "crit":
			return SelfCheckItem{
				Item:   "disk",
				Status: "fail",
				Detail: detail,
				Hint:   "free disk space urgently — data writes may fail (clean ~/.codecombo/artifacts, recordings, project node_modules)",
			}
		case "warn":
			return SelfCheckItem{
				Item:   "disk",
				Status: "warn",
				Detail: detail,
				Hint:   "disk usage above 80% — plan cleanup (recordings / artifacts / build caches)",
			}
		default:
			return SelfCheckItem{Item: "disk", Status: "ok", Detail: detail}
		}
	}
	return SelfCheckItem{
		Item:   "disk",
		Status: "fail",
		Detail: "data dir not readable: " + config.DataDir(),
		Hint:   "check disk mount / SC_DATA_DIR — data persistence is at risk",
	}
}

// configItem 配置文件完整性（P-20261006-10）：agent 自检可编程探测配置降级态
// 的原语——Load 期登记的损坏降级态在此显影。正常 = ok + 配置路径；损坏降级 =
// warn + 解析错误与坏文件所在 + 修复指引（保全成功/失败两分支文案如实区分，
// 与通知中心同源 config.CorruptionReport，探测面与告知面不打架）
func configItem() SelfCheckItem {
	if rep := config.CorruptionReport(); rep != nil {
		if rep.Preserved() {
			return SelfCheckItem{
				Item:   "config",
				Status: "warn",
				Detail: fmt.Sprintf("config.json corrupt at startup, defaults in effect — parse error: %s; bad file preserved at %s", rep.Err, rep.PreservedPath),
				Hint:   "merge/restore the preserved file back into config.json, then restart the service",
			}
		}
		return SelfCheckItem{
			Item:   "config",
			Status: "warn",
			Detail: fmt.Sprintf("config.json corrupt at startup, defaults in effect — parse error: %s; preservation failed, bad file still at %s", rep.Err, rep.Path),
			Hint:   "fix or remove the corrupt config.json (check directory permissions), then restart the service",
		}
	}
	return SelfCheckItem{
		Item:   "config",
		Status: "ok",
		Detail: "config.json loaded at " + filepath.Join(config.DataDir(), "config.json"),
	}
}

// probeVersionString 带超时上限的版本探测：probe 报错或输出空 = 未探测到；
// 超时 = 探测不可达（与缺失同呈失败/警告面，detail 注明超时口径）。通道带
// 缓冲——超时放弃后探测 goroutine 仍可写入不阻塞，由底层 exec 超时自行回收
func probeVersionString(probe func() (string, error)) (string, bool) {
	ch := make(chan string, 1)
	go func() {
		out, err := probe()
		if err != nil {
			ch <- ""
			return
		}
		ch <- strings.TrimSpace(out)
	}()
	select {
	case v := <-ch:
		return v, v != ""
	case <-time.After(selfCheckProbeTimeout):
		return "", false
	}
}
