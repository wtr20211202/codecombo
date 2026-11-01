package mask

import (
	"regexp"
	"sync"
)

// 自定义敏感模式注册表（P-20261006-11）：用户正则表达的项目自有 secret 形态
// 清单的进程内编译态——设置写路径（system.UpdateSettings）与启动期组合根
// （app.go，SyncCustomAgents 同点位）调 SetCustomPatterns 注入，本包消费方
// 与 store 层敏感面共用：
//   - 快照遮蔽：MaskText / MaskApprovalText 链尾并入（relay/会后总结/检索/
//     分享快照/postmortem 等全部消费点自动生效）；
//   - 终端命令历史：store.IsSensitiveCommand 并入判定（命中整条跳过语义）；
//   - 审计入账脱敏：store.MaskAuditDetail 并入改写（值段 *** 语义）。
//
// 单一权威源是 config（customSensitivePatterns 字段），本注册表只是编译态
// 镜像——写侧已过 ValidateCustomSensitivePatterns（RE2/JS 公共子集、禁内联
// 旗标/空匹配），此处编译失败的坏条目静默跳过兜底（存量脏数据不 panic 不阻
// 塞读取面）。TS 侧对应物是 utils/sensitiveMask.ts 的 setCustomSensitivePatterns
//（同语义编译态，双端一致性由共享语料快照测试锚定）。
//
// 并发面：写是设置保存级低频、读随文本遮蔽中高频——RWMutex 快照读，锁内只
// 取切片头不持锁跑正则。量级考量：条数 ≤ MaxCustomSensitivePatterns（32），
// 每次 MaskText 增至多 32 趟线性扫描，文本都是有界快照/摘要（非流式热路径）。

var customMu sync.RWMutex

// customPatterns 当前生效的自定义模式（编译成功条目；空 = 纯通用表现状）
var customPatterns []*regexp.Regexp

// SetCustomPatterns 整体替换注册表（nil/空 = 清空回落纯通用表现状）。逐条
// 编译，返回成功条数（诊断用途，写路径不依赖）。编译失败跳过不中断——同一
// 列表里一条坏正则不应让其余条目的防护失效
func SetCustomPatterns(patterns []string) int {
	compiled := make([]*regexp.Regexp, 0, len(patterns))
	for _, p := range patterns {
		if re, err := regexp.Compile(p); err == nil {
			compiled = append(compiled, re)
		}
	}
	customMu.Lock()
	customPatterns = compiled
	customMu.Unlock()
	return len(compiled)
}

// CustomPatterns 当前生效模式快照（只读切片，调用方不得改写）
func CustomPatterns() []*regexp.Regexp {
	customMu.RLock()
	defer customMu.RUnlock()
	return customPatterns
}

// MatchCustom 任一自定义模式命中即 true（整条跳过语义的判定面，如命令历史）
func MatchCustom(s string) bool {
	for _, re := range CustomPatterns() {
		if re.MatchString(s) {
			return true
		}
	}
	return false
}

// MaskCustom 全部自定义模式的遮蔽（P-20261006-11）。替换形态分两档（与 TS 侧
// maskSensitive 自定义链同语义，双端一致性语料锚定）：
//   - 无捕获组：命中段整段 → tokenMask（值形态自含的密钥串，如 scrt_[A-Za-z0-9]{20,}）
//   - 有捕获组：命中段替换为第 1 组 + tokenMask——键名/分隔符保留可读（「哪个
//     字段被赋值」的证据面，与内置模式②同哲学；用户以 (键名=)(值形态) 表达）。
//     RE2 与 JS 的 $1 语义一致（未参与组均展开为空串），方言安全
//
// 逐模式顺序应用（与 TS 侧链尾循环同序），前序替换产物对后续模式可见
func MaskCustom(s string) string {
	for _, re := range CustomPatterns() {
		if re.NumSubexp() > 0 {
			s = re.ReplaceAllString(s, "$1"+tokenMask)
		} else {
			s = re.ReplaceAllLiteralString(s, tokenMask)
		}
	}
	return s
}
