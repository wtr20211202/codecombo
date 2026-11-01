package remote

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 批量诊断与横向对比（P-20261004-58）：诊断体系已厚（单主机一键 + 趋势 + 自检）
// 但多主机形态缺批量与横向——N 台巡检逐台点效率低，运维价值恰在横向对比
// （谁的磁盘将满、哪台负载异常）。本端点把单主机只读命令集并行扇出到多台，
// 逐台汇总结构化数值摘要（DiagSnapshot 同源提取），供前端横向对比表与
// 巡检报告 markdown 消费。
//
// 语义与单主机诊断一致：FTP/凭据/拨号失败是该台的结构化降级（HTTP 恒 200，
// 错误进该台 Error 字段），不拖垮整体；采集成功的主机照常落诊断历史
// （车道 1 diaghist 环形 20 条，趋势窗口跨单机/批量入口连续）。

// diagBatchMaxHosts 单次批量诊断的主机数上限：巡检是人工触发的低频操作，
// 50 台覆盖真实机队量级；上限同时约束扇出耗时（并发 4 时最坏 ~13 轮拨号）
// 与响应体规模，与 claude 会话批量导出 / 批量归档的 1..50 批量惯例同值
const diagBatchMaxHosts = 50

// diagBatchConcurrency 并发扇出的同时拨号上限：与主机在线探测同一量级理由
// （statusProbeConcurrency）——大量离线主机不至于瞬间打满 fd，也避免对同一
// 网段的 sshd 同时发起过多认证（fail2ban 友好）。每台占一条 SSH 连接，
// 4 并发下 9 条快命令的实际墙钟主要受慢主机拖尾而非并发不足
const diagBatchConcurrency = 4

// diagBatchResult 单台主机的批量诊断结果：只带结构化摘要、不带全文命令输出——
// 全文报告是单主机诊断弹窗的职责，横向对比只需要数值面（响应体从 N×9 段
// 文本收敛为 N×8 个数值，50 台量级下仍是 KB 级）
type diagBatchResult struct {
	HostID     string `json:"hostId"`
	Name       string `json:"name"`
	OK         bool   `json:"ok"`
	DurationMs int64  `json:"durationMs"`
	// Error 该台的结构化降级原因（未找到/FTP/凭据/拨号）；空 = 命令集已执行
	Error string `json:"error,omitempty"`
	// Snapshot 提取自命令输出的数值摘要（extractDiagSnapshot 同源）；
	// 缺省 = 全军覆没未采到（前端按「无数据」呈现，不当 0 展示）
	Snapshot *store.DiagSnapshot `json:"snapshot,omitempty"`
}

// diagBatchResp 批量诊断响应：results 与请求 ids 同序（并行完成序不稳定，
// 显式按请求位回填，前端表格渲染确定）
type diagBatchResp struct {
	Results    []diagBatchResult `json:"results"`
	DurationMs int64             `json:"durationMs"` // 整批墙钟耗时（并行扇出，远小于逐台串行累加）
}

// DiagnoseRemoteHostsBatch POST /api/remotehosts/diagnose-batch {"ids":[...]}
// 多主机并行扇出单主机只读命令集，逐台汇总结构化摘要。
// 请求校验：ids 必填（去重去空后 1..50，重复勾选只诊断一次）；超限 400 不静默
func DiagnoseRemoteHostsBatch(c *gin.Context) {
	var req struct {
		IDs []string `json:"ids" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "ids is required", err)
		return
	}
	// 上限先按请求原始条数判（去重前）：约束请求体规模本身，重复 id 刷量
	// 无法绕过；同时保证 ids 去重后仍可能为空 → 再走 400 分支
	if len(req.IDs) > diagBatchMaxHosts {
		shared.Error(c, http.StatusBadRequest,
			fmt.Sprintf("too many hosts (max %d per batch)", diagBatchMaxHosts), nil)
		return
	}
	// 去重保序：同一主机重复出现只诊断一次（结果条数 = 去重后主机数）
	ids := make([]string, 0, len(req.IDs))
	seen := make(map[string]struct{}, len(req.IDs))
	for _, id := range req.IDs {
		if id == "" {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		shared.Error(c, http.StatusBadRequest, "ids is required", nil)
		return
	}

	start := time.Now()
	results := make([]diagBatchResult, len(ids))
	sem := make(chan struct{}, diagBatchConcurrency)
	var wg sync.WaitGroup
	for i, id := range ids {
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			results[i] = diagnoseBatchOne(c.Request.Context(), id)
		}(i, id)
	}
	wg.Wait()

	c.JSON(http.StatusOK, gin.H{"data": diagBatchResp{
		Results:    results,
		DurationMs: time.Since(start).Milliseconds(),
	}})
}

// diagnoseBatchOne 批量扇出的单台工作单元：取主机 → 资质检查 → 跑命令集 →
// 提取摘要落历史。任何一步失败都收敛为该台的 Error 字段（结构化降级），
// 绝不 panic/阻塞其余主机；上下文随请求取消（客户端断开即整批停止拨号）
func diagnoseBatchOne(ctx context.Context, id string) diagBatchResult {
	res := diagBatchResult{HostID: id}
	rh, err := store.Get().RemoteHost.Get(id)
	if err != nil {
		res.Error = "host not found"
		return res
	}
	res.Name = rh.Name
	if rh.IsFTP() {
		res.Error = "FTP host does not support SSH diagnose (files only)"
		return res
	}
	if err := ResolveRemoteHostAuth(rh); err != nil {
		res.Error = err.Error()
		return res
	}
	resp := runHostDiagnosis(ctx, rh)
	res.DurationMs = resp.Duration
	if resp.Error != "" {
		res.Error = resp.Error
		return res
	}
	res.OK = resp.OK
	// 摘要提取与历史落盘尽力而为（单主机诊断同口径）：提取不到只损失该台的
	// 对比数值，不改写命令集执行成功的结论；部分项失败（resp.OK=false）时
	// 采到的指标照常入历史（与单主机诊断同一形态）
	if snap, ok := extractDiagSnapshot(resp); ok {
		res.Snapshot = &snap
		store.Get().DiagHist.Append(id, snap)
	}
	return res
}
