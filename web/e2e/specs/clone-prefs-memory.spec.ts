import { test, expect, type Page, type Locator } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 克隆对话框上次选择记忆（P-20261003-241）：
 *   - SSH 密钥下拉/深度在对话框每次打开时重置——上次选择经 localStorage 记忆，
 *     重开（openCloneTab 内 gotoAndUnlock = 真实导航，即整页刷新）自动恢复
 *   - 记忆压过 host 自动匹配（多仓连续克隆同密钥是主诉求；host 匹配只是首次
 *     的启发式默认）
 *   - 密钥被删后读侧对账当前清单：陈旧 id 不复活，回落既有默认链
 *     （host 匹配 → 通用密钥 → 空）
 * 数据面：API 真建 ed25519 密钥（generate 走 Go crypto，不依赖外部 ssh-keygen），
 * 前缀 e2e-clone-prefs- 的密钥 beforeEach 全量清（含历史残留，用例间密钥清单
 * 确定性）、afterAll 兜底清。清单只有通用密钥（API 不设 host），自动匹配恒选
 * 清单内首个通用密钥（清单序不作断言依赖）。localStorage 每用例独立 context
 * 天然隔离，无跨用例串扰。
 */

const K1_NAME = 'e2e-clone-prefs-key-a'
const K2_NAME = 'e2e-clone-prefs-key-b'
const SSH_URL = 'git@github.com:e2e/clone-prefs-demo.git'

type SshKeyMeta = { id: string; name: string }

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function listKeys(headers: Record<string, string>): Promise<SshKeyMeta[]> {
  const res = await fetch(`${API_BASE}/api/sshkeys`, { headers })
  return (((await res.json()) as { data?: SshKeyMeta[] }).data) || []
}

async function generateKey(headers: Record<string, string>, name: string): Promise<SshKeyMeta> {
  const res = await fetch(`${API_BASE}/api/sshkeys/generate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, algo: 'ed25519' }),
  })
  const body = (await res.json()) as { data?: SshKeyMeta }
  expect(body.data?.id).toBeTruthy()
  return body.data as SshKeyMeta
}

async function deleteAllPrefixedKeys(headers: Record<string, string>) {
  for (const k of await listKeys(headers)) {
    if (k.name.startsWith('e2e-clone-prefs-')) {
      await fetch(`${API_BASE}/api/sshkeys/${k.id}`, { method: 'DELETE', headers })
    }
  }
}

test.beforeEach(async () => {
  await deleteAllPrefixedKeys(await unlockHeaders())
})

test.afterAll(async () => {
  await deleteAllPrefixedKeys(await unlockHeaders())
})

/** 打开「添加项目」弹窗并切到克隆 tab（add-clone-suggest 同款入口） */
async function openCloneTab(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.getByRole('button', { name: '添加项目' }).first().click()
  const modal = page.locator('.n-modal').filter({ hasText: '添加项目' })
  await expect(modal).toBeVisible({ timeout: 5000 })
  await modal.locator('.n-tabs-tab').filter({ hasText: '从 Git 克隆' }).click()
  return modal
}

/** 填 SSH 地址并失焦，触发密钥清单加载/自动匹配（onCloneUrlBlur 链） */
async function fillSshUrlAndBlur(modal: Locator, url: string) {
  const urlInput = modal.locator('input[placeholder*="github.com/user/repo.git"]')
  await urlInput.fill(url)
  await urlInput.press('Tab')
}

/** 打开密钥下拉并选中指定名称的选项（approval-rules 同款 NSelect 交互） */
async function pickSshKey(page: Page, modal: Locator, name: string) {
  const select = modal.locator('[data-testid="clone-ssh-key-select"]')
  await select.locator('.n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: name }).click()
  await expect(select).toContainText(name)
}

test('选密钥+深度 → 关闭整页刷新重开：记忆恢复且压过自动匹配', async ({ page }) => {
  const headers = await unlockHeaders()
  await generateKey(headers, K1_NAME)
  await generateKey(headers, K2_NAME)

  const modal = await openCloneTab(page)
  const select = modal.locator('[data-testid="clone-ssh-key-select"]')
  const depth = modal.locator('[data-testid="clone-depth-input"] input')

  // 首次打开无记忆：URL 失焦自动匹配 → 密钥下拉出现（选中项为清单内启发式
  // 默认，不作序依赖断言）
  await fillSshUrlAndBlur(modal, SSH_URL)
  await expect(select).toBeVisible({ timeout: 5000 })

  // 用户改选 k2 + 填深度：记忆写持久层（选择变更即写，无需真实克隆）
  await pickSshKey(page, modal, K2_NAME)
  await depth.fill('5')
  await depth.press('Tab')

  // 关闭 → 重开（gotoAndUnlock 真实导航 = 整页刷新，localStorage 跨会话）
  await modal.locator('button').filter({ hasText: '取消' }).click()
  await expect(modal).toBeHidden({ timeout: 5000 })

  const modal2 = await openCloneTab(page)
  // 深度开箱即恢复（resetCloneForm 于 openAddModal 读取）
  await expect(modal2.locator('[data-testid="clone-depth-input"] input')).toHaveValue('5')
  // 再失焦拉密钥清单：上次选的 k2 仍在 → 记忆优先，压过「首个通用密钥」自动匹配
  await fillSshUrlAndBlur(modal2, SSH_URL)
  await expect(modal2.locator('[data-testid="clone-ssh-key-select"]')).toBeVisible({ timeout: 5000 })
  await expect(modal2.locator('[data-testid="clone-ssh-key-select"]')).toContainText(K2_NAME)
})

test('密钥被删 → 回落默认链（清单内首个通用密钥），陈旧选择不复活', async ({ page }) => {
  const headers = await unlockHeaders()
  await generateKey(headers, K1_NAME)
  const k2 = await generateKey(headers, K2_NAME)

  const modal = await openCloneTab(page)
  const select = modal.locator('[data-testid="clone-ssh-key-select"]')

  // 先制造「k2 是上次选择」的记忆
  await fillSshUrlAndBlur(modal, SSH_URL)
  await expect(select).toBeVisible({ timeout: 5000 })
  await pickSshKey(page, modal, K2_NAME)
  await modal.locator('button').filter({ hasText: '取消' }).click()
  await expect(modal).toBeHidden({ timeout: 5000 })

  // 服务端删除 k2（对话框外删除，模拟设置页清钥匙）；删后清单仅剩 k1，
  // 回落目标确定不依赖清单序
  const res = await fetch(`${API_BASE}/api/sshkeys/${k2.id}`, { method: 'DELETE', headers })
  expect(res.ok).toBeTruthy()

  // 重开 + 失焦：读侧对账清单——k2 不在 → 回落自动匹配链选中 k1，陈旧 id 不复活
  const modal2 = await openCloneTab(page)
  await fillSshUrlAndBlur(modal2, SSH_URL)
  const select2 = modal2.locator('[data-testid="clone-ssh-key-select"]')
  await expect(select2).toBeVisible({ timeout: 5000 })
  await expect(select2).toContainText(K1_NAME)
  await expect(select2).not.toContainText(K2_NAME)
})
