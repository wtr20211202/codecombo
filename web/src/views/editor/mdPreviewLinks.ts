/**
 * md 预览链接导航（P-20261003-108）的纯解析层：把预览 HTML 里 <a href> 的
 * 相对 / 根相对链接折叠为项目相对路径（正斜杠），供 MonacoEditor 的预览容器
 * click 委托经 OPS_OPEN_FILE_AT 既有打开链开进编辑器（终端文件链接同口径）；
 * 页内锚点（# 开头）由 resolveMdAnchorTarget 折叠为 fragment，供跳转分流
 * （P-20261007-7 二阶段兑现）。
 * 纯函数零依赖，路径折叠边界（./ ../ 越根 / 锚点与查询剥离 / 协议排除）
 * 全部在 mdPreviewLinks.test.ts 单测覆盖。
 */

/** 仓内文档导航认的扩展名（与 MonacoEditor isMarkdown 同口径：md / markdown） */
export function isMdPath(p: string): boolean {
  const ext = p.split('.').pop()?.toLowerCase()
  return ext === 'md' || ext === 'markdown'
}

/**
 * 解析页内锚点 href（P-20261007-7）：'#foo' → 'foo'；非锚点形态（无 # 前缀）
 * 与空 fragment（'' / '#'）返回 null——调用方据此分流到锚点跳转 / 其余导航。
 * marked 对非 ASCII href 走 encodeURI（中文锚点成 #%E7%AC%AC… 形态），percent
 * 解码先行；畸形编码（裸 % 等）按原文匹配，与 resolveMdLinkTarget 同一容忍口径。
 */
export function resolveMdAnchorTarget(rawHref: string): string | null {
  const href = (rawHref || '').trim()
  if (!href.startsWith('#')) return null
  const frag = href.slice(1)
  if (!frag) return null
  try {
    return decodeURIComponent(frag)
  } catch {
    return frag
  }
}

/**
 * 解析 md 预览里的链接目标，可导航返回项目相对路径，否则返回 null（保持死链）：
 * - '' / '#fragment' → null（纯页内锚点走 resolveMdAnchorTarget 分流，P-20261007-7）
 * - 带协议形态（http(s):// 由调用方分流新标签，mailto: 等直接忽略）→ null
 * - 相对（./a.md、../b.md、docs/c.md）按当前文件所在目录折叠；/ 开头根相对按项目根
 * - 尾部 #fragment / ?query 先剥离再折叠（docs/x.md#节 先开文件，fragment 不跟随）
 * - .. 越过基准根（项目外落点）/ 折叠后空 / 非 md 扩展名 → null（防穿越防误开二进制）
 * 反斜杠归一为正斜杠：URL 语义跨平台一致（useFileDeepLink 同口径）；
 * href 里的 percent 编码（marked 对空格等字符的编码产物）先解码再折叠。
 */
export function resolveMdLinkTarget(currentPath: string, rawHref: string): string | null {
  // 当前文件路径同口径归一：项目相对路径约定正斜杠（openFile 链既有口径），
  // 防御性容忍历史调用方混入的反斜杠
  const base = (currentPath || '').replace(/\\/g, '/')
  const href = (rawHref || '').trim().replace(/\\/g, '/')
  if (!href || href.startsWith('#')) return null
  // 带协议形态（http/https/mailto/…）都不是仓内相对路径；外链由调用方先行分流
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null
  // 剥离 fragment / query（取两者中最早出现的切点）
  const hashIdx = href.indexOf('#')
  const queryIdx = href.indexOf('?')
  let cut = href.length
  if (hashIdx >= 0) cut = Math.min(cut, hashIdx)
  if (queryIdx >= 0) cut = Math.min(cut, queryIdx)
  let core = href.slice(0, cut)
  if (!core) return null
  try {
    core = decodeURIComponent(core)
  } catch {
    // 畸形编码（裸 % 等）按原文折叠：文件名含字面 % 的形态不受影响
  }
  // 根相对以项目根为基（空段序列）；否则以当前文件所在目录为基（去尾段）
  const segs = core.startsWith('/') ? [] : currentPath.split('/').slice(0, -1)
  for (const part of core.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      // 越过基准根 = 项目外落点（防穿越）：不导航
      if (segs.length === 0) return null
      segs.pop()
      continue
    }
    segs.push(part)
  }
  const target = segs.join('/')
  if (!target || !isMdPath(target)) return null
  return target
}
