/**
 * 敏感值遮蔽共享模块（P-20261002-108）：
 * 审批录制/回放体系的内容安全底线——遮蔽模式集的唯一权威定义，双侧统一：
 *   - 回放渲染层（前端兜底）：utils/recording parseCast 对事件文本/章节标签
 *     二次遮蔽（服务端 tap 写盘前已遮蔽，此处双保险）；
 *   - 录制侧（服务端 tap 写盘前）：server/mask/mask.go 流式遮蔽器（P-108，
 *     P-20261003-197 起自 recording 包平移独立成包，见其头注）——
 *     Go 与 TS 无法跨语言共享代码，该文件按本文件模式集逐条对齐（正则语义
 *     一一对应），双侧单测以同一 fixture 语料互锁（sensitiveMask.test.ts ↔
 *     mask_test.go）。改任何一侧的模式集必须同步另一侧与双侧单测。
 *
 * 模式集（顺序即应用顺序，双侧一致；命中段 → ***）：
 *   1. sc[a-z]_[A-Za-z0-9]+ —— sc?_ 系标识整段：sca_ 智能体令牌 / scl_ 解锁
 *      令牌 / sc_ap_ 审批 ID 等（store/agenttoken.go 前缀约定）
 *   2. password/passwd/pwd/token 赋值形态（不区分大小写）：键名与分隔符保留
 *      （保留「哪个字段被赋值」的证据可读性），值整段替换——覆盖 shell
 *      KEY=value、YAML/JSON "key": "value" 引号形态；词边界为三态（文本起点 /
 *      非词字符 / ANSI SGR 序列）——终端着色回显把 SGR 紧贴键名（PSReadLine
 *      `\x1b[37mPASSWORD=`），SGR 尾字节 'm' 是词字节，普通 \b 必漏
 *   3. (起点|非词字符|SGR)(AKIA|ASIA)[A-Z0-9]{16}\b —— AWS 访问密钥 ID
 *      （AKIA 长期 / ASIA 临时），尾部词边界防吃进更长非密钥串
 */

export const SENSITIVE_MASK = '***'

// ① sc?_ 系标识（与 mask.go maskPatterns[0] 对齐；无词边界——令牌在任意
// 上下文出现都整段遮蔽）
const SC_TOKEN_RE = /sc[a-z]_[A-Za-z0-9]+/g

// ② 赋值形态（与 mask.go maskPatterns[1] 对齐）：捕获 1=边界（SGR 序列整段
// 保真还原）2=键名 3=分隔符（含键后可选引号与两侧空白），值三形态：双引号 /
// 单引号 / 裸词（到空白或引号止）——替换保留 $1$2$3、值落 ***
// eslint-disable-next-line no-control-regex -- \x1b 为 ANSI SGR 序列头，控制字符即匹配目标
const ASSIGN_RE = /(^|[^A-Za-z0-9_]|\x1b\[[0-9;]*m)(password|passwd|pwd|token)(["']?[ \t]*[=:][ \t]*)(?:"[^"]*"|'[^']*'|[^\s"']+)/gi

// ③ 云访问密钥（与 mask.go maskPatterns[2] 对齐）：定长 20、大写、同款三态
// 起始边界 + 尾部词边界——防止吃进更长的非密钥串
// eslint-disable-next-line no-control-regex -- \x1b 为 ANSI SGR 序列头，控制字符即匹配目标
const CLOUD_KEY_RE = /(^|[^A-Za-z0-9_]|\x1b\[[0-9;]*m)(?:AKIA|ASIA)[A-Z0-9]{16}\b/g

/** 敏感值遮蔽（事件文本 / 章节标签 / 元数据展示共用；全量文本、非流式）。
 *  内置模式集之后链尾并入自定义敏感模式（setCustomSensitivePatterns 注入，
 *  空列表零变化）——审批面兜底（maskApprovalSecrets）与会话出域检测
 *（secretHintInTail）打底于本函数，自定义模式自动流入全部消费点 */
export function maskSensitive(s: string): string {
  let out = s
    .replace(SC_TOKEN_RE, SENSITIVE_MASK)
    .replace(ASSIGN_RE, `$1$2$3${SENSITIVE_MASK}`)
    .replace(CLOUD_KEY_RE, `$1${SENSITIVE_MASK}`)
  for (const re of customSensitiveRes) {
    // 替换形态与 Go 侧 mask.MaskCustom 同语义（双端一致性语料锚定）：有捕获
    // 组保留第 1 组（键名/分隔符可读）值段 ***；无捕获组命中段整段 ***
    out = out.replace(re, customGroupCount.get(re) ? `$1${SENSITIVE_MASK}` : SENSITIVE_MASK)
  }
  return out
}

// ============== 自定义敏感模式（P-20261006-11，双端同源） ==============
// 用户正则表达的项目自有 secret 形态清单（设置·安全分区维护，单一权威源是
// 服务端 config 的 customSensitivePatterns 字段，经 GET /settings 下发）。
// 编译态是模块级注入：composables/useCustomSensitivePatterns 在 OpsChannelBridge
// 挂载与 settings.changed 广播时拉取刷新，本模块全部消费点（遮蔽链/出域检测）
// 自动生效。Go 侧对应物是 server/mask 的 SetCustomPatterns 注册表（MaskText/
// 审计/命令历史同源消费），双端一致性由共享语料快照互锁（custom_patterns_
// corpus.json ↔ corpus_test.go）。
//
// 方言纪律（与服务端写入口 config.ValidateCustomSensitivePatterns 同口径）：
// 列表停留在 RE2 与 JS RegExp 公共子集（禁内联旗标/命名组/环视/反向引用/
// 空匹配），服务端 400 拒绝不合法条目；此处编译失败静默跳过兜底（旧服务端
// 或脏数据不致命），且捕获组数用「附加空 alternation 必空匹配」技巧精确
// 统计（RegExp 无组数元数据；字符类内的 ( 不误计）

const customSensitiveRes: RegExp[] = []
/** 每条自定义正则的捕获组数（0 = 整段遮蔽形态），与 customSensitiveRes 对位 */
const customGroupCount = new Map<RegExp, number>()

/** 注入自定义敏感模式（整体替换语义；空数组 = 清空回落纯通用表现状）。
 *  编译失败条目跳过不中断——同一列表里一条坏正则不应让其余防护失效 */
export function setCustomSensitivePatterns(patterns: string[]): void {
  customSensitiveRes.length = 0
  customGroupCount.clear()
  for (const p of patterns) {
    try {
      const re = new RegExp(p, 'g')
      const groups = new RegExp(`${p}|`).exec('')!.length - 1
      customSensitiveRes.push(re)
      customGroupCount.set(re, groups)
    } catch { /* 服务端已校验；坏条目跳过 */ }
  }
}

// ============== 审批面密钥脱敏（P-20261003-197） ==============
// 审批 Target/Detail/impact 是 agent 拼的自由文本，常携带命令原文（curl -H
// "Authorization: Bearer sk-…"）——服务端两条审批创建路径入库前已过
// server/mask 包的 MaskApprovalText（MaskText 同源打底 + 下列 ④⑤，记录/
// 广播/webhook 外发同源收敛）。此处是展示面兜底：审批卡与值班大屏渲染、
// op+target 复制出口对「旧记录补账（seedPending 拉历史 pending）/广播链
// 回归」双保险——卡面永不出现明文密钥。
//
// 与录制回放兜底（上方 maskSensitive）分面不分家：④⑤只服务审批面，不进
// 回放模式集（录制证据内容不因审批面扩模式而改变），与 Go 侧 redact.go
// 逐条对齐；改任何一侧必须同步另一侧与双侧单测（sensitiveMask.test.ts ↔
// server/mask/redact_test.go 同一语料互锁）。

// ④ 已知密钥前缀（与 server/mask/redact.go secretTokenRe 对齐）：sk-（OpenAI
// 系，含 sk-proj-/sk-ant-）/ sk_live_|sk_test_（Stripe）/ gh?_（GitHub
// ghp_/gho_/ghu_/ghs_/ghr_）/ github_pat_ / glpat-（GitLab）/ xox?-（Slack）/
// npm_。起始三态边界同模式②——「task-2024…」这类连字 ID 的 "sk-" 嵌段
// （前接词字符）不误遮；值段 ≥12（真 token 值体远长于此）
const SECRET_TOKEN_RE = /(^|[^A-Za-z0-9_])(?:github_pat_|sk_live_|sk_test_|gh[a-z]_|glpat-|xox[a-z]-|npm_|sk-)[A-Za-z0-9_-]{12,}/g

// ⑤ 高熵长串候选（与 server/mask/redact.go highEntropyRe 对齐）：≥20 连续
// 密钥字符集。刻意不含 / \（路径段不粘成超长候选——审批 target 常是路径）
// 与 =（键名保持完整可读）；是否真密钥由 maskHighEntropyRun 的类别校验判定
const HIGH_ENTROPY_RE = /[A-Za-z0-9+_-]{20,}/g

/** 遮蔽替换保留的尾部可读字符数（④⑤同值，与 Go 侧 secretTailKeep 一致） */
const SECRET_TAIL_KEEP = 4

// ④ 替换：前缀（含）保留作「首」，值段 *** + 尾 4——「sk-***I789」形态
// （类型可读、可对账不可重放）。匹配含边界字符时（非文本起点）边界原样还原
function maskSecretToken(m: string): string {
  const boundary = /^[sgxn]/.test(m) ? '' : m.slice(0, 1)
  const body = boundary ? m.slice(1) : m
  const pref = SECRET_TOKEN_PREFIXES.find((p) => body.startsWith(p)) ?? ''
  const value = body.slice(pref.length)
  const tail = value.length > SECRET_TAIL_KEEP ? value.slice(-SECRET_TAIL_KEEP) : value
  return boundary + pref + SENSITIVE_MASK + tail
}

// 前缀字面量表（长前缀在前——find 取首个 startsWith 命中即最长匹配；与
// server/mask/redact.go secretPrefixes 逐条对齐）
const SECRET_TOKEN_PREFIXES = [
  'github_pat_', 'sk_live_', 'sk_test_',
  'ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'glpat-',
  'xoxa-', 'xoxb-', 'xoxp-', 'xoxr-', 'xoxs-',
  'npm_', 'sk-',
]

// ⑤ 替换：大写+小写+数字三类齐备才判密钥——git SHA（纯 hex）/纯数字/普通
// 单词（缺类别）零误伤；命中保首 4 尾 4（误判容忍：原文骨架仍可辨认）
function maskHighEntropyRun(m: string): string {
  const hasUpper = /[A-Z]/.test(m)
  const hasLower = /[a-z]/.test(m)
  const hasDigit = /[0-9]/.test(m)
  if (!hasUpper || !hasLower || !hasDigit) return m
  return m.slice(0, SECRET_TAIL_KEEP) + SENSITIVE_MASK + m.slice(-SECRET_TAIL_KEEP)
}

/** 审批面密钥脱敏（P-108 全量模式集打底 + ④已知前缀 ⑤高熵长串；全量文本）。
 *  卡面/大屏渲染与 op+target 复制出口共用本入口 */
export function maskApprovalSecrets(s: string): string {
  return maskSensitive(s)
    .replace(SECRET_TOKEN_RE, maskSecretToken)
    .replace(HIGH_ENTROPY_RE, maskHighEntropyRun)
}

// ============== 会话出域敏感内容自动检测（P-20261003-207） ==============
// 导出动作落地后对会话输出做密钥正则扫描，命中即建议「标记敏感?」（建议非
// 闸门——提示可跳过，误报容忍，弹窗与标记链收口在 composables/useSensitiveMarkHint）。
// 检测不做第二套模式集：直接复用 maskApprovalSecrets 全量模式集（①~⑤）做
// 差分判定（遮蔽后文本 ≠ 原文 ⇔ 命中任一模式）——模式集演进自动流入检测，
// 无双实现漂移面。尾部抽样而非全扫：会话输出可能远超窗口，尾部是最近的
// （最可能刚贴过凭据的）片段，有界扫描是提案明确的性能边界

/** 尾部抽样窗口（UTF-16 码元，非字节——多字节内容下等效字节量更大但仍有
 *  界；量级考量：64K 码元 × 5 趟正则 ≈ 亚毫秒，导出后异步执行零体感） */
export const SECRET_HINT_TAIL_CHARS = 64 * 1024

/** 会话输出尾部抽样内是否命中密钥模式（P-20261003-207 建议提示的判定面）。
 *  切片起点可能腰斩跨窗令牌（漏报，容忍）或把窗内词首误当文本起点（三态
 *  边界，误报，同样容忍——提示非强制，用户有「跳过」出口） */
export function secretHintInTail(text: string): boolean {
  const sample = text.length > SECRET_HINT_TAIL_CHARS ? text.slice(-SECRET_HINT_TAIL_CHARS) : text
  return maskApprovalSecrets(sample) !== sample
}
