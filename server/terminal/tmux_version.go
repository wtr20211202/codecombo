package terminal

import (
	"regexp"
	"strconv"
)

// tmux 版本解析与剪贴板能力地板分类（P-20261109-7）。
// 本文件**不带平台构建标签**：远程主机终端（server/api/remote，全平台编译）
// 探测远端 tmux -V 后要按同一判据分两档提示（<3.2 拖选复制受限 / <3.3 应用内
// 复制透传受限），分类逻辑必须三平台共享——放 tmux_cmd.go（//go:build !windows）
// 会让 Windows 编译断链。

var tmuxVersionRe = regexp.MustCompile(`tmux\s+(\d+)\.(\d+)(?:[a-z])?`)

// ParseTmuxVersion 解析 tmux -V 输出（跨平台导出：本地探测与远程探测共用同一判据）
// 输入示例: "tmux 3.4" / "tmux 3.3a" / "tmux next-3.5"
// 返回主版本、次版本、是否解析成功
func ParseTmuxVersion(s string) (int, int, bool) {
	m := tmuxVersionRe.FindStringSubmatch(s)
	if m == nil {
		return 0, 0, false
	}
	maj, err1 := strconv.Atoi(m[1])
	min, err2 := strconv.Atoi(m[2])
	if err1 != nil || err2 != nil {
		return 0, 0, false
	}
	return maj, min, true
}

// tmux 剪贴板链两档版本地板（P-20261109-7）：
//   - set-clipboard 自 3.2 引入，<3.2 恒 off = 拖选 copy-pipe 源头即不发 OSC 52
//     （拖选复制死源主因；本系统经 conf/运行同步/wrapper 三处显式置 on，但旧版
//     根本无此键，置 on 无效——诚实降级为「受限」提示）
//   - allow-passthrough 自 3.3 引入，3.2 ≤ v < 3.3 时应用（claude code 等）自发
//     OSC 52 经 DCS 包装的透传被吞（应用内复制死源二）
const (
	tmuxFloorOK          = "ok"          // ≥3.3：拖选与应用内复制链全通
	tmuxFloorDragCopy    = "drag-copy"   // <3.2：拖选复制受限（set-clipboard 不存在）
	tmuxFloorPassthrough = "passthrough" // ≥3.2 <3.3：应用内复制透传受限
)

// TmuxClipboardFloorKind 按 tmux -V 输出归类剪贴板能力地板。
// 空串/不可解析返回空串（探测失败静默降级，调用方不显示提示）。
// 纯字符串逻辑无 IO，三平台语义一致。
func TmuxClipboardFloorKind(version string) string {
	if version == "" {
		return ""
	}
	maj, min, ok := ParseTmuxVersion(version)
	if !ok {
		return ""
	}
	if maj < 3 || (maj == 3 && min < 2) {
		return tmuxFloorDragCopy
	}
	if maj == 3 && min < 3 {
		return tmuxFloorPassthrough
	}
	return tmuxFloorOK
}
