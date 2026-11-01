package terminal

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	shared "codecombo/server/api/shared"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// terminalHistoryCommandMax 单条命令文本上限（字节），与 shell 侧 E 帧 8KB 截断对齐
const terminalHistoryCommandMax = 8 * 1024

// terminalHistoryTerminalIDMax 归属会话 id 上限（字节）：会话 id 为服务端生成的
// tmux 名或 term-<unixnano> 形态（几十字节），128 已宽裕；超限静默截断而非 400
// ——归属是附加信息，不值得让 fire-and-forget 上报整条失败
const terminalHistoryTerminalIDMax = 128

// terminalHistoryHostMax 来源主机键上限（字节）：hostId 为服务端生成 id（几十
// 字节），与 terminalId 同档 128；超限静默截断同理
const terminalHistoryHostMax = 128

// RecordTerminalHistory POST /api/projects/:id/terminal-history
// 前端在 OSC 133 D 事件（命令结束）时 fire-and-forget 上报，敏感命令由 store 层静默跳过。
// terminalId 可选（P-20261004-35 会话归属）：前端上报点与会话自标识 CC_TERMINAL_ID
// 同源；缺省落「未归属」组（旧调用方/旧条目零迁移兼容）。
// source/host 可选（P-20261005-188）：input=输入域「提交的输入行」（远程控制台
// 采集），host=远程主机键；source 白名单外取值一律回落 osc 精确域缺省（增量扩展
// 不开自由文本口子）
func RecordTerminalHistory(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Command    string `json:"command"`
		ExitCode   int    `json:"exitCode"`
		DurationMs int64  `json:"durationMs"`
		TerminalID string `json:"terminalId"`
		Source     string `json:"source"`
		Host       string `json:"host"`
	}
	if !shared.BindJSON(c, &req, shared.CodeTerminalPayloadInvalid) {
		return
	}
	command := strings.TrimSpace(req.Command)
	if command == "" || len(command) > terminalHistoryCommandMax {
		shared.Error(c, http.StatusBadRequest, "Terminal history operation failed",
			fmt.Errorf("command length out of range (1-%d bytes)", terminalHistoryCommandMax))
		return
	}
	terminalID := strings.TrimSpace(req.TerminalID)
	if len(terminalID) > terminalHistoryTerminalIDMax {
		terminalID = terminalID[:terminalHistoryTerminalIDMax]
	}
	source := strings.TrimSpace(req.Source)
	host := strings.TrimSpace(req.Host)
	if source != store.HistorySourceInput {
		// 白名单外回落 osc 缺省（旧调用方零感知）；host 连带清空——主机键只在
		// 输入域语义下成立，避免 osc 条目带主机徽标的语义混搭
		source = ""
		host = ""
	}
	if len(host) > terminalHistoryHostMax {
		host = host[:terminalHistoryHostMax]
	}

	// 设置总开关：关闭时静默丢弃（返回 200，fire-and-forget 调用方无需感知差异）
	if !store.Get().Settings.Get().Server.TerminalHistoryEnabledOrDefault() {
		c.JSON(http.StatusOK, gin.H{"message": "terminal history disabled"})
		return
	}

	if err := store.Get().TerminalHistory.Append(p.ID, store.HistoryEntry{
		Command:    command,
		ExitCode:   req.ExitCode,
		DurationMs: req.DurationMs,
		At:         time.Now(),
		TerminalID: terminalID,
		Source:     source,
		Host:       host,
	}); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Terminal history operation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "recorded"})
}

// ListTerminalHistory GET /api/projects/:id/terminal-history?q=&failedOnly=&terminalId=
// 返回倒序列表（最新在前）；q 为命令文本包含匹配，failedOnly=true 仅失败命令，
// terminalId 非空时仅返回该会话条目（空 = 全部，含「未归属」旧条目）
func ListTerminalHistory(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	q := strings.TrimSpace(c.Query("q"))
	failedOnly := c.Query("failedOnly") == "true" || c.Query("failedOnly") == "1"
	terminalID := strings.TrimSpace(c.Query("terminalId"))
	entries, err := store.Get().TerminalHistory.Search(p.ID, q, failedOnly, terminalID)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Terminal history operation failed", err)
		return
	}
	if entries == nil {
		entries = []store.HistoryEntry{}
	}
	c.JSON(http.StatusOK, gin.H{"data": entries})
}

// ClearTerminalHistory DELETE /api/projects/:id/terminal-history（清空项目历史）
func ClearTerminalHistory(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	if err := store.Get().TerminalHistory.Clear(p.ID); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Terminal history operation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "cleared"})
}

// DeleteTerminalHistoryEntry DELETE /api/projects/:id/terminal-history/:idx
// 两种形态：带 ?at=<RFC3339Nano> 时按条目时间戳身份删除（面板条目删除用——
// GET 快照与删除之间并发 Append/过滤位移会让下标漂移，时间戳是稳定身份，
// P-20261003-63）；否则按倒序下标 idx（与 GET 返回顺序一致，存量契约保留）。
// at 占位段用 entry（路径段必须有值才能命中 :idx 路由，语义自明优于符号占位）
func DeleteTerminalHistoryEntry(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	if atRaw := strings.TrimSpace(c.Query("at")); atRaw != "" {
		at, err := time.Parse(time.RFC3339Nano, atRaw)
		if err != nil {
			shared.Error(c, http.StatusBadRequest, "invalid at timestamp", nil)
			return
		}
		if err := store.Get().TerminalHistory.DeleteEntryAt(p.ID, at); err != nil {
			if err == store.ErrNotFound {
				shared.Error(c, http.StatusNotFound, "entry not found", nil)
				return
			}
			shared.Error(c, http.StatusInternalServerError, "Terminal history operation failed", err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"message": "deleted"})
		return
	}

	idx, err := strconv.Atoi(c.Param("idx"))
	if err != nil || idx < 0 {
		shared.Error(c, http.StatusBadRequest, "invalid index", nil)
		return
	}
	if err := store.Get().TerminalHistory.DeleteEntry(p.ID, idx); err != nil {
		if err == store.ErrNotFound {
			shared.Error(c, http.StatusNotFound, "entry not found", nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "Terminal history operation failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "deleted"})
}

// ── 跨项目聚合检索（P-20261004-2）──

// terminalHistorySearchMinRunes 查询词下限（rune 计，CJK 单字查询不被误伤）：
// 更短的宽泛词会扫全部项目历史（每项目上限 500 条 × N 项目），噪声大收益低
const terminalHistorySearchMinRunes = 2

// terminalHistorySearchHit 全局检索响应单条：store 命中 + 项目名（handler 补齐，
// store 不反向依赖项目仓储）。Source/Host 透传（P-20261005-188）：输入域命中带
// 主机键供前端主机徽标渲染，空值 = 本地 osc 条目（旧调用方可选消费零破坏）
type terminalHistorySearchHit struct {
	ProjectID   string    `json:"projectId"`
	ProjectName string    `json:"projectName"`
	Command     string    `json:"command"`
	ExitCode    int       `json:"exitCode"`
	At          time.Time `json:"ts"`
	Source      string    `json:"source,omitempty"`
	Host        string    `json:"host,omitempty"`
}

// SearchTerminalHistoryGlobal GET /api/terminal-history/search?q=&limit=
// 服务端聚合全部项目的命令历史：command 子串不区分大小写，全局时间倒序，
// 返回 [{projectId,projectName,command,exitCode,ts}]（失败命令带退出码，
// 「上次哪条命令失败了」顺带排障溯源）。独立路径不挂 /projects/:id 下——
// 与 /api/ahead-behind、/api/search/projects 同款规避 :id 通配符冲突。
// 存活项目名单过滤已删项目的孤儿历史文档（DeleteProject 未级联清理，遗留现状；
// 级联清理属项目删除域，超出本提案边界）
func SearchTerminalHistoryGlobal(c *gin.Context) {
	q := strings.TrimSpace(c.Query("q"))
	if utf8.RuneCountInString(q) < terminalHistorySearchMinRunes {
		shared.Error(c, http.StatusBadRequest, "query too short",
			fmt.Errorf("q must be at least %d characters", terminalHistorySearchMinRunes))
		return
	}
	limit := 0
	if n, err := strconv.Atoi(c.Query("limit")); err == nil && n > 0 {
		limit = n
	}
	liveName := map[string]string{}
	liveIDs := map[string]struct{}{}
	if projects, listErr := store.Get().Project.List(); listErr == nil {
		for _, p := range projects {
			liveName[p.ID] = p.Name
			liveIDs[p.ID] = struct{}{}
		}
	}
	// 存活项目集下沉 store：过滤先于 limit 截断——孤儿文档（已删项目遗留）
	// 不挤占返回名额，limit 语义保持「返回条数」
	hits, err := store.Get().TerminalHistory.SearchAll(q, limit, liveIDs)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Terminal history operation failed", err)
		return
	}
	out := make([]terminalHistorySearchHit, 0, len(hits))
	for _, h := range hits {
		name := liveName[h.ProjectID]
		if name == "" {
			name = h.ProjectID // 防御兜底：理论不可达（store 已按 liveIDs 过滤）
		}
		out = append(out, terminalHistorySearchHit{
			ProjectID:   h.ProjectID,
			ProjectName: name,
			Command:     h.Command,
			ExitCode:    h.ExitCode,
			At:          h.At,
			Source:      h.Source,
			Host:        h.Host,
		})
	}
	c.JSON(http.StatusOK, gin.H{"data": out})
}
