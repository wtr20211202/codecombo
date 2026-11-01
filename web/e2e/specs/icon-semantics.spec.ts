import { test, expect, type Locator, type Page } from '@playwright/test'
import { createSSRApp, h, type Component } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { ACTION_ICONS, NAV_ICONS } from '../../src/utils/actionIcons'
import { API_BASE } from '../../tests/api-base'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * 动作图标语义（P-20261022-1）与目的地图标（P-20261022-2）：
 *   ① 测试专用图标画廊——真实注册表组件（动作段 + nav 段分区）按 14/16/20px ×
 *      深/浅主题渲染并截图（基线随 spec 提交）。不新增产品路由，SSR 直出测试页，
 *      视觉回归不依赖应用数据面。
 *   ② 运行期动作标注对账——顶栏/Git 面板/文件树的 data-icon-action 标注块内 SVG
 *      形状指纹必须与动作注册表组件一致（防止只改标注键、图形漂移）。
 * 说明：四张整页截图（TopBar/GitPanel/ShareManagerView/FileTree）受共享 e2e 实例
 * 数据漂移影响未固化为基线，见 docs/design/icon-semantics.md §10；形状契约由 ①/②
 * 与静态门禁共同守。
 */

const SIZES = [14, 16, 20] as const

/** 从渲染 HTML 提取形状指纹：标签 + 形状属性（忽略 xmlns/class/style 与属性顺序） */
function shapeFingerprint(html: string): string {
  const tags = [...html.matchAll(/<([a-zA-Z]+)([^>]*)>/g)]
  return tags.flatMap(([, tag, attrs]) => {
    // SSR 断言时组件外层会带 div 包装；只比较图形标签自身
    if (tag.toLowerCase() === 'div' || tag.toLowerCase() === 'span') return []
    if (tag.toLowerCase() === 'svg') return ['svg']
    const pairs = [...attrs.matchAll(/([:\w-]+)="([^"]*)"/g)]
      .filter(([, key]) => !['xmlns', 'class', 'style', 'aria-hidden', 'focusable'].includes(key))
      .map(([, key, value]) => `${key}=${value}`)
      .sort()
      .join(',')
    return [`${tag}(${pairs})`]
  }).join('|')
}

async function expectedFingerprints(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const [key, icon] of Object.entries(ACTION_ICONS) as Array<[string, Component]>) {
    const html = await renderToString(createSSRApp({ render: () => h('div', null, [h(icon)]) }))
    map.set(key, shapeFingerprint(html))
  }
  return map
}

async function galleryHtml(theme: 'dark' | 'light'): Promise<string> {
  // nav 段（P-20261022-2）分区渲染在动作段之后——首批三组消歧（share-manager/
  // monitor/shortcuts）与其相邻目的地的形状对比直接在画廊里可查
  const sections: Array<{ title: string; entries: Array<[string, Component]> }> = [
    { title: 'ACTION_ICONS', entries: Object.entries(ACTION_ICONS) as Array<[string, Component]> },
    { title: 'NAV_ICONS', entries: Object.entries(NAV_ICONS) as Array<[string, Component]> },
  ]
  const app = createSSRApp({
    render: () => h('div', { class: 'gallery' }, sections.map((section) => [
      h('div', { class: 'section' }, section.title),
      ...section.entries.map(([key, icon]) => h('div', { class: 'row' }, [
        h('span', { class: 'label' }, key),
        ...SIZES.map((size) => h('span', { class: 'cell', 'data-size': size, 'data-action': key }, [
          h('span', { class: 'box', style: `width:${size}px;height:${size}px` }, [h(icon)]),
        ])),
      ])),
    ])),
  })
  const body = await renderToString(app)
  const bg = theme === 'dark' ? '#0d1117' : '#ffffff'
  const fg = theme === 'dark' ? '#c9d1d9' : '#1f2328'
  const dim = theme === 'dark' ? '#8b949e' : '#57606a'
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; background: ${bg}; color: ${fg}; }
    body { font: 12px/1.2 "Segoe UI", sans-serif; }
    .gallery { display: inline-block; padding: 12px; }
    .section { font-weight: 700; padding: 8px 0 4px; color: ${fg}; }
    .row { display: grid; grid-template-columns: 190px repeat(3, 44px); align-items: center; height: 30px; }
    .label { color: ${dim}; white-space: nowrap; font-family: ui-monospace, monospace; font-size: 11px; }
    .cell { display: flex; align-items: center; justify-content: center; }
    .box { display: inline-flex; align-items: center; justify-content: center; }
    .box svg { width: 100%; height: 100%; }
  </style></head><body>${body}</body></html>`
}

async function assertActionIcon(page: Page, scope: Locator, action: string, expected: string): Promise<void> {
  const node = scope.locator(`[data-icon-action="${action}"]`).first()
  await expect(node, `动作 ${action} 的标注节点应存在`).toBeVisible()
  const html = await node.evaluate((el) => el.innerHTML)
  expect(shapeFingerprint(html), `动作 ${action} 的图形应与注册表 ${expected} 一致`).toBe(expected)
}

test.describe('动作图标语义', () => {
  test('图标画廊 14/16/20px × 深浅主题（视觉基线）', async ({ page }) => {
    // 基线按 Windows e2e 拓扑维护（仓库浏览器 e2e 只在 Windows 跑；跨拓扑仍是
    // Windows 浏览器打 Linux 服务端）——其他平台缺同名基线时跳过而非假红
    test.skip(process.platform !== 'win32', 'visual baseline is maintained on the Windows e2e topology')
    // 基线扩容留痕：NAV_ICONS 新增 'sync'（P-20261023-1 多实例同步中心，
    // CloudCircleOutline 云+环）画廊多一行，基线随注册表有意重生成（非图形漂移）；
    // ACTION_ICONS 新增 'share.directApprove'（P-20261024-1 直通输入握手，
    // HandLeftOutline 举手）再多一行（基线 1997px→2027px 恰一行高 30px），同法重生成
    await page.setViewportSize({ width: 360, height: 720 })
    for (const theme of ['dark', 'light'] as const) {
      await page.setContent(await galleryHtml(theme))
      // 容差吸收不同 Windows 机器的字体/抗锯齿差异；形状差异远大于该阈值
      await expect(page).toHaveScreenshot(`icon-gallery-${theme}.png`, {
        fullPage: true,
        animations: 'disabled',
        maxDiffPixelRatio: 0.02,
        threshold: 0.25,
      })
    }
  })

  test('顶栏/Git 面板/文件树的动作标注与注册表图形一致', async ({ page }) => {
    const fingerprints = await expectedFingerprints()
    const expectIcon = (scope: Locator, action: string) => assertActionIcon(page, scope, action, fingerprints.get(action)!)

    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/`)
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')

    // 顶栏：更多/拉取/推送恒显；fetch 在分组按钮里（带文字，不影响语义）
    await expectIcon(page.locator('.ide-header'), 'common.more')
    await expectIcon(page.locator('.ide-header'), 'git.pull')
    await expectIcon(page.locator('.ide-header'), 'git.push')
    await expectIcon(page.locator('.ide-header'), 'git.fetch')

    // Git 面板快捷同步族三钮：fetch/pull/push 各归其位
    await page.locator('[data-testid="rail-git"]').click()
    const gitPanel = page.locator('.git-panel')
    await expect(gitPanel).toBeVisible({ timeout: 10000 })
    await expectIcon(gitPanel, 'common.refresh')
    await expectIcon(gitPanel, 'git.fetch')
    await expectIcon(gitPanel, 'git.pull')
    await expectIcon(gitPanel, 'git.push')

    // 文件树：刷新/回收站/复制/搜索/钉选的标注
    const tree = page.locator('.file-tree')
    await expect(tree).toBeVisible({ timeout: 10000 })
    await expectIcon(tree, 'common.refresh')
    await expectIcon(tree, 'common.recycleBin')
    await expectIcon(tree, 'common.search')
  })
})
