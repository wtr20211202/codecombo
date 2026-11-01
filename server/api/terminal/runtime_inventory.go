package terminal

import (
	"context"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"time"

	"codecombo/server/agentops"
	"codecombo/server/store"
	"codecombo/server/userbin"

	"github.com/gin-gonic/gin"
)

// 运行时清单与版本探测（P-20261007-22 纯搬运自 terminal.go，零逻辑改动）：
// ListAgentRuntimes 响应面与 RuntimeInventory 聚合点，60s 版本探测缓存

// runtimeVersionCache 版本探测缓存（60s）：--version 子进程代价不低，
// 设置页/对话框频繁刷新时免重复起进程
var runtimeVersionCache = struct {
	sync.Mutex
	m map[string]versionEntry
}{m: map[string]versionEntry{}}

type versionEntry struct {
	version   string
	fetchedAt time.Time
}

// probeRuntimeVersion 探测运行时版本（exec <首词> --version，3s 兜底；失败返回空）。
// 缓存 60s——版本变更属低频事件。命令行可带参数（自定义智能体如
// `aider --model x`），整体串无法作为可执行文件，约定取首词；经 userbin
// 解析（禁止裸 PATH exec）：守护进程 PATH 不含用户级工具链，探测不到与
// Available 口径一致。锁只护缓存读写、不罩 exec——子进程最坏 3s，全程
// 持锁会把并发请求的探测叠队串行化
func probeRuntimeVersion(command string) string {
	if command == "" {
		return ""
	}
	runtimeVersionCache.Lock()
	if e, ok := runtimeVersionCache.m[command]; ok && time.Since(e.fetchedAt) < time.Minute {
		runtimeVersionCache.Unlock()
		return e.version
	}
	runtimeVersionCache.Unlock()
	bin := userbin.ResolveBinPath(command)
	var version string
	if bin != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, bin, "--version").Output()
		if err == nil {
			version = strings.TrimSpace(string(out))
			if len(version) > 120 {
				version = version[:120]
			}
		}
	}
	runtimeVersionCache.Lock()
	runtimeVersionCache.m[command] = versionEntry{version, time.Now()}
	runtimeVersionCache.Unlock()
	return version
}

// resetRuntimeVersionCache 清空版本探测缓存：设置页「运行时检测」手动刷新
// 通道（refresh=1）用——缓存失败结论（含「装了但探测失败」）存 60s，手动
// 检测必须如实重探而非回放缓存
func resetRuntimeVersionCache() {
	runtimeVersionCache.Lock()
	runtimeVersionCache.m = map[string]versionEntry{}
	runtimeVersionCache.Unlock()
}

// RuntimeRow 运行时清单行（ListAgentRuntimes 响应体形态，环境体检
// P-20261003-317 聚合同源消费）：displayName 为自定义智能体的展示名
// （内置运行时为空，前端回落 name）；customCommand 为设置里按运行时保存的
// 自定义启动命令（空 = 用默认）
type RuntimeRow struct {
	Name           string `json:"name"`
	DisplayName    string `json:"displayName"`
	Available      bool   `json:"available"`
	Version        string `json:"version"`
	DefaultCommand string `json:"defaultCommand"`
	CustomCommand  string `json:"customCommand"`
}

// RuntimeInventory 运行时清单（注册序），版本并发探测——ListAgentRuntimes
// 响应体与环境体检「agent 运行时」条目共用的唯一聚合点
func RuntimeInventory() []RuntimeRow {
	runtimes := agentops.Runtimes()
	cfg := store.Get().Settings.Get()
	items := make([]RuntimeRow, len(runtimes))
	// 并发探测：版本探测是起子进程（单次最坏 3s），逐个串行的总耗时随运行时
	// 数量线性涨（冷缓存首开设置页「正在检测本机运行时…」久挂）；并发后总耗时
	// = 最慢一个。items 按下标写入互不干扰，顺序保持注册序
	var wg sync.WaitGroup
	for i, rt := range runtimes {
		wg.Add(1)
		go func(i int, rt agentops.RuntimeInfo) {
			defer wg.Done()
			custom := ""
			displayName := ""
			if cfg != nil {
				if cfg.Server.AgentLaunchCommands != nil {
					custom = cfg.Server.AgentLaunchCommands[rt.Name]
				}
				if a := cfg.Server.FindCustomAgent(rt.Name); a != nil {
					displayName = a.DisplayName
				}
			}
			items[i] = RuntimeRow{
				Name:           rt.Name,
				DisplayName:    displayName,
				Available:      rt.Available,
				Version:        probeRuntimeVersion(rt.DefaultCommand),
				DefaultCommand: rt.DefaultCommand,
				CustomCommand:  custom,
			}
		}(i, rt)
	}
	wg.Wait()
	return items
}

// ListAgentRuntimes GET /api/agent-runtimes：运行时选项清单（会话创建对话框与
// 设置页运行时状态区用）——注册顺序返回 {name, displayName, available,
// version, defaultCommand, customCommand}。refresh=1：手动「运行时检测」——
// 先失效两层探测缓存（userbin 解析 + 版本探测 60s），刚安装/卸载/修复的运行时
// 即刻如实呈现，不等 TTL
func ListAgentRuntimes(c *gin.Context) {
	if c.Query("refresh") == "1" {
		userbin.ResetCache()
		resetRuntimeVersionCache()
	}
	c.JSON(http.StatusOK, gin.H{"data": RuntimeInventory()})
}
