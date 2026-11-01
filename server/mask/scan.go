package mask

import "regexp"

// 出域敏感内容扫描（P-20261004-113）：会话导出（md/jsonl）与终端输出导出
// 三处出域面共用同一检测链——命中只回「类型 + 计数」，绝不回原文/值段
// （警示是知情过闸，不是把敏感值再抄一遍给客户端/agent）。
//
// 模式来源分两层，均为既有单源复用而非第三套正则族：
//   - 内置遮蔽面 ①~④ 直接复用 mask.go/redact.go 的编译产物（sc 令牌、赋值
//     形态、云密钥、已知厂商前缀）；
//   - 提案点名的 useAgentFix SENSITIVE_PATTERNS（web/src/composables/
//     useAgentFix.ts）里的 URL 内嵌凭据 / 私钥块 / Bearer 令牌三种形态在
//     Go 侧遮蔽面没有对应物，本文件补三条「仅检测不遮蔽」正则（检测面允许
//     是遮蔽面的超集：误报可继续，漏报才是漏洞）。改 TS 清单须同步此处。
//
// 刻意不做高熵长串（redact.go ⑤）检测：⑤是审批文本遮蔽启发式，长 base64
// /代码标识符误报面大；出域闸每误报一次都要用户多确认一次，提案的「误报
// 宁多不漏」以显式凭据形态为界，高熵留给建议标记链（P-20261003-207）。
// 自定义敏感模式（P-20261006-11，custom.go 注册表）是用户显式声明的项目
// secret 形态，并入检测面（类型 custom-pattern）。

// 内容命中类型（稳定 token：前端 i18n 标签按此映射，未知类型回退原文——
// 服务端增类型不破坏旧前端）。
const (
	HitPlatformToken    = "platform-token"    // sc?_ 平台令牌（sca_/scl_/sc_ap_ 等）
	HitKnownToken       = "known-token"       // 已知厂商前缀令牌（GitHub/OpenAI/Stripe/GitLab/Slack/npm）
	HitAWSAccessKey     = "aws-access-key"    // AWS 访问密钥 ID（AKIA/ASIA）
	HitSecretAssignment = "secret-assignment" // 口令/密钥赋值形态
	HitURLCredentials   = "url-credentials"   // URL 内嵌 user:pass@
	HitPrivateKey       = "private-key"       // PEM 私钥块
	HitBearerToken      = "bearer-token"      // Bearer 令牌
	HitCustomPattern    = "custom-pattern"    // 用户自定义敏感模式
)

// scanCountCap 单类型计数上限：警示只用于「有没有/大概多少」，超出上限的
// 计数不改变决策（防病态内容把计数器撑大；扫描本身仍是线性单趟）
const scanCountCap = 9999

// 检测面补充正则（遮蔽面无对应物，理由见文件头注）
var (
	urlCredentialRe   = regexp.MustCompile(`://[^\s/:@]+:[^\s/@]+@`)
	privateKeyRe      = regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----`)
	bearerTokenRe     = regexp.MustCompile(`(?i)\bBearer\s+[A-Za-z0-9._~-]{16,}`)
	assignSecretKeyRe = regexp.MustCompile(`(^|[^A-Za-z0-9_])(?i:(secret|api[_-]?key))(["']?[ \t]*[=:][ \t]*)(?:"[^"]*"|'[^']*'|[^\s"']+)`)
)

// ContentHit 单个检测类型的命中计数（类型为稳定 token；JSON 序列化只有
// type/count 两键——结构上杜绝原文出闸）
type ContentHit struct {
	Type  string `json:"type"`
	Count int    `json:"count"`
}

// contentScanPatterns 检测表（顺序即输出顺序，确定性）。同一段文本命中多条
// 不同形态时按类型分别计数（如 token=ghp_… 同时是赋值与已知令牌，两个类型
// 各计一次——类型是观测面，不是去重键）
var contentScanPatterns = []struct {
	typ string
	re  *regexp.Regexp
}{
	{HitPlatformToken, scTokenRe},
	{HitKnownToken, secretTokenRe},
	{HitAWSAccessKey, awsKeyRe},
	{HitSecretAssignment, assignSecretRe},
	{HitSecretAssignment, assignSecretKeyRe},
	{HitURLCredentials, urlCredentialRe},
	{HitPrivateKey, privateKeyRe},
	{HitBearerToken, bearerTokenRe},
}

// ScanContent 对一段完整文本跑内容凭据形态检测，返回命中类型与计数
// （只含类型/计数，不含原文）。无命中返回 nil——调用方按 len==0 判零打扰。
// 逐趟 RE2 线性扫描，文本量级 = 导出内容（md ≤8MB / 终端 scrollback ≤16MB /
// jsonl 逐行），显式导出动作下一次全扫的成本可接受（JSONL 侧见 handler 的
// 下游逐行扫描注记）
func ScanContent(text string) []ContentHit {
	if text == "" {
		return nil
	}
	var out []ContentHit
	for _, p := range contentScanPatterns {
		n := countMatches(p.re, text)
		if n > 0 {
			out = appendHit(out, p.typ, n)
		}
	}
	// 自定义模式：逐条计数后在 custom-pattern 汇总（一条文本同时命中多条
	// 自定义规则时计数累加，类型面保留「用户自定义」这一个语义）
	custom := 0
	for _, re := range CustomPatterns() {
		custom += countMatches(re, text)
	}
	if custom > 0 {
		out = appendHit(out, HitCustomPattern, custom)
	}
	return out
}

// appendHit 把同类型计数合并进结果（检测表允许同类型多模式，如赋值形态的
// 内置键名与扩展键名两趟）
func appendHit(out []ContentHit, typ string, count int) []ContentHit {
	for i := range out {
		if out[i].Type == typ {
			out[i].Count += count
			if out[i].Count > scanCountCap {
				out[i].Count = scanCountCap
			}
			return out
		}
	}
	if count > scanCountCap {
		count = scanCountCap
	}
	return append(out, ContentHit{Type: typ, Count: count})
}

// countMatches 单趟计数。n 上限走 FindAllStringIndex 的 limit 参数——匹配
// 位置按原文整串求值（^ 锚点语义不会被分段重锚），返回切片有界（≤cap 个
// [2]int，单趟瞬态 ≈160KB），不随命中数无界增长
func countMatches(re *regexp.Regexp, text string) int {
	return len(re.FindAllStringIndex(text, scanCountCap))
}
