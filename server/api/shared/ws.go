package shared

import (
	"errors"
	"log/slog"
	"net/http"
	"net/url"

	"github.com/gorilla/websocket"
)

// WS 读帧上限防线（P-20261003-313）：gorilla/websocket 默认无读上限，任一
// 已认证连接可发任意大帧并被服务端全额缓冲进内存——失控 agent（病态循环
// 粘贴/巨型 JSON 上报）单个连接即可撑爆进程。所有 WS 升级后必须对连接
// SetReadLimit 收口；超限时 gorilla 自动向对端回 close 1009（message too
// big，标准协议信号）并让读循环得到 ErrReadLimit。
const (
	// WSReadLimitInput 终端/ops-channel 等业务 WS 输入帧上限（1MB）：
	// 远超 64KB 大粘贴确认阈值（16 倍余量），合法路径零误伤；
	// 粘贴图片走 REST（/terminals/paste-image），不经 WS 输入
	WSReadLimitInput = 1 << 20

	// WSReadLimitProxy 代理透传 WS（/ws/proxy）前端侧帧上限（8MB）：
	// 转发语义放宽——透传层只防本端无界缓冲，帧的输入语义由远端实例的
	// 业务 WS 按 WSReadLimitInput 把守；8MB 给远端合法大帧（scrollback
	// 重放等）留足余量
	WSReadLimitProxy = 8 << 20
)

// WarnIfReadLimitExceeded WS 读循环错误统一判别：超限读（对端已收到 1009
// 关闭帧）额外记 warn 便于观测失控客户端，其余错误维持调用方原语义。
// channel 为通道名（如 "terminal"），仅用于日志定位
func WarnIfReadLimitExceeded(err error, channel string) {
	if errors.Is(err, websocket.ErrReadLimit) {
		slog.Warn("ws: input frame exceeds read limit, closing 1009", "channel", channel)
	}
}

// SameOrigin 校验请求是否同源：Origin 缺失（curl/agent 等非浏览器客户端）放行；
// 存在则其 host:port 必须与请求 Host 一致（scheme 不限，兼容反代终止 TLS 的部署）。
// 浏览器发起的跨源 WS 握手在此被拒，防跨站 WebSocket 劫持。
func SameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	return u.Host == r.Host
}

// WSUpgradeOption 升级器工厂的差异位：新连接属性一律经此扩展，禁止调用方
// 自拼 websocket.Upgrader 字面量（工厂外字面量会漏掉统一默认值——前次尝试
// 的红旗教训正是某属性在一条路径上悄悄漂移）
type WSUpgradeOption func(*websocket.Upgrader)

// WithCompression 启用 permessage-deflate 压缩协商（RFC 7692，P-20261003-191）：
// 终端输出（scrollback 重放、构建日志、agent 流式输出）在公网/VPN 远程访问下
// 带宽敏感，静态资源 gzip 只盖了 app 层、WS 明文帧是缺口。启用后升级
// 即协商——仅客户端 offered permessage-deflate 才压（浏览器默认 offered），
// 未提供者（curl/agent 等裸客户端、经 /ws/proxy 透传的拨号器）响应无
// 扩展头、链路保持原样，对客户端完全透明。
//
// CPU 代价权衡（终端高频小帧场景）：gorilla 默认 flate level 1
// （BestSpeed，compression.go defaultCompressionLevel）+ 双向
// no_context_takeover——每条消息独立压缩、不保留跨消息滑窗（内存有界，
// 小帧无字典增益）。终端按键回显/光标移动类小帧每条仍付一次 flate 编码
// 代价，level 1 已是廉价档且远小于帧的 TCP/IP 开销；大输出单帧压缩比
// 通常 3~10×，收益远大于代价。gorilla 无按帧尺寸阈值（conn.go 对全部
// data 帧一律压），若未来实测 CPU 敏感，扩展点是按通道拆专用升级器
// （不传本选项即可）或写前按输出尺寸分流，不需要动各 handler。
// 代理透传 /ws/proxy 与锁定拒绝专用升级器不走本选项（透传两跳各有自身
// 协商面；拒绝路径仅送达关闭帧无数据面）。
func WithCompression() WSUpgradeOption {
	return func(u *websocket.Upgrader) {
		u.EnableCompression = true
	}
}

// WSUpgrade 全部 WS 升级器的统一构造工厂（默认 CheckOrigin=SameOrigin，
// 见 SameOrigin——浏览器跨源握手在此被拒，防跨站 WebSocket 劫持）。
// 其余 gorilla 字段维持零值不动（HandshakeTimeout=0、Read/WriteBufferSize=0
// 走 gorilla 内部 4096 默认、WriteBufferPool=nil、Subprotocols=nil）——与工厂
// 化前三处历史配置逐一核对过（gorilla v1.5.3 Upgrader 全部 8 个导出字段，
// 无 ReadBufferScale 字段），任何字段变更都是显式选项而非悄悄漂移。
//
// 读上限不在本工厂（P-20261003-313 统一位预留说明）：gorilla 的读上限是
// 连接级属性（Upgrade 后 SetReadLimit），Upgrader 结构体无此字段，统一
// 政策落在同文件 WSReadLimitInput/WSReadLimitProxy 常量 +
// WarnIfReadLimitExceeded；未来若出现升级器级连接政策（缓冲、超时等），
// 在此加 WSUpgradeOption 即是唯一收口位。
func WSUpgrade(opts ...WSUpgradeOption) websocket.Upgrader {
	u := websocket.Upgrader{CheckOrigin: SameOrigin}
	for _, opt := range opts {
		opt(&u)
	}
	return u
}

// WSUpgrader 全部业务 WS（终端 I/O / ops-channel / 通知推送 / 项目文件事件 /
// 克隆与部署日志 / 远端终端）共用的升级器：工厂默认同源校验 + 压缩协商
// （WithCompression 见上注记）
var WSUpgrader = WSUpgrade(WithCompression())

// EchoSubprotocols 构造回显 Sec-WebSocket-Protocol 的 responseHeader
// 浏览器侧 new WebSocket(url, [sub]) 会拒绝不回显子协议的连接。
// 这里将请求中的子协议原样回显，支持前端用 token 作为子协议传递 unlock token。
func EchoSubprotocols(r *http.Request) http.Header {
	protos := r.Header.Values("Sec-WebSocket-Protocol")
	if len(protos) == 0 {
		return nil
	}
	h := http.Header{}
	for _, p := range protos {
		h.Add("Sec-WebSocket-Protocol", p)
	}
	return h
}
