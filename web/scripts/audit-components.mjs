// 横向审计：.vue 模板中使用的组件是否都有对应导入（临时排查脚本，用后即删）
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'src'
const files = []
function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p)
    else if (f.endsWith('.vue')) files.push(p)
  }
}
walk(SRC)

const VUE_BUILTIN = new Set(['Transition', 'TransitionGroup', 'KeepAlive', 'Teleport', 'Suspense', 'Component', 'Slot', 'RouterView', 'RouterLink'])
const HTML_TAGS = new Set(['slot', 'transition', 'teleport', 'kbd', 'colgroup', 'col', 'div', 'span', 'button', 'input', 'template', 'a', 'p', 'img', 'ul', 'li', 'ol', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'form', 'label', 'select', 'option', 'textarea', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'header', 'footer', 'nav', 'main', 'aside', 'article', 'pre', 'code', 'br', 'hr', 'strong', 'em', 'small', 'i', 'b', 'svg', 'path', 'circle', 'line', 'rect', 'text', 'g', 'canvas', 'video', 'audio', 'iframe', 'style', 'script', 'link', 'meta', 'title', 'body', 'html', 'time', 'sub', 'sup', 'u', 's', 'del', 'ins', 'mark', 'abbr', 'cite', 'q', 'blockquote', 'dl', 'dt', 'dd', 'fieldset', 'legend', 'datalist', 'output', 'progress', 'meter', 'figure', 'figcaption', 'details', 'summary', 'dialog', 'menu', 'component'])

const mainTs = readFileSync(join(SRC, 'main.ts'), 'utf8')
const globalComps = [...mainTs.matchAll(/\.component\(['"]([\w-]+)['"]/g)].map(m => m[1])

const issues = []
for (const file of files) {
  const s = readFileSync(file, 'utf8')
  const tplMatch = s.match(/<template>([\s\S]*)<\/template>/)
  if (!tplMatch) continue
  const tpl = tplMatch[1]
  const tags = new Set()
  for (const m of tpl.matchAll(/<([A-Za-z][\w-]*)/g)) tags.add(m[1])
  const imported = new Set()
  for (const m of s.matchAll(/import\s+(?:type\s+)?(?:([\w$]+)\s*,\s*)?(?:type\s+)?\{([^}]*)\}\s+from/g)) {
    if (m[1]) imported.add(m[1])
    for (const name of m[2].split(',')) {
      const n = name.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim()
      if (n) imported.add(n)
    }
  }
  for (const m of s.matchAll(/import\s+(\w+)\s+from/g)) imported.add(m[1])
  // 本地 const 声明的大驼峰标识符（defineAsyncComponent 等形态）
  for (const m of s.matchAll(/(?:^|\n)\s*const\s+([A-Z][\w]*)\s*=/g)) imported.add(m[1])

  const MACROS = new Set(['defineProps', 'defineEmits', 'defineExpose', 'defineOptions', 'withDefaults'])
  for (const tag of tags) {
    if (tag.startsWith('n-')) {
      const comp = 'N' + tag.slice(2).split('-').map(w => w[0].toUpperCase() + w.slice(1)).join('')
      if (!imported.has(comp) && !globalComps.includes(comp)) {
        issues.push(`${file}: <${tag}> 需要 naive-ui 组件 ${comp}，未导入`)
      }
      continue
    }
    if (/^[a-z]/.test(tag)) {
      if (!HTML_TAGS.has(tag) && !globalComps.includes(tag)) {
        issues.push(`${file}: <${tag}> 疑似未导入的自定义组件`)
      }
      continue
    }
    if (VUE_BUILTIN.has(tag) || MACROS.has(tag) || globalComps.includes(tag)) continue
    if (!imported.has(tag)) {
      issues.push(`${file}: <${tag}> 未导入`)
    }
  }
}
console.log(issues.length ? issues.join('\n') : 'ALL CLEAN')
console.log(`\n审计文件数: ${files.length}, 问题数: ${issues.length}`)
