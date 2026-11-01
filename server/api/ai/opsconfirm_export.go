package ai

import (
	"bytes"
	"encoding/csv"
	"net/http"
	"sort"
	"strconv"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/middleware"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 审批裁决历史 CSV 导出（P-20261003-247）：GET /api/ops-confirm/export 把
// AgentApproval 全量转 CSV 附件下载（裁决留档/合规回顾）。审计日志 CSV 导出
// 同模式（P-20261003-66，server/api/system/audit.go）：encoding/csv RFC 4180
// 转义 + UTF-8 BOM（Excel 无 BOM 按 ANSI 误读非 ASCII）+ 表头语言中立小写 +
// 公式注入防护（shared.SanitizeCSVCell，=+/-@ 开头单元格单引号前缀）+
// 下载头 shared.ContentDispositionFile（P-109 导出族统一净化）+ 数据出域同路
// 入账（approval.export，CSV 构建之后——导出动作不进本次文件）。鉴权同 List
// 面（全局 api 组 LockMiddleware + TokenAuthMiddleware 同域，router.go 相邻注册）。
//
// 量级注记：AgentApproval.List("", 0) 无分页一次取全，无须审计导出的分页循环
//（List 单页钳制 500 才需要循环）；集合天然有界——审批记录 30 天保留档
//（agentApprovalRetention，ai 模块每日清账）+ 人/agent 操作级写入频率，
// 与审计导出窗口同量级，不存在无界内存面。

// ExportAgentApprovals GET /api/ops-confirm/export
// 列：op,target,result,agent,createdAt,resolvedAt,detail,reason——前五列对齐
// 提案清单（op/目标/结果/发起方/时间）与「最近裁决」回看面（P-226）同字段；
// 时间落为发起+裁决双刻度（裁决留档关心「何时发起→何时裁决」的间隔，pending
// 行 resolvedAt 空串）；detail/reason 沿审计 CSV 的 detail 列惯例携带上下文。
// 全部为 List 端点既有字段（入库前已过 P-197 遮蔽），导出面 == List 面，
// 无新增出域字段
func ExportAgentApprovals(c *gin.Context) {
	list, err := store.Get().AgentApproval.List("", 0) // 不传过滤=全量（P-20261003-254 签名演进适配）
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "ops confirm export failed", err)
		return
	}
	// 新→旧排序（裁决时刻优先、发起时刻兜底）：与「最近裁决」面板及审计 CSV
	// 的倒序时间线同读向；List 底层序是文档序不稳定，显式排序让文件确定可 diff
	sort.Slice(list, func(i, j int) bool {
		return approvalResolvedTs(list[i]).After(approvalResolvedTs(list[j]))
	})

	var buf bytes.Buffer
	buf.WriteString("\xEF\xBB\xBF")
	w := csv.NewWriter(&buf)
	_ = w.Write([]string{"op", "target", "result", "agent", "createdAt", "resolvedAt", "detail", "reason"})
	for _, a := range list {
		_ = w.Write([]string{
			shared.SanitizeCSVCell(a.Op),
			shared.SanitizeCSVCell(a.Target),
			a.Status, // 服务端状态词汇原样（pending|allowed|denied），机器可比对
			a.Agent,
			formatApprovalCSVTime(a.CreatedAt),
			formatApprovalCSVTime(ptrTime(a.ResolvedAt)),
			shared.SanitizeCSVCell(a.Detail),
			shared.SanitizeCSVCell(a.Reason),
		})
	}
	w.Flush()
	if err := w.Error(); err != nil {
		shared.Error(c, http.StatusInternalServerError, "ops confirm export failed", err)
		return
	}

	// 数据出域同路入账（workspace/claude/audit 导出同族惯例）：CSV 构建完成后
	// 记账，导出动作自身不进本次文件；Detail 只记行数（语言中立元数据）
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditApprovalExport,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: "rows=" + strconv.Itoa(len(list)),
	})

	name := "simple-coding-approvals-" + time.Now().Format("2006-01-02") + ".csv"
	c.Header("Content-Type", "text/csv; charset=utf-8")
	// 导出族下载头必经统一净化 helper（P-109；本名虽是服务端常量，惯例不豁免）
	c.Header("Content-Disposition", shared.ContentDispositionFile(name))
	c.String(http.StatusOK, buf.String())
}

// approvalResolvedTs 排序时刻：resolvedAt 优先、createdAt 兜底（零值 = 尚未
// 裁决且缺发起时刻的病态记录沉底）
func approvalResolvedTs(a store.AgentApproval) time.Time {
	if a.ResolvedAt != nil {
		return *a.ResolvedAt
	}
	return a.CreatedAt
}

// ptrTime nil 指针 → 零值时刻（CSV 端统一由 formatApprovalCSVTime 出空串）
func ptrTime(t *time.Time) time.Time {
	if t == nil {
		return time.Time{}
	}
	return *t
}

// formatApprovalCSVTime RFC3339（审计 CSV 时间列同格式，表格软件与脚本可直读）；
// 零值出空串（pending 行无裁决时刻）
func formatApprovalCSVTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.Format(time.RFC3339)
}
