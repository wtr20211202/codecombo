import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 会话中心自定义分组拖拽整区落点 E2E（P-20261111-1-S2）：
 * 组头窄行落点外扩到整段组区（组头+组内行/行间空白），高亮挂整段组区
 * （.ats-section 上的 ats-drag-over，与项目树同款视觉语）；drop 与组头落点
 * 同语义（组源=移到目标组之前、会话源=移入该组），布局锁定短路（startDrag
 * interceptDrag）不动。全链：建组 → 拖会话进组（组段空白承接）→ 组内行前
 * 插入 → 拖组排序（组内行承接面 + 组段承接面两路径）→ 折叠态落组头 → 拖会话
 * 出组（未分组整区）→ 平铺/runtime 视图切换往返 → 刷新后组序与成员持久。
 *
 * 拖放以 dispatchEvent + DataTransfer 模拟（activity-bar-drag / file-tree-
 * multi-move 同款手法：dragstart 打在源元素真实 handler 上，dragover/drop
 * 打在目标元素——组段承接面直接以 .ats-section 元素为目标，精确覆盖本提案
 * 扩出的落点，而非恰好命中组头窄行）。
 *
 * 测试数据：API 直建 3 个 shell 会话（免 claude 二进制依赖）；beforeAll 先
 * PATCH ui-state 清 agentTerminal 命名空间（键值 null=清键，布局重置同语义）
 * 保证组序/成员断言不受残留分组影响，并清空全部终端会话保证行数确定
 * （session-runtime-groups.spec 同款约定）。afterAll 复位两类数据。
 */

const GA = 'DnD组甲'
const GB = 'DnD组乙'
const DND_A = 'dnd-alpha'
const DND_B = 'dnd-beta'
const DND_C = 'dnd-gamma'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清空全部终端会话（侧栏同显项目会话，session-time-chips.spec 同款约定——
 *  不这样就数不准 .ats-item） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
  }
}

/** uiState agentTerminal 命名空间复位（键值 null=清键，布局重置同语义）——
 *  组序/折叠/成员残留会让本 spec 的顺序断言踩到上一次运行的遗留 */
async function resetAgentTerminalState(request: APIRequestContext): Promise<void> {
  await request.patch(`${API_BASE}/api/ui-state`, {
    headers: await unlockHeaders(request),
    data: { local: { agentTerminal: null } },
  })
}

/** 服务端 agentTerminal.groups（持久化断言：即时写链路，落定即判） */
async function serverGroups(request: APIRequestContext): Promise<{ name: string; sessionIds: string[] }[]> {
  const res = await request.get(`${API_BASE}/api/ui-state`, { headers: await unlockHeaders(request) })
  const body = (await res.json()) as { data?: { local?: { agentTerminal?: { groups?: { name: string; sessionIds: string[] }[] } } } }
  return body.data?.local?.agentTerminal?.groups ?? []
}

/** 解锁后延迟出现的「建议修改默认密码」提醒遮罩会拦截点击（session-runtime-
 *  groups.spec 同款：waitFor + 收起，未出现则继续） */
async function dismissPwdTip(page: Page): Promise<void> {
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
}

/** 进项目页 → 打开终端会话管理 */
async function openManager(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await dismissPwdTip(page)
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  return view
}

/** 原地重开管理页面板（reload 后用，session-runtime-groups.spec 同款——跨页
 *  goto 会撞 uiState 记忆的首页浮层；面板开关是 toggle 语义，active 即已开勿盲点） */
async function reopenManagerInPlace(page: Page) {
  await dismissPwdTip(page)
  const railBtn = page.locator('.rail-btn[title="终端会话管理"]')
  const cls = await railBtn.getAttribute('class')
  if (!cls?.includes('active')) await railBtn.click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  return view
}

/** 自定义分组组段（:has CSS 一次到位——组头带 is-group 且组名精确等值，
 *  与项目分组组段同构但组名互不相同） */
function groupSection(view: Locator, name: string): Locator {
  return view.locator(`.ats-section:has(.ats-group-head.is-group:has(.ats-group-name:text-is("${name}")))`)
}

/** 未分组组段（组头是普通 span 文案，无 .ats-group-name） */
function rootSection(view: Locator): Locator {
  return view.locator(`.ats-section:has(.ats-group-head span:text-is("未分组"))`)
}

function sessionRow(view: Locator, name: string): Locator {
  return view.locator(`.ats-item:has-text("${name}")`)
}

/** 自定义分组区呈现序（组段 DOM 序过滤出两个测试组名——项目组段组头同名结构
 *  但组名不同，过滤后顺序即组序） */
async function customGroupOrder(view: Locator): Promise<string[]> {
  const seq = await view.locator('.ats-section').evaluateAll(els =>
    els.map(e => e.querySelector('.ats-group-head .ats-group-name')?.textContent?.trim() ?? ''))
  return seq.filter(n => n === GA || n === GB)
}

/** 单发拖拽事件（真实 DragEvent + DataTransfer，activity-bar-drag 同款构造；
 *  组件 handler 经 dragSource 状态机承接，载荷仅满足浏览器构造要求） */
async function fireDrag(page: Page, el: Locator, type: 'dragstart' | 'dragover' | 'drop' | 'dragend') {
  const handle = await el.elementHandle()
  await page.evaluate(([e, t]) => {
    e!.dispatchEvent(new DragEvent(t!, { dataTransfer: new DataTransfer(), bubbles: true, cancelable: true }))
  }, [handle, type])
}

/** 完整拖放序列：dragstart 打源 → dragover/drop 打目标 → dragend 收尾。
 *  句柄先解析后派发（activity-bar-drag 同款）——drop 可能即时摘除源行（本
 *  spec 的折叠组落组即此形态：S1 折叠 v-if 只藏行，会话移入折叠组后源行脱离
 *  文档），dragend 打在已脱离文档的源元素上仍触发其监听器完成拖拽态清理 */
async function dragTo(page: Page, source: Locator, target: Locator) {
  const src = await source.elementHandle()
  const dst = await target.elementHandle()
  await page.evaluate(([s, d]) => {
    const dt = new DataTransfer()
    s!.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
    d!.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    d!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    s!.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, [src, dst])
}

/** 新建分组（footer 内联输入，Enter 确认）并断言组段出现 */
async function createGroup(view: Locator, name: string) {
  await view.locator('.ats-footer button').click()
  const input = view.locator('.ats-footer input')
  await expect(input).toBeVisible()
  await input.fill(name)
  await input.press('Enter')
  await expect(groupSection(view, name).locator('.ats-group-count')).toHaveText('0')
}

test.describe('会话中心自定义分组拖拽整区落点（P-20261111-1-S2）', () => {
  test.beforeAll(async ({ request }) => {
    await resetAgentTerminalState(request)
    await cleanupTerminals(request)
    for (const name of [DND_A, DND_B, DND_C]) {
      const created = await request.post(`${API_BASE}/api/terminals`, {
        headers: await unlockHeaders(request),
        data: { kind: 'agent', name, runtime: 'shell' },
      })
      if (!created.ok()) throw new Error(`create ${name} failed: ${created.status()}`)
    }
  })

  test.afterAll(async ({ request }) => {
    await cleanupTerminals(request).catch(() => { /* 服务不在：无残留面 */ })
    await resetAgentTerminalState(request).catch(() => { /* 同上 */ })
  })

  test('建组→拖组排序→拖会话进出→折叠态落组头→视图切换往返→持久化', async ({ page, request }) => {
    test.setTimeout(120000)
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const view = await openManager(page)

    // 建组×2：组段出现 + 空组计数徽标 0（S1 形态在此基础上叠加，不动）
    await createGroup(view, GA)
    await createGroup(view, GB)
    expect(await customGroupOrder(view)).toEqual([GA, GB])

    // 拖会话进组①：dragover/drop 打在组段元素（组头窄行外的整区承接面——
    // 本提案扩出的落点），组段整区高亮随 dragover 亮起
    const ga = groupSection(view, GA)
    await fireDrag(page, sessionRow(view, DND_A), 'dragstart')
    await fireDrag(page, ga, 'dragover')
    await expect(ga).toHaveClass(/ats-drag-over/)
    await fireDrag(page, ga, 'drop')
    await fireDrag(page, sessionRow(view, DND_A), 'dragend')
    await expect(ga.locator('.ats-group-count')).toHaveText('1')
    await expect(ga.locator('.ats-item', { hasText: DND_A })).toBeVisible()
    await expect(rootSection(view).locator('.ats-item')).toHaveCount(2)

    // 拖会话进组②：组内行前插入（行级落点既有语义保持）→ 甲=[beta, alpha]
    await dragTo(page, sessionRow(view, DND_B), ga.locator('.ats-item', { hasText: DND_A }))
    await expect(ga.locator('.ats-item').first()).toContainText(DND_B)
    await expect(ga.locator('.ats-item').last()).toContainText(DND_A)
    await expect(ga.locator('.ats-group-count')).toHaveText('2')

    // 拖组排序路径一（回归修复）：组头 dragstart → drop 打在目标组「会话行」上
    // ——行层对组源拒绝、冒泡到组段出口重排序（S2 前行层吞源会吃成无动作）
    const gb = groupSection(view, GB)
    await dragTo(page, gb.locator('.ats-group-head'), ga.locator('.ats-item', { hasText: DND_B }))
    expect(await customGroupOrder(view)).toEqual([GB, GA])

    // 拖组排序路径二：drop 打在目标组「组段元素」上 + 整段高亮反馈
    // （拖乙到甲后顺序 [乙,甲]；再拖甲到乙组段 = 甲移到乙之前，还原 [甲,乙]）
    await fireDrag(page, ga.locator('.ats-group-head'), 'dragstart')
    await fireDrag(page, gb, 'dragover')
    await expect(gb).toHaveClass(/ats-drag-over/)
    await fireDrag(page, gb, 'drop')
    await fireDrag(page, ga.locator('.ats-group-head'), 'dragend')
    expect(await customGroupOrder(view)).toEqual([GA, GB])
    await expect(ga).not.toHaveClass(/ats-drag-over/)

    // 持久化：即时写落盘（不等防抖）→ 组序与成员服务端可判
    await expect.poll(async () => (await serverGroups(request)).map(g => g.name)).toEqual([GA, GB])
    await expect.poll(async () => (await serverGroups(request)).find(g => g.name === GA)?.sessionIds.length).toBe(2)

    // 刷新后组序与成员从 uiState 恢复
    await page.reload()
    const view2 = await reopenManagerInPlace(page)
    expect(await customGroupOrder(view2)).toEqual([GA, GB])
    const ga2 = groupSection(view2, GA)
    await expect(ga2.locator('.ats-item', { hasText: DND_B })).toBeVisible()
    await expect(ga2.locator('.ats-item', { hasText: DND_A })).toBeVisible()

    // 拖会话出组：drop 打在未分组「组段元素」上（未分组整区承接 = 归根，
    // 不要求命中未分组组头窄行）
    await dragTo(page, sessionRow(view2, DND_A), rootSection(view2))
    await expect(ga2.locator('.ats-group-count')).toHaveText('1')
    await expect(rootSection(view2).locator('.ats-item', { hasText: DND_A })).toBeVisible()
    await expect(ga2.locator('.ats-item', { hasText: DND_A })).toHaveCount(0)

    // 折叠态落组头：折叠只藏行、计数徽标恒显（S1 形态）；折叠态下拖会话进组
    // 仍可达（组段=组头），展开后成员就位
    await ga2.locator('.ats-group-head').click()
    await expect(ga2.locator('.ats-item')).toHaveCount(0)
    await expect(ga2.locator('.ats-group-count')).toHaveText('1')
    await dragTo(page, sessionRow(view2, DND_C), ga2)
    await expect(ga2.locator('.ats-group-count')).toHaveText('2')
    await ga2.locator('.ats-group-head').click()
    await expect(ga2.locator('.ats-item', { hasText: DND_C })).toBeVisible()
    await expect(ga2.locator('.ats-item', { hasText: DND_B })).toBeVisible()

    // 平铺/runtime 视图切换往返：runtime 视图下自定义分组整区让位（会话按
    // runtime 归组展示），切回平铺后自定义分组原样恢复
    await view2.locator('[data-test="session-group-toggle"]').click()
    await expect(view2.locator('[data-test="session-runtime-group-head"][data-runtime="shell"]')).toBeVisible()
    await expect(view2.locator('[data-test="session-runtime-group-count"]')).toHaveText('3')
    await expect(groupSection(view2, GA)).toHaveCount(0)
    await expect(groupSection(view2, GB)).toHaveCount(0)
    await view2.locator('[data-test="session-group-toggle"]').click()
    expect(await customGroupOrder(view2)).toEqual([GA, GB])
    await expect(groupSection(view2, GA).locator('.ats-group-count')).toHaveText('2')
    await expect(groupSection(view2, GA).locator('.ats-item', { hasText: DND_C })).toBeVisible()
  })
})
