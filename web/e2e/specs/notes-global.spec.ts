import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 笔记库 E2E（P-20261107-5 全局库独立化 → P-20261108-3 单库化）：笔记只有项目无关的
 * 一个库（/api/notes 族，哨兵 _global 作用域），原「全局库|项目库」双源切换与项目族
 * 端点（/api/projects/:id/notes 兼容 shim、/notes-multi 七端点）退役。
 *   1. API 族：CRUD → 清单元数据不内联 content → 项目族端点 404（退役）→ 覆盖保护
 *      409 → 回收站软删/恢复/彻底删除 → 256KB 边界（恰好放行 / +1 字节 413）
 *   2. 面板：无数据源切换；快捷新建（头部「+」）+ Ctrl+S 保存命名 + Ctrl+Alt+M/R；
 *      tab 切换编辑互不串扰（原 notes-multi.spec 面板用例收编）
 * 自备临时仓库（项目页入口用），afterAll 清理。项目族端点的旧形态覆盖原在
 * notes-multi.spec / project-notes.spec，随端点退役收编至此（存量迁移见
 * notes-migration.spec）。
 */

const REPO = path.join(os.tmpdir(), 'sc-e2e-notes-global')
const PROJ = 'e2e-notes-global'

let projId = ''
let headers = { 'Content-Type': 'application/json' }

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

function makeRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'README.md'), '# notes-global e2e\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'root: 笔记库基线'])
}

interface NoteMeta { id: string; title: string; updatedAt: string; size: number; deletedAt?: string }

async function globalList(trash = false): Promise<NoteMeta[]> {
  const res = await fetch(`${API_BASE}/api/notes${trash ? '?trash=1' : ''}`, { headers })
  expect(res.status).toBe(200)
  return ((await res.json()) as { data?: NoteMeta[] }).data ?? []
}

/** 清空笔记库（在册+回收站彻底删除）——用例的确定性起点 */
async function purgeAllGlobal(): Promise<void> {
  for (const view of [await globalList(), await globalList(true)]) {
    for (const n of view) {
      await fetch(`${API_BASE}/api/notes/${n.id}?purge=1`, { method: 'DELETE', headers })
    }
  }
}

test.beforeAll(async () => {
  try { fs.rmSync(REPO, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  makeRepo(REPO)
  headers = await unlockHeaders()
  const stale = (await (await fetch(`${API_BASE}/api/projects`, { headers })).json()) as { data?: { id: string; name: string }[] }
  for (const p of stale.data ?? []) {
    if (p.name === PROJ) await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
  }
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO) }),
  })
  expect([200, 201]).toContain(res.status)
  projId = ((await res.json()) as { data?: { id?: string } }).data?.id || ''
  expect(projId).not.toBe('')
})

test.afterAll(async () => {
  headers = await unlockHeaders()
  await purgeAllGlobal()
  if (projId) {
    await fetch(`${API_BASE}/api/projects/${projId}`, { method: 'DELETE', headers })
  }
  try { fs.rmSync(REPO, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

async function apiCreateGlobal(title: string, content: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/notes`, {
    method: 'POST', headers, body: JSON.stringify({ title, content }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { data?: { id?: string } }).data?.id || ''
}

test('API 族：CRUD → 元数据清单 → 项目族端点已退役 404 → 409 覆盖保护 → 回收站链 → 256KB 边界', async () => {
  await purgeAllGlobal()

  const idG = await apiCreateGlobal('全局交接', 'global body v1')
  await apiCreateGlobal('长篇', 'x'.repeat(2000))

  // 清单是元数据面：绝不内联 content（100 篇 × 256KB 内联会拖垮面板首开）
  const list = await globalList()
  expect(list.map(n => n.id)).toContain(idG)
  expect(JSON.stringify(list)).not.toContain('global body v1')
  expect(list.every(n => typeof n.size === 'number' && !('content' in n))).toBe(true)

  // 项目族端点随单库化退役（P-20261108-3）：兼容 shim 与 notes-multi 族一律 404
  for (const [method, url] of [
    ['GET', `/api/projects/${projId}/notes`],
    ['PUT', `/api/projects/${projId}/notes`],
    ['GET', `/api/projects/${projId}/notes-multi`],
    ['POST', `/api/projects/${projId}/notes-multi`],
    ['GET', `/api/projects/${projId}/notes-multi/${idG}`],
  ] as const) {
    const r = await fetch(`${API_BASE}${url}`, {
      method, headers, body: method === 'GET' ? undefined : JSON.stringify({ content: 'x' }),
    })
    expect(r.status, `${method} ${url} should be retired`).toBe(404)
  }

  // 单篇读写（PUT last-writer-wins 形态）
  const got = await (await fetch(`${API_BASE}/api/notes/${idG}`, { headers })).json() as { data?: { content?: string; updatedAt?: string } }
  expect(got.data?.content).toBe('global body v1')
  const staleBase = got.data?.updatedAt
  const put = await fetch(`${API_BASE}/api/notes/${idG}`, {
    method: 'PUT', headers, body: JSON.stringify({ content: 'global body v2' }),
  })
  expect(put.status).toBe(200)

  // 过期 baseUpdatedAt → 409 notes.conflict 携 currentContent
  const stale = await fetch(`${API_BASE}/api/notes/${idG}`, {
    method: 'PUT', headers,
    body: JSON.stringify({ content: 'stale', baseUpdatedAt: staleBase }),
  })
  expect(stale.status).toBe(409)
  const payload = (await stale.json()) as { code?: string; currentContent?: string }
  expect(payload.code).toBe('notes.conflict')
  expect(payload.currentContent).toBe('global body v2')

  // 回收站链：软删 → trash 视图 → 恢复幂等 → purge 彻底删除
  await fetch(`${API_BASE}/api/notes/${idG}`, { method: 'DELETE', headers })
  expect((await globalList()).map(n => n.id)).not.toContain(idG)
  expect((await globalList(true)).map(n => n.id)).toContain(idG)
  for (let i = 0; i < 2; i++) {
    const r = await fetch(`${API_BASE}/api/notes/${idG}/restore`, { method: 'POST', headers })
    expect(r.status).toBe(200)
  }
  expect((await globalList()).map(n => n.id)).toContain(idG)
  const purge = await fetch(`${API_BASE}/api/notes/${idG}?purge=1`, { method: 'DELETE', headers })
  expect(purge.status).toBe(200)
  const gone = await fetch(`${API_BASE}/api/notes/${idG}`, { headers })
  expect(gone.status).toBe(404)

  // 256KB 边界（原项目兼容端点用例收编）：恰好 256KB 放行，+1 字节 413 且原内容不被半截覆盖
  const exact = await fetch(`${API_BASE}/api/notes/default`, {
    method: 'PUT', headers, body: JSON.stringify({ content: 'a'.repeat(256 * 1024) }),
  })
  expect(exact.status).toBe(200)
  const over = await fetch(`${API_BASE}/api/notes/default`, {
    method: 'PUT', headers, body: JSON.stringify({ content: 'a'.repeat(256 * 1024 + 1) }),
  })
  expect(over.status).toBe(413)
  const def = await (await fetch(`${API_BASE}/api/notes/default`, { headers })).json() as { data?: { content?: string } }
  expect(def.data?.content?.length).toBe(256 * 1024)
})

/** 项目页打开笔记独立视图（rail toggle 语义：未开才点，点后不可见再点一次） */
async function openNotesPanel(page: import('@playwright/test').Page) {
  const panel = page.locator('[data-testid="notes-panel"]')
  if (!(await panel.isVisible().catch(() => false))) {
    await page.locator('[data-testid="rail-notes"]').click()
  }
  try {
    await panel.waitFor({ state: 'visible', timeout: 2500 })
  } catch {
    await page.locator('[data-testid="rail-notes"]').click()
    await panel.waitFor({ state: 'visible', timeout: 5000 })
  }
  return panel
}

test('面板：单库无数据源切换；快捷新建 + Ctrl+S 保存命名 + Ctrl+Alt+M/R；tab 切换互不串扰', async ({ page }) => {
  await purgeAllGlobal()

  await fixedLocale(page)
  // 经项目卡进入（projectCardByName 整词定位防 git-test 卡面子串误中）
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, PROJ).click()
  await page.waitForURL('**/project')
  const panel = await openNotesPanel(page)
  await expect(panel).toBeVisible()

  // 单库化：头部不再有「全局库|项目库」切换；空库 → 合成 default 占位 tab（loadList 收口）
  await expect(panel.locator('[data-testid="notes-source-switch"]')).toHaveCount(0)
  await expect(panel.locator('[data-testid="notes-tab-default"]')).toBeVisible({ timeout: 8000 })

  // 快捷新建（头部「+」）→ 编辑面聚焦即可打字（命名后置）。create 是异步 POST 且服务端
  // 广播 notes.updated → 面板重拉清单（占位被真身替换）——等占位 tab 消失即三面收敛
  await panel.locator('[data-testid="notes-create-quick"]').click()
  const editor = panel.locator('[data-testid="notes-editor"]')
  await expect(panel.locator('[data-testid="notes-tab-default"]')).toBeHidden({ timeout: 8000 })
  await expect(editor).toBeVisible()
  await editor.fill('# 全局随手记')
  await editor.click()
  await editor.press('Control+s')

  // Ctrl+S 保存未命名篇 → 命名框（预填正文首行建议「全局随手记」）
  const dlgInput = page.locator('.n-dialog input')
  await expect(dlgInput).toBeVisible({ timeout: 4000 })
  await expect(dlgInput).toHaveValue('全局随手记')
  await dlgInput.fill('全局备忘')
  await page.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()
  await expect.poll(async () => (await globalList()).some(n => n.title === '全局备忘'), { timeout: 8000 })
    .toBe(true)
  // 等 naive 弹层离场动画收尾（不等收敛就开下一个命名框，`.n-dialog input` 双命中）
  await expect(page.locator('.n-dialog')).toHaveCount(0, { timeout: 5000 })

  // Ctrl+Alt+M 新建第二篇 → Ctrl+S 命名框取消（内容照常已保存、不再追问）→
  // Ctrl+Alt+R 重命名兜底命名
  await editor.press('Control+Alt+m')
  await expect(panel.locator('[data-testid^="notes-tab-"]')).toHaveCount(2, { timeout: 8000 })
  await expect(editor).toBeVisible()
  await editor.fill('第二篇草稿')
  await editor.press('Control+s')
  await expect(dlgInput).toBeVisible({ timeout: 4000 })
  await page.locator('.n-dialog__action button').filter({ hasText: '取消' }).click()
  await expect(page.locator('.n-dialog')).toHaveCount(0, { timeout: 5000 })
  // 清单是元数据面（不内联 content）——内容断言走单篇 GET（无标题篇即新篇）
  await expect.poll(async () => {
    for (const n of await globalList()) {
      if (n.title) continue
      const full = await (await fetch(`${API_BASE}/api/notes/${n.id}`, { headers })).json() as { data?: { content?: string } }
      if (full.data?.content === '第二篇草稿') return true
    }
    return false
  }, { timeout: 8000 }).toBe(true)
  // 对话框关闭后焦点回落 body——点回编辑面恢复面板聚焦，快捷键再生效
  await editor.click()
  await editor.press('Control+Alt+r')
  await expect(dlgInput).toBeVisible({ timeout: 4000 })
  await dlgInput.fill('第二篇')
  await page.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()
  await expect.poll(async () => (await globalList()).some(n => n.title === '第二篇'), { timeout: 8000 })
    .toBe(true)
  await expect(page.locator('.n-dialog')).toHaveCount(0, { timeout: 5000 })

  // 管理侧栏（大区域默认常显）两命名篇在册
  const items = panel.locator('[data-testid="notes-list-item"]')
  await expect(items).toHaveCount(2)
  await expect(items.filter({ hasText: '全局备忘' })).toHaveCount(1)
  await expect(items.filter({ hasText: '第二篇' })).toHaveCount(1)

  // tab 切换编辑互不串扰（原 notes-multi.spec 面板用例）：切回「全局备忘」内容原样
  const first = (await globalList()).find(n => n.title === '全局备忘')
  expect(first).toBeTruthy()
  await panel.locator(`[data-testid="notes-tab-${first!.id}"]`).click()
  await expect(editor).toHaveValue('# 全局随手记', { timeout: 8000 })
})

async function defaultNoteContent(): Promise<string | undefined> {
  const got = await (await fetch(`${API_BASE}/api/notes/default`, { headers })).json() as { data?: { content?: string } }
  return got.data?.content
}

/** 光标读数（textarea selectionStart，UTF-16 码元偏移） */
async function cursorOf(editor: ReturnType<import('@playwright/test').Page['locator']>): Promise<number> {
  return editor.evaluate(el => (el as HTMLTextAreaElement).selectionStart)
}

test('外部更新无扰换装（P-20261111-4 S2）：同内容零触碰；异内容光标锚定；连续输入不被打断（409 冲突条兜底）', async ({ page }) => {
  await purgeAllGlobal()

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, PROJ).click()
  await page.waitForURL('**/project')
  const panel = await openNotesPanel(page)
  const editor = panel.locator('[data-testid="notes-editor"]')
  await expect(editor).toBeVisible({ timeout: 8000 }) // 空库占位 default 篇

  // 基线：占位篇输入 → 防抖自动保存落真身（default-upsert）
  await editor.fill('基线内容一二三四五')
  await expect.poll(defaultNoteContent, { timeout: 8000 }).toBe('基线内容一二三四五')
  await editor.click()
  await editor.evaluate(el => (el as HTMLTextAreaElement).setSelectionRange(4, 4)) // 光标钉在「一」前

  // ── 同内容态：外部重写同值（换 title 作清单收敛信号）→ 编辑面零触碰 ──
  await fetch(`${API_BASE}/api/notes/default`, {
    method: 'PUT', headers, body: JSON.stringify({ content: '基线内容一二三四五', title: '无扰' }),
  })
  // 清单收敛（quiet 后台合并完成，之后单篇 diff 也在同一事件链内收口）
  await expect(panel.locator('[data-testid="notes-list-item"]').filter({ hasText: '无扰' }))
    .toBeVisible({ timeout: 8000 })
  // 零扰动：值与光标在观测窗内恒成立——若被旧实现整篇重读，光标即归 0
  for (let i = 0; i < 5; i++) {
    expect(await editor.inputValue()).toBe('基线内容一二三四五')
    expect(await cursorOf(editor)).toBe(4)
    await page.waitForTimeout(120)
  }

  // ── 异内容态：外部在文首插入前缀 → 换装 + 光标沿稳定后缀端平移（视觉位置不变）──
  await fetch(`${API_BASE}/api/notes/default`, {
    method: 'PUT', headers, body: JSON.stringify({ content: '前缀\n基线内容一二三四五', title: '无扰' }),
  })
  await expect(editor).toHaveValue('前缀\n基线内容一二三四五', { timeout: 8000 })
  // '前缀\n' = 3 码元（2 CJK + 换行）；后缀锚定 = newLen(12) − 尾距(9−4=5) = 7，
  // 光标仍停在「一」前——文首插入不推移视觉位置
  await expect.poll(() => cursorOf(editor), { timeout: 4000 }).toBe(7)

  // ── 连续输入态：dirty 期间外部异写 → 编辑面不被覆盖；落盘撞 409 由冲突条兜底 ──
  await editor.fill('连续输入的草稿') // dirty（防抖窗内）
  await fetch(`${API_BASE}/api/notes/default`, {
    method: 'PUT', headers, body: JSON.stringify({ content: '连续输入期间的外部写' }),
  })
  await page.waitForTimeout(400) // 外部广播处理窗
  await expect(editor).toHaveValue('连续输入的草稿') // 人的输入优先：内容让位编辑面
  await expect(editor).toBeFocused()
  await editor.pressSequentially('续写', { delay: 60 }) // 连续输入不被打断
  await expect(editor).toHaveValue('连续输入的草稿续写')
  // 防抖落盘：base 已被外部写推进 → 409 冲突条（覆盖保护三件套，不静默覆盖）
  await expect(panel.locator('[data-testid="notes-conflict"]')).toBeVisible({ timeout: 8000 })
  await expect(editor).toHaveValue('连续输入的草稿续写') // 冲突挂起不撤编辑面
  await panel.locator('[data-testid="notes-conflict-load"]').click() // 载入服务端版本
  await expect(panel.locator('[data-testid="notes-conflict"]')).toBeHidden({ timeout: 4000 })
  await expect(editor).toHaveValue('连续输入期间的外部写', { timeout: 8000 })
})

test('双窗互写可见性（P-20261111-4 S2）：B 窗写入 A 窗换装可见，A 窗回写 B 窗可见', async ({ page }) => {
  await purgeAllGlobal()

  // A 窗（项目页笔记视图）
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, PROJ).click()
  await page.waitForURL('**/project')
  const panelA = await openNotesPanel(page)
  const editorA = panelA.locator('[data-testid="notes-editor"]')
  await expect(editorA).toBeVisible({ timeout: 8000 })
  await editorA.fill('A 窗基线')
  await expect.poll(defaultNoteContent, { timeout: 8000 }).toBe('A 窗基线')

  // B 窗（同 context 新页 = 独立窗口 nonce；同库同数据）
  const pageB = await page.context().newPage()
  await fixedLocale(pageB)
  await gotoAndUnlock(pageB, `${API_BASE}/`)
  await projectCardByName(pageB, PROJ).click()
  await pageB.waitForURL('**/project')
  const panelB = await openNotesPanel(pageB)
  const editorB = panelB.locator('[data-testid="notes-editor"]')
  await expect(editorB).toBeVisible({ timeout: 8000 })
  await expect(editorB).toHaveValue('A 窗基线', { timeout: 8000 })

  // B 窗改写 → 自动保存（回声抑制只跳过 B 自己）→ A 窗（idle）换装可见
  await editorB.fill('B 窗基线\nB 追加行')
  await expect.poll(defaultNoteContent, { timeout: 8000 }).toBe('B 窗基线\nB 追加行')
  await expect(editorA).toHaveValue('B 窗基线\nB 追加行', { timeout: 8000 })

  // 反向：A 窗回写 → B 窗可见
  await editorA.fill('A 窗回写\n第二行')
  await expect.poll(defaultNoteContent, { timeout: 8000 }).toBe('A 窗回写\n第二行')
  await expect(editorB).toHaveValue('A 窗回写\n第二行', { timeout: 8000 })

  await pageB.close()
})
