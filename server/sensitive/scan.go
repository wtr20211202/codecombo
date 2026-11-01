// Package sensitive 出域敏感扫描收口（P-20261004-113）：会话导出 md/jsonl
// 与终端输出导出三处出域面共用同一检测链，命中只回「类型 + 计数」不附原文。
//
// 双模式表（提案口径）在此单点组合，两个模式表的权威源各自只有一处：
//   - 文件名级：server/share 的 sensitivePatterns（P-26 单一事实源，分享扫描 /
//     补丁导出 / 外部改动审计同表）——此处只对内容里出现的路径 token 取
//     basename 调用 share.IsSensitiveName，不复制模式表；
//   - 内容凭据形态：server/mask 的 ScanContent（内置遮蔽面 ①~④ + 提案点名的
//     useAgentFix 显式凭据形态 + 自定义敏感模式，见 mask/scan.go 头注）。
//
// 为什么文件名模式也扫内容：会话里贴过「cat .env / id_rsa 的路径 / 证书文件名」
// 本身就是凭据面线索，与内容值扫描互补；误报由「确认后可继续」吸收（警示是
// 知情过闸，不拦截、不遮蔽——默认原样保真语义不变）。
package sensitive

import (
	"regexp"
	"sort"
	"strings"

	"codecombo/server/mask"
	"codecombo/server/share"
)

// HitSensitiveFileName 内容里出现敏感文件名（文件名级模式命中）的类型标记
const HitSensitiveFileName = "sensitive-file-name"

// 内容凭据形态类型从 mask 单源转出（消费方只依赖本包，不必同时 import mask；
// 值即 mask 的稳定 token，两处不可能漂移）
const (
	HitPlatformToken    = mask.HitPlatformToken
	HitKnownToken       = mask.HitKnownToken
	HitAWSAccessKey     = mask.HitAWSAccessKey
	HitSecretAssignment = mask.HitSecretAssignment
	HitURLCredentials   = mask.HitURLCredentials
	HitPrivateKey       = mask.HitPrivateKey
	HitBearerToken      = mask.HitBearerToken
	HitCustomPattern    = mask.HitCustomPattern
)

// Hit 单个命中类型计数（与 mask.ContentHit 同形；包级类型便于三处导出
// handler 统一签名，JSON 只有 type/count 两键）
type Hit struct {
	Type  string `json:"type"`
	Count int    `json:"count"`
}

// filenameTokenRe 内容里的文件名/路径 token（字母数字 + 下划线/点/路径分隔符）。
// 不含冒号/引号/空白——URL 的 `https://` 前缀与 JSON 标点自然切段；分隔符
// 两种形态都纳入（win 反斜杠 / 正斜杠），basename 取最后一段
var filenameTokenRe = regexp.MustCompile(`[A-Za-z0-9_.\\/-]+`)

// hitOrder 输出顺序（确定性：前端列表与审计 Detail 顺序稳定）；未知类型
// （未来新增）排后按字母序
var hitOrder = []string{
	mask.HitPlatformToken,
	mask.HitKnownToken,
	mask.HitAWSAccessKey,
	mask.HitSecretAssignment,
	mask.HitURLCredentials,
	mask.HitPrivateKey,
	mask.HitBearerToken,
	HitSensitiveFileName,
	mask.HitCustomPattern,
}

// ScanContent 单段文本的全模式扫描（导出内容 ≤ 单次导出体量，显式动作下
// 一趟全扫可接受）。无命中返回 nil
func ScanContent(text string) []Hit {
	if text == "" {
		return nil
	}
	var c Counter
	c.AddText(text)
	return c.Hits()
}

// Counter 流式汇总器（JSONL 逐行扫描用：逐行 AddText，末尾 Hits 一次成型；
// 逐行调用避免整文件驻留内存）
type Counter struct {
	counts map[string]int
}

// AddText 追加一段文本的命中计数
func (c *Counter) AddText(text string) {
	if text == "" {
		return
	}
	for _, h := range mask.ScanContent(text) {
		c.add(h.Type, h.Count)
	}
	if n := countFilenameMentions(text); n > 0 {
		c.add(HitSensitiveFileName, n)
	}
}

// AddHits 并入既有命中（合并两个 Counter 的中间结果）
func (c *Counter) AddHits(hits []Hit) {
	for _, h := range hits {
		c.add(h.Type, h.Count)
	}
}

func (c *Counter) add(typ string, n int) {
	if n <= 0 {
		return
	}
	if c.counts == nil {
		c.counts = make(map[string]int)
	}
	c.counts[typ] += n
}

// Hits 计数表转稳定顺序的命中清单（空表返回 nil）
func (c *Counter) Hits() []Hit {
	if len(c.counts) == 0 {
		return nil
	}
	out := make([]Hit, 0, len(c.counts))
	for typ, n := range c.counts {
		out = append(out, Hit{Type: typ, Count: n})
	}
	sort.SliceStable(out, func(i, j int) bool {
		ri, rj := hitRank(out[i].Type), hitRank(out[j].Type)
		if ri != rj {
			return ri < rj
		}
		return out[i].Type < out[j].Type
	})
	return out
}

// hitRank 固定顺序下标（未知类型 = 表长，触发字母序兜底）
func hitRank(typ string) int {
	for i, t := range hitOrder {
		if t == typ {
			return i
		}
	}
	return len(hitOrder)
}

// Summary 命中摘要（审计 Detail 用量级元数据）：`known-token×2, private-key×1`。
// 只含类型与计数——审计台账的内容纪律同款（内容/原文绝不入账）
func Summary(hits []Hit) string {
	if len(hits) == 0 {
		return ""
	}
	var b strings.Builder
	for i, h := range hits {
		if i > 0 {
			b.WriteString(", ")
		}
		b.WriteString(h.Type)
		b.WriteString("×")
		b.WriteString(itoa(h.Count))
	}
	return b.String()
}

// itoa 小整数转十进制（避免为摘要引入 strconv 依赖面的噪音；计数 ≤ 9999）
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [8]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

// countFilenameMentions 内容里命中文件名级敏感模式的 token 数（计数上限
// 同 mask 侧：警示只需要量级）。每个 token 取最后一段分隔符后的 basename，
// 判定复用 share.IsSensitiveName（大小写不敏感 / path.Match 口径单源）
func countFilenameMentions(text string) int {
	const countCap = 9999
	n := 0
	for len(text) > 0 && n < countCap {
		loc := filenameTokenRe.FindStringIndex(text)
		if loc == nil {
			break
		}
		tok := text[loc[0]:loc[1]]
		text = text[loc[1]:]
		if i := strings.LastIndexAny(tok, `/\`); i >= 0 {
			tok = tok[i+1:]
		}
		if tok != "" && share.IsSensitiveName(tok) {
			n++
		}
	}
	return n
}
