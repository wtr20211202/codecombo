/**
 * 项目驻留路径判定（P-20261006-36，纯函数）：kind=agent 会话免项目绑定
 * （projectId 恒空），但常在项目目录里启动——删除项目时这类会话是知情面
 * 与可选级联关闭的对象。与服务端 server/terminal/residency.go 同语义同边界：
 * 词法前缀匹配、不 resolve symlink；前缀失配只意味着「不计入、不级联」，
 * 与既有行为一致不恶化。
 *
 * 与服务端的刻意差异：不做大小写折叠——前端禁「大小写不敏感路径」这一
 * Windows-only 假设（CLAUDE.md 全平台纪律）。两侧路径均来自服务端原样快照
 * （会话创建 dir / 项目注册根）；大小写失配时前端只少计不误计（知情面偏
 * 保守方向），服务端级联按其平台语义匹配，不受前端口径影响。
 */

/** 归一为可比较形态：反斜杠统一为 '/'、折叠重复分隔符、解析 . / .. 段、
 * 收敛盘符根尾分隔符（D:/ → D:，与服务端 slashClean 同构）；返回 null =
 * 相对/空等不可比形态（从严不计） */
function normalizeComparable(p: string | undefined | null): string | null {
  const raw = (p ?? '').trim()
  if (!raw) return null
  // 先折算分隔符再判绝对形态（UNC 的前导 \\ 折算后才是根）——与服务端
  // normalizeComparePath 的先后次序一致
  const converted = raw.replace(/\\/g, '/')
  const abs = converted.startsWith('/')
  const segs = converted.split('/')
  const out: string[] = []
  for (const seg of segs) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      // 越根的 .. 形态异常；相对形态本已被下面绝对性检查拒绝，收敛结果无消费方
      if (out.length > 0) out.pop()
      continue
    }
    out.push(seg)
  }
  const cleaned = (abs ? '/' : '') + out.join('/')
  // 绝对形态：POSIX 根开头，或 Windows 盘符前缀（形如 C:/，含 //server/share
  // 的 UNC 形态——首字符即 '/'）
  if (cleaned.startsWith('/') || (cleaned.length >= 2 && cleaned[1] === ':')) return cleaned
  return null
}

/** dir 是否驻留在 root 内（含 root 本身）。任一侧不可比（相对路径/空）一律 false */
export function pathResidesIn(dir: string | undefined | null, root: string | undefined | null): boolean {
  const d = normalizeComparable(dir)
  const r = normalizeComparable(root)
  if (!d || !r) return false
  if (d === r) return true
  if (r === '/') return true // POSIX 根目录包含一切绝对路径
  return d.startsWith(r + '/')
}
