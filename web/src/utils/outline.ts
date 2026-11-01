// 大纲数据源（纯函数）：Markdown 标题提取 + 代码文件声明行正则提取。
// 无 LSP 时的行级提取，跳转复用统一的 handleSearchOpenFile 跳行机制。

export interface OutlineItem {
  level: number
  text: string
  line: number
}

// 代码文件声明行模式：一级（函数/顶层类型）不缩进，接口/类型别名/方法等二级；
// 匹配即 break 避免同行多模式重复计入
const CODE_PATTERNS: Array<{ exts: string[]; patterns: Array<{ re: RegExp; level: number; label: (m: RegExpExecArray) => string }> }> = [
  {
    exts: ['go'],
    patterns: [
      { re: /^func\s+(?:\([^)]+\)\s*)?([A-Za-z_]\w*)/, level: 1, label: m => `func ${m[1]}()` },
      { re: /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/, level: 1, label: m => `type ${m[1]}` },
    ],
  },
  {
    exts: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue'],
    patterns: [
      { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, level: 1, label: m => `function ${m[1]}()` },
      { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, level: 1, label: m => `class ${m[1]}` },
      { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, level: 2, label: m => `interface ${m[1]}` },
      { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, level: 2, label: m => `type ${m[1]}` },
      { re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/, level: 2, label: m => `const ${m[1]}()` },
    ],
  },
  {
    exts: ['py'],
    patterns: [
      { re: /^\s*class\s+([A-Za-z_]\w*)/, level: 1, label: m => `class ${m[1]}` },
      { re: /^\s*def\s+([A-Za-z_]\w*)/, level: 2, label: m => `def ${m[1]}()` },
    ],
  },
]

export function isMarkdownPath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase()
  return ext === 'md' || ext === 'markdown'
}

export function extractMarkdownOutline(content: string): OutlineItem[] {
  const items: OutlineItem[] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    // ATX 标题：# 标题
    const atx = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (atx) {
      items.push({ level: atx[1]!.length, text: atx[2]!, line: i + 1 })
      continue
    }
    // Setext 标题（下一行是 === 或 ---）
    if (i + 1 < lines.length) {
      const next = lines[i + 1]!
      if (/^=+\s*$/.test(next) && line.trim()) {
        items.push({ level: 1, text: line.trim(), line: i + 1 })
      } else if (/^-+\s*$/.test(next) && line.trim()) {
        items.push({ level: 2, text: line.trim(), line: i + 1 })
      }
    }
  }
  return items
}

export function extractCodeOutline(ext: string, content: string): OutlineItem[] {
  const def = CODE_PATTERNS.find(p => p.exts.includes(ext))
  if (!def) return []
  const items: OutlineItem[] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    for (const p of def.patterns) {
      const m = p.re.exec(line)
      if (m) {
        items.push({ level: p.level, text: p.label(m), line: i + 1 })
        break
      }
    }
  }
  return items
}

export function extractOutline(path: string, content: string): OutlineItem[] {
  if (!content) return []
  const ext = path.split('.').pop()?.toLowerCase()
  if (!ext) return []
  if (ext === 'md' || ext === 'markdown') return extractMarkdownOutline(content)
  return extractCodeOutline(ext, content)
}
