package ai

import (
	"encoding/json"
	"strings"

	"codecombo/server/agentops"
	"codecombo/server/api/opschannel"
	"codecombo/server/mask"
	"codecombo/server/notification"
	"codecombo/server/store"
	"codecombo/server/terminal"
)

// ============== frontend 动词族设备定向（P-20261117-4） ==============
//
// frontend.* 四事件（frontend.download/clipboard/open/reload）是「替用户执行
// 浏览器动作」的设备效应原语，语义本就是「单一浏览器效应」——此前的无差别
// 广播让所有已连浏览器齐弹下载框/齐写剪贴板（用户实测主诉），作用面越界。
// 本模块收口发布口的定向路由：
//
//	绑定在案（会话创建 X-Browser-Id 头初绑 + /ws/terminal attach 点接管迁移，
//	last-attach-wins）且目标浏览器在线 → opschannel.BroadcastEventTargeted 定向；
//	无绑定 → 单浏览器启发式（opschannel.SoleConnectedBrowser：全部已连 WS 共属
//	同一 browserId 时直接定向，覆盖「重启恢复绑定丢失」「纯脚本会话」两大常见
//	态，单浏览器用户零回退）；目标不在线或多浏览器并存且无绑定 → 不广播设备
//	效应，降级 notify.persist 通知（功能不缺失只是多一次点击）。
//
// 定向作用面钉死（评审必改②）：只过滤 hub.broadcast 的 WS 收件面——观察者链/
// 通知中心/录制联动保持全量可见。事件族白名单钉死（评审必改⑥）：Target 仅
// frontend.* 四事件（opschannel.IsDeviceEffectEvent），approval.pending 等注意力
// 类保持全广播——定向审批卡会让他端窗口期漏卡。

// sessionLookup 会话头读取的最小依赖面（*gin.Context 天然满足，GetHeader 同名
// 同签名）：单测可注入固定头值的桩，免装配完整 gin 请求
type sessionLookup interface {
	GetHeader(string) string
}

// browserForSession 会话 → 浏览器绑定的读取口（变量而非直调：单测换桩——
// 本包装配不出真会话，terminal.DefaultManager 直读是生产唯一形态）
var browserForSession = func(sessionID string) string {
	if s := terminal.DefaultManager.GetSession(sessionID); s != nil {
		return s.BrowserID()
	}
	return ""
}

// deliverDeviceEffect 发布口设备效应出口（OpsNotify 白名单命中后调用，替代
// 朴素全广播）：解析会话 → 浏览器绑定 → 定向广播或降级通知。恒 200 语义由
// 调用方收口（降级与正常发布同响应形态——错误响应会诱发 agent 重试放大）。
// 无 X-Session-ID 的上报按「无绑定」同口径处理（单浏览器启发式照常覆盖）；
// 路由决策矩阵在 opschannel.RouteDeviceEffect（与 hub 在线状态同源同文件）
func deliverDeviceEffect(c sessionLookup, eventType string, payload interface{}) {
	binding := ""
	if sid := strings.TrimSpace(c.GetHeader("X-Session-ID")); sid != "" {
		binding = browserForSession(sid)
	}
	route := opschannel.RouteDeviceEffect(binding)
	if route.Target != "" {
		opschannel.BroadcastEventTargeted(eventType, payload, route.Target)
		return
	}
	persistDeviceEffectFallback(eventType, payload, route.Reason)
}

// frontendFallbackPreview 降级通知的剪贴板预览：遮蔽（入账面是持久留痕，
// 敏感值不得入档——与 notify.persist 校验即遮蔽同纪律）+ rune 截断
func frontendFallbackPreview(text string) string {
	masked := mask.MaskText(text)
	chars := []rune(masked)
	if len(chars) > 80 {
		return string(chars[:80]) + "…"
	}
	return masked
}

// persistDeviceEffectFallback 设备效应降级通知化：与 notify.persist 同库同
// 偏好过滤（类别静音命中即不入账不弹面——「效应零反馈」随既有静音语义，评审
// 必改④a：静音时段本就不弹面，通知在中心可查的手册注记已如实声明）。归类
// task 与 agent 上报链同门类；入账成功后广播 notify.persist 实时弹面（与
// agent 自发 notify.persist 同链同拍——入账先于广播、静音两者皆无）。文案走
// TitleKey/BodyKey 双语模板（Title/Body 中文原值为无前端渲染时的兜底，
// portConflict 通知同款）；降级成因两档分键（OnIdleDetach 的
// bodyPersistent/bodyEphemeral 先例）：offline=绑定的浏览器不在场 /
// unbound=多浏览器并存且会话无绑定。下载动作扩 `download` 形态（评审必改④b：
// actionPayload=projectId+path 复合 JSON，前端通知点击直接触发既有下载链，
// 不手拼相对路径硬塞 url 形态）；open 降级带 action=url（http(s) 白名单已过，
// 任何设备的用户点击仍可达）；clipboard/reload 纯告知
func persistDeviceEffectFallback(eventType string, payload interface{}, reason string) bool {
	st := store.Get()
	if st == nil {
		return false
	}
	if !st.Notification.GetPrefs().IsEnabled(notification.CategoryTask) {
		return false
	}
	bodyKey := "notify.frontendFallback.bodyUnbound"
	if reason != "unbound" {
		bodyKey = "notify.frontendFallback.bodyOffline"
	}
	n := notification.Notification{Category: notification.CategoryTask, Type: "info", BodyKey: bodyKey}
	switch eventType {
	case opschannel.EventFrontendDownload:
		var p struct {
			Path      string `json:"path"`
			ProjectID string `json:"projectId"`
		}
		if raw, err := json.Marshal(payload); err == nil {
			_ = json.Unmarshal(raw, &p)
		}
		compound, _ := json.Marshal(map[string]string{"projectId": p.ProjectID, "path": p.Path})
		n.TitleKey = "notify.frontendFallback.downloadTitle"
		n.Title = "智能体请求下载文件（已转为通知）"
		n.Body = mask.MaskText(p.Path)
		n.MsgParams = map[string]any{"path": n.Body}
		n.Action = "download"
		n.ActionPayload = string(compound)
		n.ProjectID = p.ProjectID
	case opschannel.EventFrontendOpen:
		var p struct {
			URL string `json:"url"`
		}
		if raw, err := json.Marshal(payload); err == nil {
			_ = json.Unmarshal(raw, &p)
		}
		n.TitleKey = "notify.frontendFallback.openTitle"
		n.Title = "智能体请求打开链接（已转为通知）"
		n.Body = p.URL
		n.MsgParams = map[string]any{"url": p.URL}
		n.Action = "url"
		n.ActionPayload = p.URL
	case opschannel.EventFrontendClipboard:
		var p struct {
			Text string `json:"text"`
		}
		if raw, err := json.Marshal(payload); err == nil {
			_ = json.Unmarshal(raw, &p)
		}
		preview := frontendFallbackPreview(p.Text)
		// 剪贴板条目正文是内容预览（截断+遮蔽），成因短语挤占预览反而失真——
		// 单独成键，成因在标题括注如实呈现
		clipKey := "notify.frontendFallback.clipOffline"
		if reason == "unbound" {
			clipKey = "notify.frontendFallback.clipUnbound"
		}
		n.BodyKey = clipKey
		n.TitleKey = "notify.frontendFallback.clipboardTitle"
		n.Title = "智能体请求写入剪贴板（已转为通知）"
		n.Body = preview
		n.MsgParams = map[string]any{"preview": preview}
	case opschannel.EventFrontendReload:
		n.TitleKey = "notify.frontendFallback.reloadTitle"
		n.Title = "智能体请求重载页面（已转为通知）"
	default:
		return false
	}
	st.Notification.Add(n)
	// 实时弹面（notify.persist 广播语义同拍）：通知中心条目走 notifications WS
	// 链跨设备可见，本广播只承载前端 toast 注意力面——全广播（通知是注意力面，
	// 不受设备定向管辖，评审必改②的边界清单内）
	opschannel.BroadcastEvent(opschannel.EventNotifyPersist, agentops.NotifyPersistPayload{
		Title:         n.Title,
		Body:          n.Body,
		Level:         n.Type,
		Action:        n.Action,
		ActionPayload: n.ActionPayload,
	})
	return true
}
