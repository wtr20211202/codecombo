package terminal

import (
	"strings"
	"time"
)

// 会话输出留档导出（P-20261003-100）：长输出命令（部署/构建）的输出想留档——
// 选区复制覆盖不全、截图丢行，回滚缓冲整体导出 txt 是运维留档刚需。
// 数据面 = 既有 scrollback 读取链（CaptureScrollback：tmux capture-pane / native
// 环形缓冲），体积天然有界——护栏沿 history 上限（native 环形容量 = 配置行数
// ×80B 钳制 ≤16MB；tmux 受 history-limit 10000 约束），无需独立字节闸。
// ANSI 剥离走 StripANSI 单实现（与跨会话输出检索同源）：留档 txt 要可读纯文本
// 而非终端字节保真（字节保真诉求走既有 GET /terminals/:id/scrollback 直传）。

// exportTitleMaxRunes 下载名会话名摘要的 rune 截断（与 claudesessions 导出名同值）
const exportTitleMaxRunes = 40

// ExportDownloadName 下载文件名：terminal-<会话名摘要>-<yyyymmdd>.txt。
// 会话名是用户内容（可含 CRLF/路径分隔符/非 ASCII）：控制字符与跨平台不安全
// 字符折叠为 '-'（空格合法保留）、连续折叠并缩、rune 截断、首尾 '-./ ' 修整
// （Windows 段规则）——与 claudesessions.ExportDownloadName 同约定（前端
// utils/exportFileName 按同一规则客户端合成下载名：axios blob 响应不透
// Content-Disposition），空名回退会话 id 净化形。非 ASCII 由 Content-Disposition
// 的 RFC 5987 形式承载，本函数只保证文件系统安全。
func ExportDownloadName(name, sessionID string, now time.Time) string {
	var b strings.Builder
	for _, r := range name {
		if r >= 0x20 && r != 0x7f && !strings.ContainsRune(`\/:*?"<>|`, r) {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	// 连续折叠符并缩 + 首尾修整：Windows 段尾的 '.'/' ' 非法，'-'/'. ' 尾缀难看
	slug := collapseExportDashes(b.String())
	runes := []rune(slug)
	if len(runes) > exportTitleMaxRunes {
		runes = runes[:exportTitleMaxRunes]
	}
	slug = strings.Trim(string(runes), "-. ")
	if slug == "" {
		slug = sanitizeExportFallbackID(sessionID)
	}
	return "terminal-" + slug + "-" + now.Format("20060102") + ".txt"
}

// ExportText 会话输出留档体：scrollback 全量快照剥 ANSI 后的纯文本。
// err 语义与 CaptureScrollback 一致（tmux capture 失败已在 backend 内降级为
// 空内容——会话可能刚被外部 kill，导出空文件比报错更符合留档直觉）
func (s *Session) ExportText() ([]byte, error) {
	raw, err := s.CaptureScrollback(0)
	if err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return nil, nil
	}
	return StripANSI(raw), nil
}

// collapseExportDashes 连续 '-' 并缩为单个（导出名摘要专用，claudesessions 同形）
func collapseExportDashes(s string) string {
	var b strings.Builder
	prev := false
	for _, r := range s {
		if r == '-' {
			if !prev {
				b.WriteByte('-')
			}
			prev = true
			continue
		}
		b.WriteRune(r)
		prev = false
	}
	return b.String()
}

// sanitizeExportFallbackID 空会话名时的下载名回退：会话 id 是服务端生成的
// ASCII 串，此处仅防御性保留可见 ASCII（claudesessions 同形）
func sanitizeExportFallbackID(id string) string {
	var b strings.Builder
	for _, r := range id {
		if r > 0x20 && r < 0x7f {
			b.WriteRune(r)
		}
	}
	out := b.String()
	if runes := []rune(out); len(runes) > exportTitleMaxRunes {
		out = string(runes[:exportTitleMaxRunes])
	}
	return out
}
