import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 编辑器内容区布局收容契约（P-20261120-5）：
 *   `.editor-content` 是编辑器/预览的高度收口点，必须自建 flex 列布局，
 *   子视图（FilePreviewView 等）的 `flex:1 + min-height:0` 才能生效。曾缺
 *   `display:flex` 退化块流——超长 docx 预览高度失控撑破整条收容链：文档级
 *   滚动把左侧工具栏滚出视口、内容透过底部面板下缘外泄（用户实测三症状）。
 *
 * jsdom 无真实布局，高度钳制的行为断言在 e2e 真浏览器钉死
 * （e2e/specs/editor-file-preview.spec.ts「超长文档收容/git 面板开合」两用例）；
 * 本文件按 design-tokens.test.ts 同款源码契约口径，把「样式声明存在」钉成
 * 门禁——再有人删掉 display:flex / min-height:0 或把双挂载提交面板接回来，
 * 这里先红，不等用户截图。
 */

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function read(rel: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, rel), 'utf-8')
}

/** 抽取源码中首个 <style> 块体（组件 scoped 样式段） */
function styleBlock(src: string): string {
  const m = src.match(/<style[^>]*>([\s\S]*?)<\/style>/)
  expect(m, 'style block present').toBeTruthy()
  return m![1]
}

/** 抽取指定类选择器的规则体（无嵌套的平铺声明段） */
function ruleBody(css: string, className: string): string {
  const re = new RegExp(`${className.replace(/\./g, '\\.')}\\s*\\{([^}]*?)\\}`)
  const m = css.match(re)
  expect(m, `rule ${className} present`).toBeTruthy()
  return m![1]
}

const paneSrc = read('src/components/layout/EditorGroupPane.vue')
const previewSrc = read('src/components/editor/FilePreviewView.vue')

describe('编辑器内容区收容契约（P-20261120-5）', () => {
  it('.editor-content 自建 flex 列布局并钳制最小高度（子视图 flex:1 生效前提）', () => {
    const body = ruleBody(styleBlock(paneSrc), '.editor-content')
    expect(body).toMatch(/display:\s*flex/)
    expect(body).toMatch(/flex-direction:\s*column/)
    expect(body).toMatch(/min-height:\s*0/)
    expect(body).toMatch(/flex:\s*1/)
  })

  it('.file-preview-view 保持滚动收容三件套（flex:1 + min-height:0 + overflow:auto）', () => {
    const body = ruleBody(styleBlock(previewSrc), '.file-preview-view')
    expect(body).toMatch(/flex:\s*1/)
    expect(body).toMatch(/min-height:\s*0/)
    expect(body).toMatch(/overflow:\s*auto/)
  })

  it('编辑器内容区不再挂载提交面板重复份（SidePanel 是侧栏提交面板唯一宿主）', () => {
    // 历史：EditorGroupPane 与 SidePanel 同条件双挂载 CommitPanel，块流下落在
    // 编辑器下方视口外（不可见却盖住状态栏拦截点击）；随收容修正移除编辑器
    // 内容区侧，防止 flex 化后重复份变可见
    expect(paneSrc).not.toMatch(/<CommitPanel/)
    expect(paneSrc).not.toMatch(/showCommitPanel/)
  })
})
