package terminal

import (
	"fmt"
	"net/http"
	"strings"

	"codecombo/server/api/shared"
	"codecombo/server/mask"
	"codecombo/server/middleware"
	"codecombo/server/remoteterminal"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// 广播输入护栏：data 单次上限 64KB（与前端大文本粘贴确认阈值同量级，超出
// 走粘贴链路不走广播）+ 请求体 128KB 封顶（LimitBody 在解析前置位生效）；
// ids 上限 = 本地+远程两会话上限之和（P-20261005-11 起目标含远程主机终端，
// 多出的必然 missing，早失败优于静默跳过）
const (
	broadcastMaxData = 64 * 1024
	broadcastMaxBody = 128 * 1024
)

// broadcastMaxIDs ids 数量上限：本地（terminal.MaxSessions()，P-20261006-12
// 起可配——启动期定值故请求时取实时值，不能包级常量预拼）+ 远程
// （remoteterminal.DefaultSessionLimit=20，NewModule 固定以此装配）两会话
// 硬上限之和——超过必然 missing，早失败优于静默跳过
func broadcastMaxIDs() int { return terminal.MaxSessions() + remoteterminal.DefaultSessionLimit }

// BroadcastFailedHost 广播写失败的远程目标回告项（P-20261005-11）：id 之外附
// 所属主机 id 与别名——「哪台失败一目了然」，agent 舰队巡检可按 hostId 定向
// 重开会话重试。仅远程 failed 目标携带（missing 无主机可标，本地 failed 无
// 主机概念），数组恒序列化为 []（前端解构安全，missing/failed 同款约定）
type BroadcastFailedHost struct {
	ID     string `json:"id"`
	HostID string `json:"hostId"`
	Host   string `json:"host"`
}

// broadcastWriteResponse 响应 data 段：BroadcastResult 平铺（written/missing/
// failed 契约与 P-288 逐字节一致，升级兼容只增不改）+ failedHosts 增量字段
type broadcastWriteResponse struct {
	terminal.BroadcastResult
	FailedHosts []BroadcastFailedHost `json:"failedHosts"`
}

// BroadcastWrite POST /api/terminals/broadcast-write {"ids":[...],"data":"..."}
// 多终端广播输入（舰队式批量输入，P-20261003-288）：把同一段输入逐个写入
// 多个终端会话（晨间例程类操作免逐个粘贴）。data 为原始 PTY 输入——
// 要执行命令须自带尾部换行（\r；前端广播条回车自动补，本端点不做补全），
// 缺失则停留在输入行不执行。响应 {"data":{written,missing,failed,failedHosts}}：
// missing 为不存在的会话 id（跳过回告），failed 为存在但写入失败的 id，
// failedHosts 为 failed 中远程目标的主机标注。
// 目标含本地与远程主机终端（P-20261005-11）：本地查无的 id 再查远程终端
// manager（远程会话 id 为 32 hex crypto/rand、本地为 term-* 前缀，不同源无
// 碰撞）——远程输入通道本就是服务端中继（WriteInput 直写 SSH stdin），广播
// 与单会话输入同一条中继，无新协议面；远程断连目标入 failed 并带主机标注，
// 不阻塞其余目标（逐会话跳过语义跨两端继承）。
// 安全面：向终端写入 = 任意命令执行（含远程主机——对面 shell 同样任意命令），
// agent 令牌调用经 AgentGuard 高危路由强制审批（middleware/agentguard.go
// guardedRoutes 同表登记，428+approvalId 先例）
func BroadcastWrite(c *gin.Context) {
	shared.LimitBody(c, broadcastMaxBody)
	var req struct {
		IDs  []string `json:"ids"`
		Data string   `json:"data"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		if shared.BodyTooLarge(err) {
			shared.ErrorWithCode(c, shared.CodeTerminalBodyTooLarge, "Broadcast request too large",
				fmt.Errorf("request body exceeds %d bytes", broadcastMaxBody))
			return
		}
		shared.ErrorWithCode(c, shared.CodeTerminalPayloadInvalid, "invalid request body", nil)
		return
	}
	if len(req.IDs) == 0 {
		shared.ErrorWithCode(c, shared.CodeTerminalIDsEmpty, "ids is required", nil)
		return
	}
	if len(req.IDs) > broadcastMaxIDs() {
		shared.ErrorWithCode(c, shared.CodeTerminalIDsTooMany, "too many ids", nil)
		return
	}
	if req.Data == "" {
		shared.ErrorWithCode(c, shared.CodeTerminalDataRequired, "data is required", nil)
		return
	}
	if len(req.Data) > broadcastMaxData {
		shared.ErrorWithCode(c, shared.CodeTerminalDataTooLarge, "data too large", nil)
		return
	}
	res, failedHosts := broadcastMixed(terminal.DefaultManager, req.IDs, []byte(req.Data))
	auditBroadcast(c, req.Data, res)
	c.JSON(http.StatusOK, gin.H{"data": broadcastWriteResponse{BroadcastResult: res, FailedHosts: failedHosts}})
}

// auditBroadcast 广播成功路径入账（P-20261005-234，terminal.broadcast）：
// 向终端写入 = 任意命令执行（BroadcastWrite 安全面注记），AgentGuard 高危审批
// 管事前、审计管事后——谁在何时对哪些会话批量写了什么（批次计数 + data 摘要）
// 得有底账，多会话批量执行的追溯才有凭据（运行书服务端执行 runbook.run 同族
// 写侧核对，P-108 已入账、本条补广播缺口）。只记元数据：data 摘要保守截断
// （summarizeInstruction 80 rune，queue.send 同款）并过 mask（指令是自由文本
// 可能带密钥原文，queue.send 同先例；P-203 Append 层脱敏是兜底，源头仍按
// 写入纪律收敛）。missing/failed 部分成功形态如实计数（targets = 去重后目标
// 数 = 三者之和）。审计旁路惯例：store 未装配（单测）静默跳过，Append 自身
// 尽力而为，入账失败不阻断广播主流程
func auditBroadcast(c *gin.Context, data string, res terminal.BroadcastResult) {
	if store.Get() == nil || store.Get().Audit == nil {
		return
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditTerminalBroadcast,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("targets=%d written=%d missing=%d failed=%d data=%s",
			res.Written+len(res.Missing)+len(res.Failed), res.Written, len(res.Missing), len(res.Failed),
			broadcastDataBrief(data)),
	})
}

// broadcastDataBrief 广播 data 摘要（审计 Detail 用）：data 是原始 PTY 输入——
// 与 queue.send「入库即折叠控制字符」不同，这里拿到的是未消毒原文（执行命令的
// 尾部 \r 是常态），先控制字符折叠为空格单行化（防审计面板/CSV/日志注入，
// share.uaBrief 同款），再 rune 截断保守收敛（80 rune 展示位取向，
// summarizeInstruction 同值同款）。脱敏双闸：源头过 mask.MaskApprovalText
// （已知密钥前缀/高熵长串，queue.send 同先例），P-203 Append 层
// MaskAuditDetail（赋值形态/裸云密钥）兜底——软关联非硬依赖
func broadcastDataBrief(data string) string {
	folded := strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, data)
	return mask.MaskApprovalText(summarizeInstruction(strings.TrimSpace(folded)))
}

// broadcastMixed 本地+远程混合目标的编排层：先本地全量广播，本地查无的 id
// 再交远程 manager 二段写入，结果合并回单一契约。顺序遍历两段，量级
// O(ids×len(data))，无热点。锁序：两个 manager 的 GetSession 各自 RLock 即取
// 即释，WriteInput 只持会话锁，跨 manager 无持锁跨接。
// local 由参数注入（handler 传 DefaultManager；单测传内存态 manager 直验
// 合并语义，不经 PTY 真起 shell）
func broadcastMixed(local *terminal.Manager, ids []string, data []byte) (terminal.BroadcastResult, []BroadcastFailedHost) {
	res := local.BroadcastWrite(ids, data)
	failedHosts := []BroadcastFailedHost{}
	rm := remoteterminal.GetManager()
	if rm == nil || len(res.Missing) == 0 {
		return res, failedHosts
	}
	rres := rm.BroadcastWrite(res.Missing, data)
	res.Written += rres.Written
	res.Failed = append(res.Failed, rres.Failed...)
	res.Missing = rres.Missing
	for _, id := range rres.Failed {
		s := rm.GetSession(id)
		if s == nil {
			// 写失败与回告之间会话被回收的极端竞态：目标仍在 failed 回告，
			// 主机标注退化缺省（不虚构）
			continue
		}
		failedHosts = append(failedHosts, BroadcastFailedHost{
			ID:     id,
			HostID: s.HostID,
			Host:   remoteHostDisplayName(s.HostID),
		})
	}
	return res, failedHosts
}

// remoteHostDisplayName 主机别名（设置页命名）。主机记录已删（删除级联关
// 会话的竞态窗口）或 store 未装配（单测）时回落 hostId——标注宁缺不虚构
func remoteHostDisplayName(hostID string) string {
	if st := store.Get(); st != nil {
		if rh, err := st.RemoteHost.Get(hostID); err == nil && rh.Name != "" {
			return rh.Name
		}
	}
	return hostID
}
