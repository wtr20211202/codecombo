package files

import (
	"fmt"
	"strings"
)

// windowsReservedDevices Windows 保留设备名清单（大小写不敏感）。这些名字在
// Windows 上无论带不带扩展名（CON.txt 的主干 CON 命中即保留）都是设备名：
// 一端（Linux 宿主）创建成功后，Windows 宿主检出即无法使用/无法删除——
// 「一端创建、三端爆炸」的仓库名字地雷，创建入口直接拒绝
var windowsReservedDevices = func() map[string]struct{} {
	names := []string{"CON", "PRN", "AUX", "NUL"}
	for i := 1; i <= 9; i++ {
		names = append(names, fmt.Sprintf("COM%d", i), fmt.Sprintf("LPT%d", i))
	}
	m := make(map[string]struct{}, len(names))
	for _, n := range names {
		m[n] = struct{}{}
	}
	return m
}()

// validateNameCompat 文件名跨平台兼容性校验（P-20261002-132）：对相对路径逐段
// 检查——① Windows 保留设备名（主干命中即拒，大小写不敏感）；② 段结尾点/空格
// （Windows 文件系统原生拒绝，Linux 上可创建但跨端不可用）。仅校验段结尾与
// 保留名两项，不拦正常名（名字内部含点/空格、开头点等均放行）；".." 段由
// SafeJoinProject 拒绝，此处跳过。错误文本以稳定前缀「invalid file name: 」
// 开头（前端 errors.known.invalidFileName 识别口径），原文随 rawMessage 透传
func validateNameCompat(rel string) error {
	for _, seg := range strings.Split(rel, "/") {
		if seg == "" || seg == "." || seg == ".." {
			continue
		}
		if reason := segmentCompatIssue(seg); reason != "" {
			return fmt.Errorf("invalid file name: %s (%s)", seg, reason)
		}
	}
	return nil
}

// segmentCompatIssue 单段校验：命中返回可读原因，正常名返回空串
func segmentCompatIssue(seg string) string {
	if isWindowsReservedDevice(seg) {
		return "reserved Windows device name"
	}
	if strings.HasSuffix(seg, ".") || strings.HasSuffix(seg, " ") {
		return "name must not end with a dot or space"
	}
	return ""
}

// isWindowsReservedDevice 主干（首个点之前）命中保留设备名即保留——
// CON.txt / con.tar.gz / LPT9 均拒，constant.go 等主干非保留名不受影响
func isWindowsReservedDevice(seg string) bool {
	base := seg
	if idx := strings.IndexByte(base, '.'); idx >= 0 {
		base = base[:idx]
	}
	_, ok := windowsReservedDevices[strings.ToUpper(base)]
	return ok
}
