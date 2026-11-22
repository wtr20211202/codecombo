// FilePreviewView 组件测试（P-20261120-3 md 预览宽图适配失效修复+灯箱）：
// 缺陷根因（评审实勘）= md 源内 HTML <img> 带显式 width/height 属性（DOMPurify
// 默认放行），max-width 只钳宽不钳高——height 属性把图钉死成巨条+容器
// overflow:auto 切片。断言面钉「修复后的真实级联」：md-preview.css 以 ?raw
// 注入 <style>（jsdom getComputedStyle 支持样式表级联，实测可行），三形态
// （标准语法/属性图/表格内图）逐图断言 max-width:100% + height:auto 落计算
// 样式；灯箱断言真实开关链（点击开/点击关/Esc 关/单例/a 包裹图让位链接语义/
// 宿主卸载收口）。i18n 走 setup.ts 全局 mock（键直通）。
import { describe, expect, it, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount, type VueWrapper } from '@vue/test-utils'
import FilePreviewView from '../../components/editor/FilePreviewView.vue'
import { closeMdLightbox, openMdLightbox } from '../../utils/mdLightbox'
import type { OpenFile } from '../../composables/useOpenFiles'

// md-preview.css 不走 ?raw import——vitest css:false 会把 CSS 模块（含 ?raw）
// 置空，级联断言全空转；改 fs 直读文件原文注入 <style>（vitest 恒以 web/ 为
// cwd 运行——npm run test/check 与 CI 同口）
const mdPreviewCss = readFileSync(resolve(process.cwd(), 'src/styles/md-preview.css'), 'utf8')

const WIDE_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8z8DwnwEJMDDMAPntFuUAAAAASUVORK5CYII='

// 三形态样张（评审用样张同构）：标准 img 语法 / HTML img 带显式宽高属性 /
// 表格内图片
const SAMPLE_MD = [
  '# 样张',
  '',
  '## 形态一：标准语法',
  '',
  `![宽图](${WIDE_URI})`,
  '',
  '## 形态二：HTML img 带宽高属性',
  '',
  `<img src="${WIDE_URI}" width="3000" height="1600">`,
  '',
  '## 形态三：表格内图片',
  '',
  '| 场景 | 截图 |',
  '| - | - |',
  `| VS Code 全屏 | <img src="${WIDE_URI}"> |`,
  '',
].join('\n')

function mdFile(content: string): OpenFile {
  return { path: 'docs/sample.md', name: 'sample.md', content, pvKind: 'markdown' } as OpenFile
}

function mountPreview(file: OpenFile): VueWrapper {
  return mount(FilePreviewView, { props: { file, projectId: 'p1', lang: 'zh' } })
}

let styleEl: HTMLStyleElement | null = null
let mounted: VueWrapper[] = []

function ensureStyles(): void {
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.textContent = mdPreviewCss
    document.head.appendChild(styleEl)
  }
}

function previewImgs(w: VueWrapper): HTMLImageElement[] {
  return w.element.querySelectorAll('.md-preview-content img')
}

afterEach(() => {
  mounted.forEach((w) => w.unmount())
  mounted = []
  closeMdLightbox()
  document.querySelectorAll('.md-lightbox').forEach((el) => el.remove())
})

describe('FilePreviewView md 宽图三形态适配（P-20261120-3）', () => {
  it('三形态全部渲染且 width/height 属性穿透净化链存活', () => {
    ensureStyles()
    const w = mountPreview(mdFile(SAMPLE_MD))
    mounted.push(w)
    const imgs = previewImgs(w)
    expect(imgs.length).toBe(3)
    // 缺陷面前提：属性图（样张实测 752×1600 同构）的显式宽高未被 DOMPurify 剥掉
    expect(imgs[1].getAttribute('width')).toBe('3000')
    expect(imgs[1].getAttribute('height')).toBe('1600')
  })

  it('修复级联：三形态逐图 max-width:100% + height:auto 落计算样式（属性高度释放）', () => {
    ensureStyles()
    const w = mountPreview(mdFile(SAMPLE_MD))
    mounted.push(w)
    for (const img of previewImgs(w)) {
      const cs = getComputedStyle(img)
      expect(cs.maxWidth).toBe('100%')
      expect(cs.height).toBe('auto')
    }
  })

  it('灯箱样式同源落级联：fixed 全屏遮罩 + zoom-out 手势', () => {
    ensureStyles()
    openMdLightbox(WIDE_URI)
    const lb = document.querySelector('.md-lightbox')
    expect(lb).not.toBeNull()
    const cs = getComputedStyle(lb as Element)
    expect(cs.position).toBe('fixed')
    expect(cs.display).toBe('flex')
    expect(cs.cursor).toBe('zoom-out')
  })
})

describe('FilePreviewView md 图片灯箱交互（P-20261120-3）', () => {
  it('点击预览内图片开灯箱：body 挂全屏遮罩，src 同源', async () => {
    const w = mountPreview(mdFile(SAMPLE_MD))
    mounted.push(w)
    await w.find('.md-preview-content img').trigger('click')
    const lb = document.querySelector('.md-lightbox')
    expect(lb).not.toBeNull()
    const lbImg = lb!.querySelector('img')
    expect(lbImg?.getAttribute('src')).toBe(WIDE_URI)
  })

  it('点击遮罩关闭；Esc 关闭', async () => {
    const w = mountPreview(mdFile(SAMPLE_MD))
    mounted.push(w)
    await w.find('.md-preview-content img').trigger('click')
    expect(document.querySelector('.md-lightbox')).not.toBeNull()
    // 点击遮罩（冒泡到 lb 自身的 click 监听）
    document.querySelector('.md-lightbox')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(document.querySelector('.md-lightbox')).toBeNull()
    // 重开走 Esc
    await w.find('.md-preview-content img').trigger('click')
    expect(document.querySelector('.md-lightbox')).not.toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('.md-lightbox')).toBeNull()
  })

  it('单例：灯箱开着时不叠层', async () => {
    const w = mountPreview(mdFile(SAMPLE_MD))
    mounted.push(w)
    const imgs = previewImgs(w)
    await w.find('.md-preview-content img').trigger('click')
    // 灯箱开着时再点第二张（真实场景被遮罩挡死，防御形态）——仍是单例
    imgs[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(document.querySelectorAll('.md-lightbox').length).toBe(1)
  })

  it('a 包裹图（[![alt](img)](link) 惯例）不进灯箱——链接语义优先', async () => {
    const md = `# 样张\n\n[![链内图](${WIDE_URI})](https://example.com)\n`
    const w = mountPreview(mdFile(md))
    mounted.push(w)
    await w.find('.md-preview-content img').trigger('click')
    expect(document.querySelector('.md-lightbox')).toBeNull()
  })

  it('宿主卸载收口：灯箱挂 body 不随 v-if 摘除，unmount 主动清理', async () => {
    const w = mountPreview(mdFile(SAMPLE_MD))
    await w.find('.md-preview-content img').trigger('click')
    expect(document.querySelector('.md-lightbox')).not.toBeNull()
    w.unmount()
    expect(document.querySelector('.md-lightbox')).toBeNull()
  })
})
