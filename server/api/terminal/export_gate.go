package terminal

import (
	"log/slog"
	"net/http"
	"os"

	shared "codecombo/server/api/shared"
	"codecombo/server/claudesessions"
	"codecombo/server/sensitive"

	"github.com/gin-gonic/gin"
)

// 导出族内容敏感闸（P-20261004-113）：会话 md / 会话 jsonl / 终端 txt 三面
// 共用。设计语义与 P-20261004-97 补丁导出闸、P-20261003-155 会话标记闸同族：
//   - 命中且未确认 → 200 JSON {warnings, sensitiveHits}，不出附件（响应形态
//     差异即协商通道：Content-Type 分流，agent 侧可编程感知）；
//   - confirm=1 → 真出域，内容原样保真（不遮蔽、不截断——警示是知情过闸，
//     不是拦截）；
//   - 命中明细只含「类型 + 计数」，原文/值段绝不进响应，也绝不进审计。
//
// 为什么 content scan 的确认参数是 confirm=1 而不是 override=1：内容命中是
// 「这份内容可能带凭据」的实时判定（P-97 GET confirm=1 同词汇），override 是
// 人工敏感标记的既有放行参数（P-155）；两条闸并存时前端一次确认后同时携
// confirm=1&override=1，API 消费方按 warnings 里的 token 分别响应。

// exportSensitiveGate 对已算出的命中做闸门决策：未确认 → 写 JSON 警示并返回
// true（调用方立即 return）；放行返回 false。extraWarnings 是调用方已判定
// 成立的其他闸门 token（如 shared.SensitiveSessionWarning），与内容命中合并
// 成同一次确认——避免同一导出动作弹两层确认
func exportSensitiveGate(c *gin.Context, hits []sensitive.Hit, extraWarnings ...string) bool {
	warnings := append([]string(nil), extraWarnings...)
	if len(hits) > 0 && c.Query("confirm") != "1" {
		warnings = append(warnings, shared.SensitiveContentWarning)
	}
	if len(warnings) == 0 {
		return false
	}
	// 只记命中类型数（原文/值段不入日志——与审计同纪律）
	slog.Info("export gated by sensitive scan", "path", c.Request.URL.Path,
		"typeCount", len(hits))
	body := gin.H{"warnings": warnings}
	if len(hits) > 0 {
		body["sensitiveHits"] = hits
	}
	c.JSON(http.StatusOK, body)
	return true
}

// scanJSONLExport 对 transcript 文件做「相对化改写后」内容的敏感预扫：
// 扫描发生在改写链下游（P-20261003-113 的相对化剥掉主机路径前缀后再判定，
// 扫的就是最终出域字节，见 claudesessions.ScanRelativizedJSONL）。整文件
// 预扫一趟是闸门判定必须先于响应头的代价（JSON warnings 与附件不能同响应），
// 确认后调用方回绕句柄再走拷贝链——只读扫描不影响出域字节。逐行汇总，
// 内存 = 单行驻留（与拷贝链同界）
func scanJSONLExport(f *os.File, root string) ([]sensitive.Hit, error) {
	var counter sensitive.Counter
	err := claudesessions.ScanRelativizedJSONL(f, root, func(line []byte) {
		counter.AddText(string(line))
	})
	if err != nil {
		return nil, err
	}
	return counter.Hits(), nil
}

// sensitiveAuditSuffix 放行路径的审计 Detail 后缀：只追加命中类型与计数
// （如 " sensitive:known-token×2"），内容/原文绝不入账；无命中时为空串——
// 既有事件的 Detail 逐字节不变（存量 spec 的精确断言零回归）
func sensitiveAuditSuffix(hits []sensitive.Hit) string {
	if len(hits) == 0 {
		return ""
	}
	return " sensitive:" + sensitive.Summary(hits)
}
