import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fixedLocale, gotoAndUnlock, closeDshConsoleAndClearState, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 自定义智能体运行时（设置 → 通用）：表单校验 + CRUD 全链路 + 配置导出/导入
 * （P-20261004-83：导出全部/单条 JSON 下载，导入文件选择 → 清洗 → 冲突预览
 * → 合并）。
 * 共享状态：customAgents 是全局 settings 的一部分——每条用例开头先 API 清
 * 同名项（重试也自清理），用例创建的项用后即删，不污染其他用例/运行时下拉。
 */

const NAME = 'e2e-probe-agent'
const NAME2 = 'e2e-probe-agent-2'
const EXPORT_NAME = 'e2e-transfer-agent'
const IMPORT_NEW = 'e2e-transfer-new'

const DL_DIR = path.join(os.tmpdir(), 'sc-e2e-custom-agents-dl')

/** 取解锁令牌（customAgents 写操作走 LockMiddleware） */
async function lockHeaders(request: import('@playwright/test').APIRequestContext) {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'X-Lock-Token': token }
}

/** 清同名历史项：改名/重跑遗留会使创建撞名 */
async function apiCleanup(request: import('@playwright/test').APIRequestContext, names: string[]) {
  const headers = await lockHeaders(request)
  for (const n of names) {
    await request.delete(`${API_BASE}/api/settings/custom-agents/${n}`, {
      headers,
    }).catch(() => { /* 不存在即目标态 */ })
  }
}

/** API 直建一个自定义智能体（导出/冲突预览的播种面） */
async function apiCreate(request: import('@playwright/test').APIRequestContext, agent: { name: string; displayName?: string; command: string }) {
  const headers = await lockHeaders(request)
  const res = await request.post(`${API_BASE}/api/settings/custom-agents`, { data: agent, headers })
  if (!res.ok()) throw new Error(`seed agent ${agent.name} failed: ${res.status()}`)
}

/** 经服务端读回全量列表（落库断言，与 UI 状态解耦） */
async function apiListAgents(request: import('@playwright/test').APIRequestContext): Promise<Array<{ name: string; displayName?: string; command: string }>> {
  const res = await request.get(`${API_BASE}/api/settings`, { headers: await lockHeaders(request) })
  const data = (await res.json()) as { data?: { customAgents?: Array<{ name: string; displayName?: string; command: string }> } }
  return data.data?.customAgents ?? []
}

async function enterProjectAndOpenSettings(page: import('@playwright/test').Page) {
  await closeDshConsoleAndClearState(page, page.request, API_BASE)
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  // 解锁后延迟出现的默认密码提醒遮罩会拦截点击，先收起
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
  await page.locator('[data-testid="rail-settings"]').click()
  const modal = page.locator('.n-modal.settings-modal')
  await expect(modal).toBeVisible()
  return modal
}

test.describe('custom agents manager', () => {
  test.afterAll(async ({ request }) => {
    await apiCleanup(request, [NAME, NAME2])
  })

  test('表单校验：空命令提示；命令上限经 maxlength 钳制', async ({ page }) => {
    await fixedLocale(page)
    await apiCleanup(page.request, [NAME, NAME2])
    const modal = await enterProjectAndOpenSettings(page)
    const manager = modal.locator('.custom-agents-manager')
    await manager.getByRole('button', { name: '添加智能体' }).click()
    const addModal = page.locator('.n-modal:visible').filter({ hasText: '添加自定义智能体' })
    await expect(addModal).toBeVisible()

    // 名字合法但命令为空 → 前端提示，弹窗不关
    const inputs = addModal.locator('input.n-input__input-el')
    await inputs.nth(0).fill(NAME)
    await addModal.getByRole('button', { name: '保存' }).click()
    await expect(page.locator('.n-message').filter({ hasText: '启动命令不能为空' })).toBeVisible()
    await expect(addModal).toBeVisible()

    // 命令 200 上限由输入框 maxlength 钳制：粘贴 220 字符落入 200，不产生错误
    const cmd = inputs.nth(2)
    await cmd.fill('x'.repeat(220))
    const len = await cmd.evaluate((el: HTMLInputElement) => el.value.length)
    expect(len).toBe(200)
    await expect(page.locator('.n-message').filter({ hasText: '请求参数有误' })).toHaveCount(0)

    // 不保存，取消收场（本用例零副作用，不创建任何运行时）
    await addModal.getByRole('button', { name: '取消' }).click()
    await expect(addModal).toBeHidden()
  })

  test('CRUD 链路：添加 → 列表 → 改名 → 删除', async ({ page }) => {
    test.setTimeout(30000)
    await fixedLocale(page)
    await apiCleanup(page.request, [NAME, NAME2])
    const modal = await enterProjectAndOpenSettings(page)
    const manager = modal.locator('.custom-agents-manager')

    // 添加
    await manager.getByRole('button', { name: '添加智能体' }).click()
    const addModal = page.locator('.n-modal:visible').filter({ hasText: '添加自定义智能体' })
    const inputs = addModal.locator('input.n-input__input-el')
    await inputs.nth(0).fill(NAME)
    await inputs.nth(1).fill('E2E Probe Agent')
    await inputs.nth(2).fill('echo hello')
    await addModal.getByRole('button', { name: '保存' }).click()
    await expect(addModal).toBeHidden()

    // 列表出现：displayName + 命令（name-tag 用锚定正则精确匹配，
    // 避免 NAME 是 NAME2 前缀的子串误命中；:text-is 在本仓 Playwright 版本
    // 实测不命中 NTag 文本，故用 hasText 正则）
    const tagOf = (name: string) => page.locator('.name-tag').filter({ hasText: new RegExp(`^${name}$`) })
    const itemOf = (name: string) => manager.locator('.n-list-item').filter({ has: tagOf(name) })
    const item = itemOf(NAME)
    await expect(item).toContainText('E2E Probe Agent')
    await expect(item).toContainText('echo hello')

    // 改名：编辑 NAME → NAME2，displayName 保留
    await item.getByRole('button', { name: '编辑' }).click()
    const editModal = page.locator('.n-modal:visible').filter({ hasText: '编辑自定义智能体' })
    await expect(editModal).toBeVisible()
    const editInputs = editModal.locator('input.n-input__input-el')
    await expect(editInputs.nth(1)).toHaveValue('E2E Probe Agent')
    await editInputs.nth(0).fill(NAME2)
    await editModal.getByRole('button', { name: '保存' }).click()
    await expect(editModal).toBeHidden()
    const item2 = itemOf(NAME2)
    await expect(item2).toBeVisible()
    await expect(itemOf(NAME)).toHaveCount(0)

    // 删除：确认弹窗二次确认 → 空态
    await item2.getByRole('button', { name: '删除' }).click()
    const confirm = page.locator('.n-modal:visible').filter({ hasText: `删除自定义智能体「E2E Probe Agent」` })
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: '删除' }).click()
    await expect(itemOf(NAME2)).toHaveCount(0)
  })
})

test.describe('custom agents transfer (P-20261004-83)', () => {
  test.afterAll(async ({ request }) => {
    await apiCleanup(request, [EXPORT_NAME, IMPORT_NEW])
  })

  test('导出：全部/单条 JSON 下载带标记与字段白名单', async ({ page }) => {
    test.setTimeout(30000)
    await fixedLocale(page)
    await apiCleanup(page.request, [EXPORT_NAME])
    await apiCreate(page.request, { name: EXPORT_NAME, displayName: 'Transfer Agent', command: 'echo transfer' })
    const modal = await enterProjectAndOpenSettings(page)
    const manager = modal.locator('.custom-agents-manager')

    // 全量导出：下载名走 exportFileName 导出族约定，载荷带 scCustomAgents 标记
    fs.mkdirSync(DL_DIR, { recursive: true })
    const [dlAll] = await Promise.all([
      page.waitForEvent('download', { timeout: 5000 }),
      manager.locator('[data-test="custom-agents-export-all"]').click(),
    ])
    // 导出名前缀随品牌切换（4adaf9da）改 codecombo-*
    expect(dlAll.suggestedFilename()).toMatch(/^codecombo-custom-agents-\d{8}\.json$/)
    const allFile = path.join(DL_DIR, dlAll.suggestedFilename())
    await dlAll.saveAs(allFile)
    const allPayload = JSON.parse(fs.readFileSync(allFile, 'utf8'))
    expect(allPayload.scCustomAgents).toBe(1)
    expect(typeof allPayload.exportedAt).toBe('string')
    const exported = (allPayload.agents as Array<{ name: string; displayName?: string; command: string }>)
      .find(a => a.name === EXPORT_NAME)
    expect(exported).toBeTruthy()
    expect(exported!.command).toBe('echo transfer')
    expect(exported!.displayName).toBe('Transfer Agent')

    // 单条导出：下载名含注册名，载荷只含该条
    //（has 内层定位器须 page 级——filter 会把内层重锚到每个候选元素上，
    // manager 作用域链在 list-item 内永不命中；CRUD 用例 tagOf 同款先例）
    const item = manager.locator('.n-list-item').filter({ has: page.locator('.name-tag').filter({ hasText: new RegExp(`^${EXPORT_NAME}$`) }) })
    const [dlOne] = await Promise.all([
      page.waitForEvent('download', { timeout: 5000 }),
      item.locator('[data-test="custom-agents-export-one"]').click(),
    ])
    expect(dlOne.suggestedFilename()).toMatch(new RegExp(`^codecombo-agent-${EXPORT_NAME}-\\d{8}\\.json$`))
    const oneFile = path.join(DL_DIR, dlOne.suggestedFilename())
    await dlOne.saveAs(oneFile)
    const onePayload = JSON.parse(fs.readFileSync(oneFile, 'utf8'))
    expect(onePayload.scCustomAgents).toBe(1)
    expect(onePayload.agents).toHaveLength(1)
    expect(onePayload.agents[0].name).toBe(EXPORT_NAME)
  })

  test('导入：文件选择 → 清洗 → 冲突预览 → 跳过/覆盖合并', async ({ page }) => {
    test.setTimeout(45000)
    await fixedLocale(page)
    await apiCleanup(page.request, [EXPORT_NAME, IMPORT_NEW])
    await apiCreate(page.request, { name: EXPORT_NAME, displayName: 'Transfer Agent', command: 'echo transfer' })
    const modal = await enterProjectAndOpenSettings(page)
    const manager = modal.locator('.custom-agents-manager')
    // has 内层定位器须 page 级（filter 重锚语义，见导出用例同款注记）
    const itemOf = (name: string) => manager.locator('.n-list-item').filter({ has: page.locator('.name-tag').filter({ hasText: new RegExp(`^${name}$`) }) })

    // 导入文件：1 新条目 + 1 同名冲突（命令不同）+ 1 非法条目（name 形态不符）
    fs.mkdirSync(DL_DIR, { recursive: true })
    const importFile = path.join(DL_DIR, 'import-agents.json')
    fs.writeFileSync(importFile, JSON.stringify({
      scCustomAgents: 1,
      version: 1,
      exportedAt: new Date().toISOString(),
      agents: [
        { name: IMPORT_NEW, displayName: 'Imported New', command: 'echo imported' },
        { name: EXPORT_NAME, displayName: 'Transfer Agent', command: 'echo overwritten' },
        { name: 'Bad Name!', command: 'x' },
      ],
    }))
    await manager.locator('input[type=file]').setInputFiles(importFile)

    // 预览弹层：命令清单 + 同名冲突标注 + 本地现值对照 + 无效条目知情注记
    const preview = page.locator('.n-modal:visible').filter({ hasText: '导入自定义智能体' })
    await expect(preview).toBeVisible()
    await expect(preview).toContainText('echo imported')
    await expect(preview).toContainText('同名冲突')
    await expect(preview).toContainText('本地现值: echo transfer')
    await expect(preview).toContainText('另有 1 条无效条目已忽略')

    // skip 策略（默认保守档）：冲突条目跳过、新条目入库
    //（汇总 toast 在 CRUD 往返 + fetchAgents 之后才出现，窗口放宽防时序翻车）
    await preview.locator('[data-test="custom-agents-import-confirm"]').click()
    await expect(preview).toBeHidden()
    await expect(page.locator('.n-message').filter({ hasText: '导入完成：新增 1、覆盖 0、跳过 1、失败 0' })).toBeVisible({ timeout: 10000 })
    await expect(itemOf(IMPORT_NEW)).toContainText('echo imported')
    await expect(itemOf(EXPORT_NAME)).toContainText('echo transfer')
    const listed = await apiListAgents(page.request)
    expect(listed.find(a => a.name === IMPORT_NEW)?.command).toBe('echo imported')
    expect(listed.find(a => a.name === EXPORT_NAME)?.command).toBe('echo transfer')

    // overwrite 策略：同名条目整条覆盖（skip 相已把 IMPORT_NEW 落库，
    // 二次导入两条全是同名冲突 → 覆盖 2）
    await manager.locator('input[type=file]').setInputFiles(importFile)
    await expect(preview).toBeVisible()
    await preview.getByText('覆盖已存在').click()
    await preview.locator('[data-test="custom-agents-import-confirm"]').click()
    await expect(page.locator('.n-message').filter({ hasText: '导入完成：新增 0、覆盖 2、跳过 0、失败 0' })).toBeVisible({ timeout: 10000 })
    await expect(itemOf(EXPORT_NAME)).toContainText('echo overwritten')
    const listed2 = await apiListAgents(page.request)
    expect(listed2.find(a => a.name === EXPORT_NAME)?.command).toBe('echo overwritten')
    expect(listed2.find(a => a.name === IMPORT_NEW)?.command).toBe('echo imported')
  })

  test('导入校验：格式无效与空有效集就地提示，不进预览', async ({ page }) => {
    test.setTimeout(30000)
    await fixedLocale(page)
    const modal = await enterProjectAndOpenSettings(page)
    const manager = modal.locator('.custom-agents-manager')

    // 非 JSON 文件 → 格式无效提示
    const badFile = path.join(DL_DIR, 'not-json.json')
    fs.mkdirSync(DL_DIR, { recursive: true })
    fs.writeFileSync(badFile, 'not-json{{')
    await manager.locator('input[type=file]').setInputFiles(badFile)
    await expect(page.locator('.n-message').filter({ hasText: '文件格式无效' })).toBeVisible()

    // 标记合法但全部条目无效 → 空有效集提示
    const emptyFile = path.join(DL_DIR, 'all-invalid.json')
    fs.writeFileSync(emptyFile, JSON.stringify({ scCustomAgents: 1, version: 1, agents: [{ name: 'Bad!', command: '' }] }))
    await manager.locator('input[type=file]').setInputFiles(emptyFile)
    await expect(page.locator('.n-message').filter({ hasText: '文件中没有可导入的有效条目' })).toBeVisible()
    await expect(page.locator('.n-modal').filter({ hasText: '导入自定义智能体' })).toHaveCount(0)
  })
})
