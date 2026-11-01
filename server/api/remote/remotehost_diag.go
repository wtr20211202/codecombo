package remote

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/sshclient"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// diagCommand 一条只读诊断命令
type diagCommand struct {
	Key      string `json:"key"`      // 结果字段名
	Label    string `json:"label"`    // 展示名（i18n 由前端处理，这里给英文标签）
	Cmd      string `json:"cmd"`      // 只读命令；命令不存在时容忍失败
	Optional bool   `json:"optional"` // Optional=true 时退出码非 0 不算诊断失败
}

// diagCommands 诊断命令集（全部只读，不改主机任何状态）
var diagCommands = []diagCommand{
	{Key: "system", Label: "System", Cmd: "uname -a && cat /etc/os-release 2>/dev/null | head -2", Optional: true},
	{Key: "uptime", Label: "Uptime / Load", Cmd: "uptime", Optional: true},
	{Key: "cpu", Label: "CPU", Cmd: "nproc && top -bn1 | head -5", Optional: true},
	{Key: "memory", Label: "Memory", Cmd: "free -m", Optional: true},
	{Key: "disk", Label: "Disk", Cmd: "df -h -x tmpfs -x devtmpfs", Optional: true},
	{Key: "topProcesses", Label: "Top processes by memory", Cmd: "ps aux --sort=-%mem | head -8", Optional: true},
	{Key: "ports", Label: "Listening ports", Cmd: "ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null", Optional: true},
	{Key: "failedServices", Label: "Failed services", Cmd: "systemctl --failed --no-legend --no-pager 2>/dev/null || true", Optional: true},
	{Key: "recentLogs", Label: "Recent system errors", Cmd: "journalctl -p err -n 20 --no-pager 2>/dev/null || true", Optional: true},
}

// diagItem 单项诊断结果
type diagItem struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Output   string `json:"output"`
	ExitCode int    `json:"exitCode"`
	Error    string `json:"error,omitempty"`
}

// diagCompare 与上一次快照的对比（服务端内联下发，前端免二次请求）。
// Prev 为上一次摘要本体（前端以字段零值哨兵决定隐藏未采集指标），
// Delta 为三指标差值（store.DiffDiagSnapshot）
type diagCompare struct {
	Prev  store.DiagSnapshot `json:"prev"`
	Delta store.DiagDelta    `json:"delta"`
}

// diagnoseResp 诊断响应
type diagnoseResp struct {
	OK       bool         `json:"ok"`
	Duration int64        `json:"durationMs"` // 总耗时（毫秒）
	Items    []diagItem   `json:"items"`
	Error    string       `json:"error,omitempty"`
	Compare  *diagCompare `json:"compare,omitempty"` // 与上次诊断对比（首次诊断无历史时缺省）
}

// diagHostTimeout 单主机整组命令的软上限：9 条只读命令在正常主机上秒级完成，
// 60s 覆盖慢网/高负载主机（批量扇出 diagnose-batch 复用同一上限）
const diagHostTimeout = 60 * time.Second

// DiagnoseRemoteHost 远程主机一键诊断：SSH 执行一组只读命令聚合状态快照
func DiagnoseRemoteHost(c *gin.Context) {
	id := c.Param("id")
	rh, err := store.Get().RemoteHost.Get(id)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "remote host not found", err)
		return
	}
	if rh.IsFTP() {
		c.JSON(http.StatusOK, diagnoseResp{Error: "FTP host does not support SSH diagnose (files only)"})
		return
	}
	if err := ResolveRemoteHostAuth(rh); err != nil {
		c.JSON(http.StatusOK, diagnoseResp{Error: err.Error()})
		return
	}

	resp := runHostDiagnosis(c.Request.Context(), rh)

	// P-20261002-18：提取关键数值落诊断历史（host 一文档环形保留 20 条），
	// 并把与上一次快照的对比内联进响应。两步均尽力而为——提取不到/写失败
	// 只损失趋势能力，绝不阻断诊断响应本体；连接失败（resp.Error）不是
	// 指标快照，不落历史
	if resp.Error == "" {
		if snap, ok := extractDiagSnapshot(resp); ok {
			if prev, hasPrev := store.Get().DiagHist.Latest(id); hasPrev {
				resp.Compare = &diagCompare{Prev: prev, Delta: store.DiffDiagSnapshot(prev, snap)}
			}
			store.Get().DiagHist.Append(id, snap)
		}
	}
	c.JSON(http.StatusOK, resp)
}

// runHostDiagnosis 拨号并执行完整只读命令集，返回报告体（单主机诊断与批量
// 扇出 diagnose-batch 共用的核心段）。拨号失败时 Error 非空且无 Items；
// FTP 拦截与凭据解析（ResolveRemoteHostAuth）由调用方先行——两者在单主机
// 与批量两条链路上的响应形态不同。命令循环逐项容错：Optional 命令失败不算
// 诊断失败，任何单项都不中断其余项
func runHostDiagnosis(ctx context.Context, rh *config.RemoteHost) diagnoseResp {
	start := time.Now()
	ctx, cancel := context.WithTimeout(ctx, diagHostTimeout)
	defer cancel()

	// 连接从 per-host 池借出（P-20261005-159：免每请求握手）。整组命令在
	// WithLease 闭包内跑：连接级首错（非调用方超时）由池弃置重建重试一次，
	// 整组只读幂等重跑安全——闭包开头重置 resp，重试响应从头计
	var resp diagnoseResp
	err := conns.WithLease(rh.ID, dialOptions(rh), func(client *sshclient.Client) error {
		resp = diagnoseResp{OK: true, Items: make([]diagItem, 0, len(diagCommands))}
		for _, d := range diagCommands {
			item := diagItem{Key: d.Key, Label: d.Label}
			out, err := client.Exec(ctx, sshclient.ExecOptions{Cmd: d.Cmd}, nil)
			switch {
			case err != nil && out == nil && ctx.Err() == nil:
				// 连接/会话层失败：交池重建重试
				return err
			case err != nil && !d.Optional:
				item.Error = err.Error()
				resp.OK = false
			case out != nil:
				item.ExitCode = out.ExitCode
				item.Output = strings.Join(out.Stdout, "\n")
				if out.ExitCode != 0 {
					stderr := strings.Join(out.Stderr, "\n")
					item.Error = fmt.Sprintf("exit %d: %s", out.ExitCode, truncateStr(stderr, 200))
				}
			case err != nil:
				item.Error = err.Error()
			}
			resp.Items = append(resp.Items, item)
		}
		return nil
	})
	if err != nil {
		// 重建重试后仍失败：调用方按既有连接失败形态收口（Error 非空且无 Items）
		return diagnoseResp{Error: err.Error()}
	}
	resp.Duration = time.Since(start).Milliseconds()
	return resp
}

// DiagnoseText 把诊断结果序列化为给 AI 分析的纯文本
func DiagnoseText(hostName string, resp diagnoseResp) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "Remote host: %s\n", hostName)
	if resp.Error != "" {
		fmt.Fprintf(&sb, "Connection error: %s\n", resp.Error)
		return sb.String()
	}
	for _, item := range resp.Items {
		fmt.Fprintf(&sb, "\n## %s\n", item.Label)
		if item.Error != "" {
			fmt.Fprintf(&sb, "(error: %s)\n", item.Error)
		}
		if item.Output != "" {
			sb.WriteString(item.Output)
			sb.WriteString("\n")
		}
	}
	return sb.String()
}

func truncateStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
