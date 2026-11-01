package system

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/errmarkers"
	"codecombo/server/middleware"
	"codecombo/server/notification"
	"codecombo/server/peercert"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 联邦会话派发（P-20261004-101）：中心实例握各从实例令牌（instance.go 探活
// 同源先例），把「在选定从实例上创建 agent 会话」从人工登对端界面变为一次
// 带 Bearer 的转发创建——活动矩阵「选机」数据面之后补上「派活」动作面，
// 与接续链（agentchain，P-20261004-38）组合即「自动选机→派发→完成接续」的
// 多机 agent 编排闭环（agent 派活原语，agent 令牌调用不设审批闸：本地
// POST /api/terminals 同为非高危面，语义对齐；对端自身照常执行其 AgentGuard）。
//
// 边界（诚实注记）：
//   - 派发是一次性转发创建，不维护跨实例会话镜像；后续可见性 = 矩阵粗粒度
//     + 点击跳转（实例切换链既有）
//   - 失败语义 = 对端原文透传：400 预检稳定标记（runtime not installed 等）
//     原样回传，前端 KNOWN_ERROR_I18N 跨实例同文案映射；中心不翻译不包装

// dispatchHTTPClient 派发专用客户端：TOFU 指纹校验与实例探活同信任域
// （peercert.TLSConfig，TLSVerifyPeer 切换强校验即时生效）；超时 20s——对端
// 创建 agent 会话含运行时预检子进程（--version 最坏 3s 量级）+ 目录校验，
// 探活的 5s 不够用；最坏两次尝试 40s，前端派发调用侧以 45s 请求超时给足
var dispatchHTTPClient = &http.Client{
	Timeout:   20 * time.Second,
	Transport: &http.Transport{TLSClientConfig: peercert.TLSConfig()},
}

// dispatchRespLimit 对端响应体读入上限：创建响应是几百字节级 JSON，
// 64KB 与探活同款封顶，防对端异常时无界读入
const dispatchRespLimit = 64 << 10

// DispatchSession POST /api/instances/:id/dispatch ——在从实例上创建 agent
// 会话。body 会话创建参数透传（name/runtime/dir/launchArgs，kind 恒 agent），
// 成功返回 {remoteSessionId, remoteSessionName, instanceId, instanceUrl,
// runtime, launched}；对端 4xx/5xx 原文透传（状态码 + error 字段），
// 网络层失败 502 稳定前缀 remote unreachable + 平台原生诊断原文。
func DispatchSession(c *gin.Context) {
	var req struct {
		Name       string `json:"name"`
		Runtime    string `json:"runtime"`
		Dir        string `json:"dir"`
		LaunchArgs string `json:"launchArgs"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request body", nil)
		return
	}
	// 本地创建同款契约（terminal.createAgentTerminal）：前端 500 字节同口径
	// 预检，这里中心侧先拦一次，省一次跨机往返且不依赖对端版本
	req.LaunchArgs = strings.TrimSpace(req.LaunchArgs)
	if len(req.LaunchArgs) > 500 {
		shared.Error(c, http.StatusBadRequest, "launchArgs too long", fmt.Errorf("max 500 chars"))
		return
	}

	target, err := findInstance(c.Param("id"))
	if err != nil {
		if errors.Is(err, errInstanceNotFound) {
			shared.Error(c, http.StatusNotFound, "instance not found", nil)
			return
		}
		// 实例库读取失败 ≠ 不存在，如实 500
		shared.Error(c, http.StatusInternalServerError, "Instance operation failed", err)
		return
	}
	// 派发到本机实例是无意义绕行（本机创建走 POST /api/terminals 直达，
	// 无需经转发链路）
	if target.IsLocal {
		shared.Error(c, http.StatusBadRequest, "cannot dispatch to the local instance, create the session directly", nil)
		return
	}

	payload, err := json.Marshal(map[string]string{
		"name":       req.Name,
		"kind":       "agent",
		"runtime":    req.Runtime,
		"dir":        req.Dir,
		"launchArgs": req.LaunchArgs,
	})
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "dispatch marshal failed", err)
		return
	}

	status, body, err := postToInstance(target.URL, target.Token, payload)
	// scheme 翻转重试一次（探活同款自愈）：网络层失败，或明文打 TLS 端口的
	// 400 固定签名——存量 http:// 地址在对端升级 TLS 后探测链会自动迁移 URL，
	// 但探测窗口外的首次派发不该因此失败
	if err != nil || isPlaintextToHTTPS(status, body) {
		if flipped := flipScheme(target.URL); flipped != "" {
			if status2, body2, err2 := postToInstance(flipped, target.Token, payload); err2 == nil && !isPlaintextToHTTPS(status2, body2) {
				status, body, err = status2, body2, nil
			}
		}
	}
	if err != nil {
		auditDispatch(c, target, req.Runtime, "", store.AuditResultFailure, err.Error())
		// 稳定前缀 + 原文：前端 KNOWN_ERROR_I18N 既有 /remote unreachable/ 条目
		// 跨平台可达（Windows 连接拒绝原文是 connectex 文案，裸透传映射不了），
		// 诊断原文保留在前缀之后。前缀收口 errmarkers 注册表（P-20261004-29），
		// 与 proxy 代理面同串
		shared.Error(c, http.StatusBadGateway, errmarkers.RemoteUnreachable+": "+err.Error(), nil)
		return
	}

	if status < 200 || status >= 300 {
		remoteErr := remoteErrorText(body)
		auditDispatch(c, target, req.Runtime, "", store.AuditResultFailure, fmt.Sprintf("status=%d %s", status, remoteErr))
		// 对端 4xx/5xx 原样回传：预检稳定标记（runtime not installed /
		// path does not exist 等）跨实例同文案，前端 KNOWN_ERROR_I18N 直接映射
		shared.Error(c, status, remoteErr, nil)
		return
	}

	var created struct {
		Data struct {
			ID       string `json:"id"`
			Name     string `json:"name"`
			Runtime  string `json:"runtime"`
			Launched bool   `json:"launched"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &created); err != nil || created.Data.ID == "" {
		// 2xx 但解析不出会话 id：对端形态异常（反代/SPA fallback），按失败处置
		auditDispatch(c, target, req.Runtime, "", store.AuditResultFailure, "unexpected response shape")
		shared.Error(c, http.StatusBadGateway, "dispatch target returned an unexpected response", nil)
		return
	}

	sessionName := created.Data.Name
	if sessionName == "" {
		sessionName = created.Data.ID
	}
	runtime := created.Data.Runtime
	if runtime == "" {
		runtime = req.Runtime
	}

	auditDispatch(c, target, runtime, sessionName, store.AuditResultSuccess, "")
	notifyDispatched(target, sessionName, runtime)
	recordDispatch(target, created.Data.ID, sessionName, runtime)

	slog.Info("session dispatched to instance", "instance", target.Name, "id", target.ID,
		"remoteSession", created.Data.ID, "runtime", runtime)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"remoteSessionId":   created.Data.ID,
		"remoteSessionName": sessionName,
		"instanceId":        target.ID,
		"instanceUrl":       target.URL,
		"runtime":           runtime,
		"launched":          created.Data.Launched,
	}})
}

// postToInstance 对端 /api/terminals 单次转发（不换 scheme）：Bearer 携实例
// 令牌（与代理链同款鉴权语义——access token 过对端 TokenAuth，锁态不受影响）
func postToInstance(rawURL, token string, payload []byte) (int, []byte, error) {
	base := strings.TrimRight(rawURL, "/")
	req, err := http.NewRequest("POST", base+"/api/terminals", bytes.NewReader(payload))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := dispatchHTTPClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, dispatchRespLimit))
	if err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, body, nil
}

// isPlaintextToHTTPS 明文请求打到 TLS 端口的固定签名（instance.go 同款判定）
func isPlaintextToHTTPS(status int, body []byte) bool {
	return status == http.StatusBadRequest && strings.Contains(string(body), plaintextToHTTPSBody)
}

// remoteErrorText 从对端错误响应提取 error 字段原文（非 JSON 形态回退截断
// 原文；截断经 ToValidUTF8 防 rune 劈半产出非法序列）
func remoteErrorText(body []byte) string {
	var parsed struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &parsed) == nil && parsed.Error != "" {
		return parsed.Error
	}
	text := strings.TrimSpace(string(body))
	if len(text) > 300 {
		text = strings.ToValidUTF8(text[:300], "")
	}
	return text
}

// findInstance 按 id 取实例配置（CheckInstance 同款线性查找；实例量个位级）
func findInstance(id string) (config.InstanceConfig, error) {
	instances, err := store.Get().Instance.List()
	if err != nil {
		return config.InstanceConfig{}, err
	}
	for _, inst := range instances {
		if inst.ID == id {
			return inst, nil
		}
	}
	return config.InstanceConfig{}, errInstanceNotFound
}

var errInstanceNotFound = errors.New("instance not found")

// notifyDispatched 派发结果通知入账（中心侧）：「已派发到 <实例>：<会话名>」，
// Action=switch-instance 点击跳该实例（实例切换链既有）；模板键随界面语言渲染
func notifyDispatched(target config.InstanceConfig, sessionName, runtime string) {
	store.Get().Notification.Add(notification.Notification{
		Type:     "success",
		Category: notification.CategoryTask,
		TitleKey: "instance.dispatch.notify.title",
		Title:    fmt.Sprintf("已派发到 %s：%s", target.Name, sessionName),
		// Body 语言中立明细：目标地址 + 运行时（launched=false = 对端降级纯 shell，
		// 会话在但运行时未起——诚实标注）
		Body: fmt.Sprintf("%s · runtime=%s", target.URL, runtime),
		MsgParams: map[string]any{
			"instance": target.Name,
			"session":  sessionName,
		},
		Action:        "switch-instance",
		ActionPayload: target.ID,
	})
}

// recordDispatch 派发寻址账（P-20261004-131）：成功派发落一条记录，中心的进度
// 回流轮询（前端 useFleetTaskBackflow）据此寻址对端 GET /agent-tasks 拉会话进度
// ——只含寻址元数据（同审计口径：令牌与任务指令不入账）。落账失败不回滚派发
// （会话已在对端创建，如实 500 只会把已成之事报成失败）；回流缺这条账退化为
// P-101 现状（对端列表粗粒度），不产生错误状态
func recordDispatch(target config.InstanceConfig, remoteSessionID, sessionName, runtime string) {
	if remoteSessionID == "" {
		return
	}
	if err := store.Get().DispatchRecord.Append(store.DispatchRecord{
		InstanceID:        target.ID,
		InstanceName:      target.Name,
		InstanceURL:       target.URL,
		RemoteSessionID:   remoteSessionID,
		RemoteSessionName: sessionName,
		Runtime:           runtime,
		At:                time.Now(),
	}); err != nil {
		slog.Warn("dispatch record persist failed", "instance", target.Name, "err", err)
	}
}

// ListDispatched GET /api/instances/dispatched ——派发寻址账清单（新在前）。
// 前端回流轮询的消费面；记录随 TTL（7 天）/环形上限（200）收账
func ListDispatched(c *gin.Context) {
	list, err := store.Get().DispatchRecord.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "dispatch record list failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": list})
}

// DeleteDispatched DELETE /api/instances/dispatched/:recordId ——移除单条派发
// 记录（前端「不再跟踪」入口）：回流轮询与 bySession 的 remote 条目随记录
// 消失收账。幂等——未知 id 同样 200（清理链与并发点击不打错）
func DeleteDispatched(c *gin.Context) {
	if err := store.Get().DispatchRecord.Delete(c.Param("recordId")); err != nil {
		shared.Error(c, http.StatusInternalServerError, "dispatch record delete failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"removed": true}})
}

// auditDispatch 派发审计（跨实例操作可溯）：实例名/地址/会话名/运行时元数据，
// 绝不含令牌与任务指令内容（launchArgs 属会话内容，不入账）
func auditDispatch(c *gin.Context, target config.InstanceConfig, runtime, sessionName, result, reason string) {
	detail := fmt.Sprintf("instance=%s url=%s runtime=%s", target.Name, target.URL, runtime)
	if sessionName != "" {
		detail += " session=" + sessionName
	}
	if reason != "" {
		detail += " " + reason
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditInstanceDispatch,
		Result: result,
		IP:     c.ClientIP(),
		Detail: detail,
	})
}
