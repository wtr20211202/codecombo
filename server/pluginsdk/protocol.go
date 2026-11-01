// Package pluginsdk Phase D 插件 RPC 协议 spike（roadmap M6.2，设计文档 §2.1 候选 B）。
//
// 协议：MCP 风格 stdio JSON-RPC 2.0，NDJSON 帧（每行一条消息，无 Content-Length
// 头）——协议极薄、跨语言零依赖、与 AI 原生工具生态（MCP）同构。
// 宿主（Codecombo 主进程）与插件子进程各持一端：
//
//	宿主 → 插件：initialize 请求（握手 + apiVersion 协商，失败即拒绝加载）；
//	             业务方法请求；ping 心跳；Close 关闭 stdin 终止子进程。
//	插件 → 宿主：Response；Notification（单向事件，预留 topic 推送面）。
//
// 契约自检：host_test.go 以「测试二进制子进程 + 真实 stdio 管道」验证
// 握手/调用/心跳/关闭全链路——spike 结论回填设计文档 §2.1。
package pluginsdk

import (
	"encoding/json"
	"fmt"
	"strings"
)

// 协议常量（版本号与 server/kernel 的模块契约 APIVersion 对齐；
// 大版本内只加不改，major 不一致即拒绝装载）
const (
	// ProtocolName P-20261025-1 标识切换正名。宿主握手按 apiVersion 协商，
	// 协议名当前为声明性标识；存量第三方插件零重编译兼容
	ProtocolName = "codecombo/plugin"
	// LegacyProtocolName 更名前协议名（存档：排查旧插件握手载荷时对照）
	LegacyProtocolName = "simple-coding/plugin"

	ProtocolVersion = "1.0.0"

	MethodInitialize = "initialize"
	MethodPing       = "ping"
)

// JSONRPC 版本字段固定值
const jsonrpcVersion = "2.0"

// PluginManifest 插件自述（握手载荷，字段与 kernel.Manifest 对应：
// Phase D 插件 manifest 的 backend 部分经此面暴露给宿主）
type PluginManifest struct {
	Name       string   `json:"name"`
	Title      string   `json:"title,omitempty"`
	Version    string   `json:"version,omitempty"`
	APIVersion string   `json:"apiVersion"`
	Routes     []string `json:"routes,omitempty"`
	Topics     []string `json:"topics,omitempty"`
}

// Request 宿主 → 插件 请求（ID 为空 = Notification）
type Request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// Response 插件 → 宿主 应答
type Response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

// Notification 插件 → 宿主 单向事件（未来 topic 推送面）
type Notification struct {
	JSONRPC string          `json:"jsonrpc"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// RPCError JSON-RPC 2.0 错误对象（沿用标准错误码：
// -32601 method not found / -32602 invalid params / -32000 服务端自定义）
type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string {
	if e == nil {
		return "<nil>"
	}
	return fmt.Sprintf("rpc error %d: %s", e.Code, e.Message)
}

// 常用错误码
const (
	CodeMethodNotFound = -32601
	CodeInvalidParams  = -32602
	CodeServerError    = -32000
)

// APICompatible apiVersion 协商：major 相同即兼容（semver 大版本内只加不改）
func APICompatible(pluginAPI, hostAPI string) bool {
	return majorOf(pluginAPI) != "" && majorOf(pluginAPI) == majorOf(hostAPI)
}

func majorOf(v string) string {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.Index(v, "."); i > 0 {
		return v[:i]
	}
	return v
}
