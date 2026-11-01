/**
 * 目录右键「在此目录搜索」（P-20261003-118）：由项目相对目录路径合成全工程
 * 搜索面板的 glob 预填值（`<dir>/**`，两个搜索后端同一语义）：
 * - git grep 路径 `-- <pattern>`（server/git/search.go）用 wildmatch，`**` 跨级
 * - rg `-g <pattern>`（server/git/search_rg.go）用 globset，`**` 跨级
 *
 * 目录名可能含 glob 元字符，不转义会被当语法解释出**错误结果**（比搜不到更糟）：
 * - `weird[1]` 的 `[1]` 是字符类 = 只匹配 `weird1`（两后端同）
 * - `a{b}` 的 `{b}` 在 rg globset 是交替组 = 匹配 `ab`
 * - `!lead` 打头在 rg 是「排除该 glob」的否定语法 = 语义反转
 * 统一反斜杠转义（wildmatch 与 globset 转义语法一致，`\x` = 字面 x）。
 *
 * 已知边界（实现期实验如实注记）：Windows 版 git grep 对含 `! { } * ?` 的目录
 * 名连内容扫描都不参与（无 glob 也搜不到），对含 `[ ]` 的目录转义 pathspec
 * 亦不生效——此类目录在该后端下表现为 0 命中（不会给出错误结果）；Linux git
 * 与 rg 下转义语义正确。这是搜索后端的既有限制，本前端无法修补。
 */

/** glob 元字符集（树内目录路径实际可出现的；`\` 仅作防御，路径先归一为 /）。
 *  g 标志必须有：replace 只在带 g 时替换全部命中，否则仅首个元字符被转义 */
const GLOB_META = /[*?[\]{}\\!]/g

export function buildDirGlob(relDir: string): string {
  // 反斜杠归一 + 去首尾斜杠（useEditorAskAgent.askAgentInDirectory 同款惯例：
  // 树内路径恒为 / 分隔，此处防御非常规输入）
  const dir = relDir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!dir) return ''
  const escaped = dir.replace(GLOB_META, (ch) => `\\${ch}`)
  return `${escaped}/**`
}
