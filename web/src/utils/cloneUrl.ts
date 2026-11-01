/**
 * 克隆 URL 形态校验（P-20261003-70）纯函数：禁空白/全角字符 + 形态表从宽。
 * 与服务端 server/api/gitops/clone.go precheckCloneURL 同清单同语义（克隆入口
 * 双端兜底，同 fileNameCompat 家族：前端行内输入即时红提示，服务端 400 拒绝
 * 直达 API 的调用方）。从宽原则——宁可漏报不误拦：
 *   - scheme:// 长形放行：http(s)://…、ssh://git@host[:port]/path（自定义端口）、
 *     file://、git://…（任意 RFC 3986 scheme，后半段不细查）；
 *   - SCP 短形 user@host:path；
 *   - 本地路径形态（绝对路径/UNC、Windows 盘符、./ ../、~）——既有单测与 e2e
 *     用本地路径与 file:// 作克隆 URL，必须放行。
 */

/** 合法形态表（与服务端 cloneURLFormRe 同式） */
const CLONE_URL_FORM_RE = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/|[^\s@]+@[^\s@:]+:|\.{1,2}[/\\]|[/\\]|[A-Za-z]:[/\\]|~)/

/**
 * 粘贴建议形态（P-20261003-170）：只认「远程形态」——scheme:// 长形（取
 * CLONE_URL_FORM_RE 第一支，任意 RFC 3986 scheme，file:// 等合法克隆源同样
 * 建议）或 SCP 短形 user@host:path（锚定 ^，@ 前后禁空白、host 段禁冒号）。
 * 与 CLONE_URL_FORM_RE 刻意相反：这里绝不含本地路径形态（盘符/UNC/./ ~/），
 * 锚定协议前缀防误报——本地路径粘贴绝不弹建议。
 */
const GIT_URL_HINT_RE = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/|[^\s@]+@[^\s@:]+:)/

/**
 * 粘贴建议检测（P-20261003-170）：本地 tab 粘贴内容是否呈远程 URL 形态，
 * 命中则行内建议一键切到克隆 tab 并预填。与 isValidCloneUrl 的「从宽放行
 * 本地路径」相反——此处宁可漏报不误弹（误弹成本低但打断感真实存在）；
 * 形态不合法但带协议前缀（如含空格的 https://）也提示，交由克隆 tab 既有的
 * cloneUrlInvalid 行内红提示兜底反馈。
 */
export function looksLikeGitUrl(raw: string): boolean {
  const s = raw.trim()
  return s.length > 0 && GIT_URL_HINT_RE.test(s)
}

/** 与 Go unicode.IsSpace 同清单（JS 正则 \s 与 Go 语义有出入，显式枚举保证双端同判） */
function isSpaceCodePoint(cp: number): boolean {
  return cp === 0x20
    || (cp >= 0x09 && cp <= 0x0D)
    || cp === 0x85 || cp === 0xA0 || cp === 0x1680
    || (cp >= 0x2000 && cp <= 0x200A)
    || cp === 0x2028 || cp === 0x2029 || cp === 0x202F || cp === 0x205F
    || cp === 0x3000
}

/**
 * 校验克隆 URL 形态（P-20261003-70）：空白（含 NBSP/全角空格等）与全角字符
 * （CJK 标点 3000-303F、全角形式 FF00-FFEF——URL 出现即粘贴事故）直接判非法，
 * 其余按形态表从宽。空串按非法处理（调用方以非空为前置条件自行短路）。
 */
export function isValidCloneUrl(raw: string): boolean {
  for (const ch of raw) {
    const cp = ch.codePointAt(0) as number
    if (isSpaceCodePoint(cp) || (cp >= 0x3000 && cp <= 0x303F) || (cp >= 0xFF00 && cp <= 0xFFEF)) {
      return false
    }
  }
  return CLONE_URL_FORM_RE.test(raw)
}
