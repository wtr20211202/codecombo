package config

import (
	"fmt"
	"regexp"
	"strings"
)

// 自定义敏感模式（P-20261006-11）：通用敏感词表（terminal_history 的
// sensitiveKeyPat/sensitiveValuePat、mask 包的内置模式族）撞不到项目自有
// secret 名（MY_APP_TOKEN=xxx 不被识别）——本清单让用户以正则表达自有敏感面，
// 经既有设置 API（GET/PUT /api/settings 的 customSensitivePatterns 字段）读写，
// Go 侧（命令历史跳过 / 审计脱敏 / 快照遮蔽）与 TS 侧（sensitiveMask 遮蔽链）
// 各自编译同一列表生效，双端一致性由共享语料快照测试锚定（漂移即红）。
//
// 方言纪律（双端同源的前提）：两侧均限 RE2 与 JS RegExp 的公共安全子集——
// 不支持环视/反向引用（RE2 编译期即拒），内联旗标/命名组（(?i)/(?P<name>，
// Go 支持而 JS 不支持或语法不同）由 ValidateCustomSensitivePatterns 在写入口
// 显式拒绝，防「服务端编译通过、前端编译失败静默漏遮」的口径分叉。
//
// 默认空列表 = 纯通用表现状零变化（存量配置缺字段反序列化为 nil，升级零迁移）。

const (
	// MaxCustomSensitivePatterns 模式条数上限：项目自有 secret 形态长尾几十条
	// 足够，上限防设置文档无限膨胀与遮蔽链线性成本失控（与 ApprovalMaxRules
	// 同思路）
	MaxCustomSensitivePatterns = 32
	// CustomSensitivePatternMaxLen 单条正则长度上限：防手粘超长串进设置文档
	//（与 ApprovalOpMax 同族的写入口护栏）
	CustomSensitivePatternMaxLen = 256
)

// ValidateCustomSensitivePatterns 校验自定义敏感模式列表（写入口唯一事实源，
// GET 侧不校验——存量脏数据读容忍不阻塞）。返回 "" 合法，非空为拒绝原因
// （语言中立，进 400 错误消息）。规则：trim 后非空、长度上限、条数上限、
// 无内联旗标/命名组（(? 前缀仅放行非捕获组 (?:）、RE2 可编译、不得匹配空串
// （空匹配会让遮蔽替换在任意位置插 ***，全文糊化且 Go/JS 空匹配推进语义有
// 微妙差异——写入口直接关死）。
func ValidateCustomSensitivePatterns(patterns []string) string {
	if len(patterns) > MaxCustomSensitivePatterns {
		return fmt.Sprintf("too many custom sensitive patterns (max %d)", MaxCustomSensitivePatterns)
	}
	for i, p := range patterns {
		p = strings.TrimSpace(p)
		if p == "" {
			return fmt.Sprintf("custom sensitive patterns[%d] is empty", i)
		}
		if len(p) > CustomSensitivePatternMaxLen {
			return fmt.Sprintf("custom sensitive patterns[%d] too long (max %d bytes)", i, CustomSensitivePatternMaxLen)
		}
		// 内联旗标/命名组/环视统一以 "(?" 前缀识别（环视本就会被下面的
		// RE2 编译拒绝，这里先拦是为了给出可读原因）：仅放行 (?: 非捕获组
		// ——Go 与 JS 语法与语义一致
		if idx := strings.Index(p, "(?"); idx >= 0 && !strings.HasPrefix(p[idx:], "(?:") {
			return fmt.Sprintf("custom sensitive patterns[%d]: inline flags/named groups/lookaround not supported (RE2 & JS common subset only)", i)
		}
		re, err := regexp.Compile(p)
		if err != nil {
			return fmt.Sprintf("custom sensitive patterns[%d]: %v", i, err)
		}
		if re.MatchString("") {
			return fmt.Sprintf("custom sensitive patterns[%d] must not match the empty string", i)
		}
	}
	return ""
}

// NormalizeCustomSensitivePatterns 归一化列表（写入口落盘前调用，与读取侧
// 同口径）：逐条 trim、丢弃 trim 后为空的条目。不做编译校验（校验是
// ValidateCustomSensitivePatterns 的职责，两步在 UpdateSettings 顺序执行）
func NormalizeCustomSensitivePatterns(patterns []string) []string {
	out := make([]string, 0, len(patterns))
	for _, p := range patterns {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
