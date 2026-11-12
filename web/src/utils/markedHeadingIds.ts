import { marked } from 'marked'
import { createMdHeadingSlugger } from './mdAnchorSlug'

// ── heading id 生成（P-20261007-7 页内锚点二阶段的渲染侧）──
// 纯副作用模块：import 即安装，ES 模块只求值一次 = 全应用只安装一次。
// P-20261112-2-S1 自 useEditorMdPreview 模块顶层原样搬出——原先挂在编辑器
// composable 上，「发布说明页内锚点」（utils/changelogRender：dsh 版本弹层 /
// 自更新面板的中英文小节切换）能否命中取决于编辑器 chunk 是否恰好先加载过
// （首页版本面板即未加载形态）；收到独立模块后由各消费方显式 import，锚点
// 契约不再依赖加载顺序。
//
// marked.use 突变的是全局 marked 实例（HelpCenter/NotesPanel/changelogRender
// 同船消费方），且 renderer 包装器会在重复 use 时层层叠裹（去重计数被翻倍），
// 故只在模块加载时安装一次。副作用仅「heading 多挂一个 id 属性」：id 是惰性
// 属性，各消费方 DOMPurify 默认允许面含 id（SANITIZE_DOM 会剥与 document 属性
// 撞名的 id，如 title/body——该形态锚点落入坏锚点回退，不炸）；其余渲染产物
// 字节不变。slug 规则与重名去重单源在 utils/mdAnchorSlug（点击侧按 id 精确
// 匹配不重算，两侧行为靠同源保证）。
const headingSlugger = createMdHeadingSlugger()
marked.use({
  hooks: {
    // 每个 parse 开始时复位重名计数（parse 同步执行，无重入交错）
    preprocess(src: string) {
      headingSlugger.reset()
      return src
    },
  },
  renderer: {
    heading(token) {
      // slug 取纯文本口径：textRenderer 剥行内标记（[link](url) 计 text 不计
      // url），与 GitHub slug 语义一致
      const plain = this.parser.parseInline(token.tokens, this.parser.textRenderer)
      const id = headingSlugger(plain)
      if (!id) return false // 空 slug（纯标点标题）不挂 id，false 回落默认 renderer
      // slug 规则保证 id 无 HTML 特殊字符（字母/数字/连字符/下划线/CJK），可直插
      return `<h${token.depth} id="${id}">${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`
    },
  },
})
