package sshclient

import (
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"log/slog"
	"net"
	"strings"

	"codecombo/server/errmarkers"
	"codecombo/server/store"

	"golang.org/x/crypto/ssh"
)

// SSH 主机密钥 TOFU 校验（Trust On First Use，P-20261003-34）。
//
// 背景：本包 Dial 的默认 HostKeyCallback 曾是 ssh.InsecureIgnoreHostKey()——
// 远程主机/部署的 SSH 连接不校验主机密钥，中间人可透明劫持（密码/私钥与命令
// 过同一管道）。本文件按 SSH known_hosts 的 TOFU 语义收口：首连记录主机公钥
// 指纹（按 host:port，落车道 1 kind "sshhostkeys"，加密复用凭据域），此后
// 连接比对——一致放行、变更拒绝（错误文案给出重置入口，可操作）。
//
// 同限（业界一致）：首连即被劫持则会钉住假指纹——TOFU 假设首连信道可信，
// 与 OpenSSH 严格 known_hosts 首录语义相同。合法迁移（重装/换钥）经主机
// 设置的重置入口重新 TOFU（reset 动作入审计与通知中心）。
//
// 依赖说明：本包此前是纯叶子包，此处引入 store 是刻意的接线（与 peercert
// 服务包同姿态）：TOFU 策略贴着 ssh.HostKeyCallback 的装配点才有意义，
// 拆到独立服务包只会多一层转发。store 未初始化（单元测试环境）时校验
// 失效放行——与 peercert 读库失败按首见处理的失败面取舍一致。

// hostKeyChangedMarker 拒绝错误的稳定标记：前端 friendlyRemoteError 据此
// 映射为本地化可行动文案（指向重置入口）。改文案勿改标记。文本唯一事实源
// 在 errmarkers 注册表（P-20261004-29），此处保名别名
const hostKeyChangedMarker = errmarkers.HostKeyChanged

// fingerprintOf 主机公钥指纹（SHA256:base64 无填充，ssh-keygen -lf 同格式，
// 与 store 内用户密钥指纹同款）
func fingerprintOf(key ssh.PublicKey) string {
	sum := sha256.Sum256(key.Marshal())
	enc := base64.StdEncoding.EncodeToString(sum[:])
	return "SHA256:" + strings.TrimRight(enc, "=")
}

// tofuHostKeyCallback 构造默认 TOFU 主机密钥回调（Dial 在未显式指定
// HostKeyCallback 且未跳过时装配）
func tofuHostKeyCallback(host string, port int) ssh.HostKeyCallback {
	return func(_ string, _ net.Addr, key ssh.PublicKey) error {
		return checkOrPinHostKey(host, port, key)
	}
}

// checkOrPinHostKey TOFU 核心：首见记录并放行；已见比对，变更即拒。
// 读库失败按首见处理（warn 日志留痕）：TOFU 的失败面（连不上对端、下轮
// 重连重录）比误拒更可接受——与 peercert.CheckOrPin 同款取舍
func checkOrPinHostKey(host string, port int, key ssh.PublicKey) error {
	if host == "" || key == nil {
		return nil
	}
	fp := fingerprintOf(key)
	st := store.Get()
	if st == nil {
		slog.Warn("sshhostkey: store not initialized — TOFU check skipped", "host", host, "port", port)
		return nil
	}
	known, _, ok, err := st.SSHHostKey.Get(host, port)
	if err != nil {
		slog.Warn("sshhostkey: read fingerprint failed — pinning as first-seen", "host", host, "port", port, "err", err)
	} else if ok {
		if known != fp {
			// 变更拒绝：审计留痕（同路记账口，Append 尽力而为不阻断）后给出
			// 可操作错误——重置入口在主机设置（hostkey.reset 端点）
			st.Audit.Append(store.AuditEvent{
				Action: store.AuditHostKeyMismatch,
				Result: store.AuditResultFailure,
				Detail: fmt.Sprintf("%s:%d pinned=%s got=%s", host, port, known, fp),
			})
			return fmt.Errorf("ssh host %s:%d %s (pinned %s, got %s, %s) — if this is a legitimate server migration, reset the pinned fingerprint in the host settings",
				host, port, hostKeyChangedMarker, known, fp, key.Type())
		}
		return nil
	}
	if err := st.SSHHostKey.Put(host, port, fp, key.Type()); err != nil {
		// 钉扎写失败：放行本次连接但不留记录（下轮连接重新 TOFU）；
		// 拒绝连接反而会把可用性问题放大成故障面
		slog.Warn("sshhostkey: pin fingerprint failed", "host", host, "port", port, "err", err)
	}
	return nil
}
