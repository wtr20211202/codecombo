package notification

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"codecombo/server/mask"
)

// 外发推送转发器（P-20261002-31）：通知落库 / 审批挂起事件 → 用户自配的
// Bark/ntfy/自定义接收端。设计约束：
//   - 绝不阻塞通知主链：HTTP 外发在独立 goroutine，5s 超时，失败静默丢弃记日志
//   - 转发内容仅 title/body（审批事件为 op/target 摘要），出域前统一过
//     mask.MaskText 遮蔽闸（P-20261007-9）：站内 WS 广播面向已认证本机浏览器
//     保持原文（低风险信任域），第三方接收端（Bark=APNs 通道/ntfy 公共实例，
//     外部信任域）只见遮蔽版——出域才脱敏的分层语义。error/warning 通知常携
//     部署目标主机/ssh 错误段（P-289 实证），MaskText 模式集只命中 sc?_ 系
//     令牌/password 族赋值/AWS 密钥三形态——主机名/路径/错误文本照常外发，
//     排障信息零损失，遮蔽的恰是不该出域的
//   - 事件三态：关闭 / important（审批挂起 + error/warning 通知，默认）/ all
//
// 偏好读取经构造注入的函数口（notification 不能反向 import store），由组合根
// 在模块注册时声明式传入（同 remoteterminal.NewModule(dialer) 惯例）。

// webhookTimeout 单次外发超时
const webhookTimeout = 5 * time.Second

// webhookClient 外发共享 client：5s 整体超时（连接+响应）。
// Forwarder 异步转发与 SendTest 同步测试共用同一条链路，测得即所得
var webhookClient = &http.Client{Timeout: webhookTimeout}

// Forwarder webhook 外发转发器（notify 模块持有，订阅总线后调用）
type Forwarder struct {
	// prefs 偏好读取口（store.Get().Notification.GetPrefs），nil 时转发器停摆
	prefs func() Prefs
}

// NewForwarder 创建转发器；prefsFn 为 nil 时 OnNotification/OnApprovalPending 均为 no-op
func NewForwarder(prefsFn func() Prefs) *Forwarder {
	return &Forwarder{prefs: prefsFn}
}

// webhookPayload 外发载荷上限截断：推送端（手机弹窗）对超长文本体验差，
// title/body 各截 500 rune 防御性封顶（正常通知远小于此）
const webhookFieldMax = 500

// OnNotification 通知落库后入口（store 出站口 → 总线 TopicNew → 模块 → 这里）。
// 过滤不通过直接返回，goroutine 只在真正外发时才创建
func (f *Forwarder) OnNotification(n Notification) {
	w, ok := f.ready()
	if !ok {
		return
	}
	if !webhookWants(w, n) {
		return
	}
	go f.deliver(w, webhookTitle(n), webhookBody(n))
}

// OnApprovalPending 审批挂起入口（总线 TopicApprovalPending）。载荷为
// store.AgentApproval（notification 不能反向 import store），经 JSON 往返
// 提取展示子集——与 ai 模块 persistTaskEvent 的载荷解析同一手法
func (f *Forwarder) OnApprovalPending(payload any) {
	w, ok := f.ready()
	if !ok {
		return
	}
	info := approvalInfoFromPayload(payload)
	title := "智能体审批挂起"
	body := strings.TrimSpace(info.Op)
	if info.Target != "" {
		body += " → " + info.Target
	}
	if info.Detail != "" {
		body += "\n" + info.Detail
	}
	// 出域遮蔽闸（P-20261007-9）：审批链入库已过 MaskApprovalText，此处再过
	// MaskText 幂等（*** 不再命中模式集）——兜住 Op 字段（入库口未遮蔽）与
	// 总线上其他生产方的未脱敏载荷，外发面单点收敛
	go f.deliver(w, title, truncateRunes(mask.MaskText(body), webhookFieldMax))
}

// SendTest 同步发送测试推送（设置页「发送测试推送」按钮），返回错误供 UI 展示。
// 与异步转发共用同一条 SendWebhook 链路，测得即所得
func SendTest(p Prefs) error {
	w := p.Webhook.Normalized()
	if !w.Ready() {
		return fmt.Errorf("外部推送未启用或 URL 为空")
	}
	return SendWebhook(w, "Codecombo 测试推送 / Test Push", "外部推送链路正常 / Webhook delivered")
}

// ready 取归一化偏好并判断就绪；未装配/未启用返回 false
func (f *Forwarder) ready() (WebhookPrefs, bool) {
	if f == nil || f.prefs == nil {
		return WebhookPrefs{}, false
	}
	w := f.prefs().Webhook.Normalized()
	if !w.Ready() {
		return WebhookPrefs{}, false
	}
	return w, true
}

// webhookWants 事件过滤三态：关闭（Ready=false 上游已挡）/ important / all。
// important = 失败与异常类通知（type error/warning——与前端桌面通知弹出门控
// 同一集合，见 NotificationCenter watch）；审批挂起走 OnApprovalPending 单独入口
func webhookWants(w WebhookPrefs, n Notification) bool {
	if w.Scope == WebhookScopeAll {
		return true
	}
	return n.Type == "error" || n.Type == "warning"
}

// webhookTitle/webhookBody 外发文案：优先模板化 key 的回退原文（title/body 落库
// 时已含服务端原文），日报类 titleKey 通知无原文可读性差——直接以类别标注，
// 保证手机端至少能看出来源域。出域遮蔽闸（P-20261007-9）：先 MaskText 后截断
// ——先遮蔽保证截断边界不劈开模式命中（半截令牌漏出域），遮蔽后文本仍受
// 500 rune 封顶；调用频度=通知外发（经 ready/webhookWants 过滤后），三条
// 全量正则的代价可忽略
func webhookTitle(n Notification) string {
	if t := truncateRunes(mask.MaskText(n.Title), webhookFieldMax); t != "" {
		return t
	}
	return "codecombo " + n.Category
}

func webhookBody(n Notification) string {
	return truncateRunes(mask.MaskText(n.Body), webhookFieldMax)
}

// deliver 外发并记录结果（goroutine 内执行；panic 不外泄）
func (f *Forwarder) deliver(w WebhookPrefs, title, body string) {
	defer func() { _ = recover() }()
	if err := SendWebhook(w, title, body); err != nil {
		// 失败静默丢弃，仅留日志（不回写通知中心——避免推送失败本身再生成
		// 通知的循环；URL 配错由用户在设置页「测试推送」发现）
		slog.Warn("webhook forward failed", "mode", w.Mode, "err", err)
	}
}

// SendWebhook 按偏好模式外发一条推送（同步，5s 超时）。GET 模式对模板做
// {title}/{body} 插值（值按查询参数转义）；POST 模式发 JSON {"title","body"}
func SendWebhook(w WebhookPrefs, title, body string) error {
	u := strings.TrimSpace(w.URL)
	raw, err := url.Parse(u)
	if err != nil || (raw.Scheme != "http" && raw.Scheme != "https") {
		return fmt.Errorf("webhook url 必须是 http/https 端点")
	}

	var req *http.Request
	switch w.Normalized().Mode {
	case WebhookModeGet:
		// 模板插值：值先按查询参数转义再替换（空格/&/= 不破坏 URL 结构）
		full := Interpolate(u,
			url.QueryEscape(title),
			url.QueryEscape(body))
		req, err = http.NewRequest(http.MethodGet, full, nil)
	default:
		payload, _ := json.Marshal(map[string]string{"title": title, "body": body})
		req, err = http.NewRequest(http.MethodPost, u, bytes.NewReader(payload))
		req.Header.Set("Content-Type", "application/json")
	}
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}

	client := webhookClient
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("unexpected status %d", resp.StatusCode)
	}
	return nil
}

// Interpolate URL 模板插值：替换 {title}/{body} 占位符（其余字符原样保留）
func Interpolate(tmpl, title, body string) string {
	return strings.NewReplacer("{title}", title, "{body}", body).Replace(tmpl)
}

// truncateRunes 按 rune 截断（防劈开多字节字符）
func truncateRunes(s string, max int) string {
	rs := []rune(s)
	if len(rs) <= max {
		return s
	}
	return string(rs[:max])
}

// ApprovalInfo 审批挂起事件的展示子集（store.AgentApproval 的 JSON 字段对齐）
type ApprovalInfo struct {
	Agent  string `json:"agent"`
	Op     string `json:"op"`
	Target string `json:"target"`
	Detail string `json:"detail"`
}

// approvalInfoFromPayload 任意载荷经 JSON 往返提取子集；解析失败返回零值
// （外发降级为无明细标题，不影响主链）
func approvalInfoFromPayload(payload any) ApprovalInfo {
	var info ApprovalInfo
	b, err := json.Marshal(payload)
	if err == nil {
		_ = json.Unmarshal(b, &info)
	}
	return info
}
