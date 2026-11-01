import { test, expect } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { inflateRawSync } from 'node:zlib'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * 会话批量导出口令信封档 E2E（P-20261003-166）：操作条「口令加密」开关开启 →
 * 两次口令输入（P-101 强度警示复用）→ 下载信封 JSON（*.zip.enc.json）→ Node
 * 侧按信封自描述参数（scrypt + AES-256-GCM）解密还原 zip——条目与明文档一致、
 * MANIFEST 带口令加密注记；明文档位（开关缺省关）零变化（直接下 zip、无口令
 * 弹窗）；弱口令黄警示不阻断（警示在场仍可走完导出）。信封封装/解密还原与
 * 护栏的完整校验在 Go 单测 claude_sessions_batch_test.go。
 *
 * 前置与拓扑边界同 session-batch-export.spec.ts：simple-coding 已运行；播种
 * fixture transcript 到真实 ~/.claude/projects（MARK=[e2e-benc]，与 P-165 spec
 * 的 [e2e-bexp] 互不相扰——两 spec 可并行 worker），afterAll 精确删除。
 */

const MARK = '[e2e-benc]'
const FAKE_DIR_NAME = 'D--e2e-benc'
const IDS = ['e2e-benc-a1b2c3d4-0001', 'e2e-benc-a1b2c3d4-0002']
const TITLES = ['信封导出甲会话', '信封导出乙会话']
const STRONG_PASS = 'Corr3ct-Horse-Battery-9'
// 8 位纯数字：过 validate ≥8 下限但命中弱口令（<12 + 单字符类）——验证警示不阻断
const WEAK_PASS_EXPORTABLE = '12345678'
const WEAK_HINT = '口令过弱，归档可被暴力破解'
const ENVELOPE_FORMAT = 'simple-coding.crypt-envelope'
const createdFiles: string[] = []

function buildFixtures() {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString()
  IDS.forEach((id, i) => {
    const title = `${MARK} ${TITLES[i]}`
    const file = path.join(dir, `${id}.jsonl`)
    const lines = [
      `{"type":"last-prompt","sessionId":"${id}"}`,
      JSON.stringify({
        parentUuid: null, isSidechain: false, type: 'user',
        message: { role: 'user', content: title },
        timestamp: at(6), cwd: 'D:\\e2e-benc',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: `${TITLES[i]}的回复` }] },
        timestamp: at(5),
      }),
    ]
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
    const at10 = new Date(Date.now() - 10 * 60_000)
    fs.utimesSync(file, at10, at10)
    createdFiles.push(file)
  })
}

function cleanupFixtures() {
  if (process.env.SC_KEEP_FIXTURES) return
  for (const f of createdFiles) {
    try { fs.unlinkSync(f) } catch { /* already gone */ }
  }
  try { fs.rmdirSync(path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)) } catch { /* non-empty or gone */ }
}

/** 进会话中心并按标记检索（2 条 fixture 全命中），返回选择器根 */
async function openPickerFiltered(page: import('@playwright/test').Page) {
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.locator('.ats-tab', { hasText: 'Claude' }).click()
  const picker = view.locator('.csp-root')
  await expect(picker).toBeVisible({ timeout: 8000 })
  const searchResp = page.waitForResponse(r => r.url().includes('/claude/sessions') && r.url().includes('q='))
  await picker.locator('input').first().fill(MARK)
  await searchResp
  await expect(picker.locator('.csp-row').filter({ hasText: MARK })).toHaveCount(2, { timeout: 15000 })
  return picker
}

// P-112 注记同款：行点击落左缘标题区（避开右侧隐形钮群）
const ROW_CLICK = { position: { x: 30, y: 10 } } as const

// ============== 极简 zip 解包（零依赖，session-batch-export.spec 同款） ==============
function zipCentralEntries(buf: Buffer): string[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) throw new Error('EOCD not found (not a zip?)')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const names: string[] = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central directory at ' + off)
    const nameLen = buf.readUInt16LE(off + 28)
    names.push(buf.toString('utf8', off + 46, off + 46 + nameLen))
    off += 46 + nameLen + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32) + buf.readUInt16LE(off + 36)
  }
  return names
}

function zipEntryContent(buf: Buffer, name: string): string {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) throw new Error('EOCD not found (not a zip?)')
  let off = buf.readUInt32LE(eocd + 16)
  const count = buf.readUInt16LE(eocd + 10)
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const entryName = buf.toString('utf8', off + 46, off + 46 + nameLen)
    const method = buf.readUInt16LE(off + 10)
    const csize = buf.readUInt32LE(off + 20)
    const localOff = buf.readUInt32LE(off + 42)
    if (entryName === name) {
      const lNameLen = buf.readUInt16LE(localOff + 26)
      const lExtraLen = buf.readUInt16LE(localOff + 28)
      const dataStart = localOff + 30 + lNameLen + lExtraLen
      const raw = buf.subarray(dataStart, dataStart + csize)
      return method === 8 ? inflateRawSync(raw).toString('utf8') : raw.toString('utf8')
    }
    off += 46 + nameLen + extraLen + commentLen
  }
  throw new Error(`entry ${name} not found`)
}

/**
 * 按信封自描述参数解密（与后端 config.DecryptWithPassphrase 同语义的 Node
 * 独立重写，非搬运）：scrypt 派生（N=2^16 需 maxmem 放行 128·N·r=64MB 的
 * 内存上限，默认 32MB 会抛）+ AES-256-GCM（Go Seal 的认证标签尾置 16 字节）
 */
function decryptEnvelope(envJson: string, passphrase: string): Buffer {
  const env = JSON.parse(envJson) as {
    format: string; kdf: string; kdfN: number; kdfR: number; kdfP: number
    salt: string; nonce: string; ciphertext: string
  }
  if (env.format !== ENVELOPE_FORMAT || env.kdf !== 'scrypt') {
    throw new Error(`not a passphrase envelope: format=${env.format} kdf=${env.kdf}`)
  }
  const salt = Buffer.from(env.salt, 'base64')
  const nonce = Buffer.from(env.nonce, 'base64')
  const ct = Buffer.from(env.ciphertext, 'base64')
  const key = crypto.scryptSync(passphrase, salt, 32, {
    N: env.kdfN, r: env.kdfR, p: env.kdfP,
    maxmem: 256 * 1024 * 1024,
  })
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(ct.subarray(ct.length - 16))
  return Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()])
}

/** 走完两次口令输入（首次弹窗可注入警示断言），返回下载 */
async function passTwoDialogsAndDownload(
  page: import('@playwright/test').Page,
  passphrase: string,
  onFirstInput?: (dialog: ReturnType<import('@playwright/test').Page['locator']>) => Promise<void>,
) {
  const dialog = page.locator('.n-dialog').filter({ hasText: '设置归档口令' })
  await expect(dialog).toBeVisible({ timeout: 5000 })
  const input = dialog.locator('input')
  await input.fill(passphrase)
  if (onFirstInput) await onFirstInput(dialog)
  await dialog.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()
  const confirmDialog = page.locator('.n-dialog').filter({ hasText: '请再次输入口令以确认' })
  await expect(confirmDialog).toBeVisible({ timeout: 5000 })
  await confirmDialog.locator('input').fill(passphrase)
  const downloadPromise = page.waitForEvent('download', { timeout: 30000 })
  await confirmDialog.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()
  return downloadPromise
}

test.describe('会话批量导出口令信封档（P-20261003-166）', () => {
  test.beforeAll(() => {
    buildFixtures()
  })

  test.afterAll(() => {
    cleanupFixtures()
  })

  test('口令加密导出 → 信封解密还原 zip：条目与明文档一致 + MANIFEST 加密注记', async ({ page }) => {
    test.setTimeout(90000)
    await fixedLocale(page)
    const picker = await openPickerFiltered(page)
    const rows = picker.locator('.csp-row').filter({ hasText: MARK })
    for (let i = 0; i < 2; i++) {
      await rows.nth(i).click({ modifiers: ['Control'], ...ROW_CLICK })
    }
    const bar = picker.locator('[data-test="session-batch-bar"]')
    await expect(bar).toBeVisible()

    // 开关缺省关（明文档位）；开启后 is-on 态
    const encToggle = bar.locator('[data-test="session-batch-enc"]')
    await expect(encToggle).toHaveAttribute('aria-pressed', 'false')
    await encToggle.click()
    await expect(encToggle).toHaveAttribute('aria-pressed', 'true')

    // 导出 → 两次口令 → 下载信封 JSON（服务端 scrypt 派生在途，下载放宽时限）
    await bar.locator('[data-test="session-batch-export"]').click()
    const dl = await passTwoDialogsAndDownload(page, STRONG_PASS)
    expect(dl.suggestedFilename()).toMatch(/^claude-sessions-\d{8}\.zip\.enc\.json$/)

    // 信封形态：JSON 可解析、format 标识在位、明文 zip 魔数绝不能裸奔在外
    const raw = fs.readFileSync(await dl.path(), 'utf-8')
    expect(raw.startsWith('PK')).toBe(false)
    expect(JSON.parse(raw).format).toBe(ENVELOPE_FORMAT)

    // 解密还原 zip：条目 = 2 md + MANIFEST，md 命中 fixture 标题
    const zip = decryptEnvelope(raw, STRONG_PASS)
    expect(zip.subarray(0, 2).toString('latin1')).toBe('PK')
    const names = zipCentralEntries(zip)
    const mdNames = names.filter(n => n.endsWith('.md'))
    expect(names).toContain('MANIFEST.txt')
    expect(mdNames).toHaveLength(2)
    const allMd = mdNames.map(n => zipEntryContent(zip, n)).join('\n')
    for (let i = 0; i < 2; i++) {
      expect(allMd).toContain(`${MARK} ${TITLES[i]}`)
    }

    // MANIFEST 加密注记（解密后归档的自描述）
    const mani = zipEntryContent(zip, 'MANIFEST.txt')
    expect(mani).toContain('口令加密：已启用')
    expect(mani).toContain('导出 2 个会话，跳过 0 个')

    // 错口令解不开（GCM 认证失败）
    expect(() => decryptEnvelope(raw, 'Wrong-Passphrase-1')).toThrow()

    // 导出成功选择集清空，操作条收起
    await expect(bar).toBeHidden()
  })

  test('明文缺省档零变化：开关不动 → 无口令弹窗直接下 zip', async ({ page }) => {
    await fixedLocale(page)
    const picker = await openPickerFiltered(page)
    const rows = picker.locator('.csp-row').filter({ hasText: MARK })
    for (let i = 0; i < 2; i++) {
      await rows.nth(i).click({ modifiers: ['Control'], ...ROW_CLICK })
    }
    const bar = picker.locator('[data-test="session-batch-bar"]')
    await expect(bar).toBeVisible()
    await expect(bar.locator('[data-test="session-batch-enc"]')).toHaveAttribute('aria-pressed', 'false')

    // 明文导出：不弹口令框、直接下载 zip（P-165 档位零变化）
    const dlPromise = page.waitForEvent('download')
    await bar.locator('[data-test="session-batch-export"]').click()
    const dl = await dlPromise
    expect(dl.suggestedFilename()).toMatch(/^claude-sessions-\d{8}\.zip$/)
    const buf = fs.readFileSync(await dl.path())
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK')
    expect(zipCentralEntries(buf).filter(n => n.endsWith('.md'))).toHaveLength(2)
  })

  test('弱口令黄警示不阻断：警示在场仍可走完两次输入完成加密导出', async ({ page }) => {
    await fixedLocale(page)
    const picker = await openPickerFiltered(page)
    const rows = picker.locator('.csp-row').filter({ hasText: MARK })
    await rows.first().click({ modifiers: ['Control'], ...ROW_CLICK })
    const bar = picker.locator('[data-test="session-batch-bar"]')
    await expect(bar).toBeVisible()
    await bar.locator('[data-test="session-batch-enc"]').click()

    await bar.locator('[data-test="session-batch-export"]').click()
    // 弱口令（8 位纯数字，过 ≥8 下限但命中弱口令）：黄警示实时出现…
    const dl = await passTwoDialogsAndDownload(page, WEAK_PASS_EXPORTABLE, async (dialog) => {
      const hint = dialog.getByText(WEAK_HINT)
      await expect(hint).toBeVisible()
      await expect(hint).toHaveAttribute('style', /var\(--accent-yellow\)/)
      // 强口令对照：警示消失（阈值是 12/字符类，与 8 位下限正交）
      await dialog.locator('input').fill(STRONG_PASS)
      await expect(dialog.getByText(WEAK_HINT)).toHaveCount(0)
      // 回到弱口令：警示复现且不阻断（外层继续确认导出）
      await dialog.locator('input').fill(WEAK_PASS_EXPORTABLE)
      await expect(hint).toBeVisible()
    })
    // 警示不阻断：导出照常落定，下载的是信封而非 zip
    expect(dl.suggestedFilename()).toMatch(/\.zip\.enc\.json$/)
    expect(JSON.parse(fs.readFileSync(await dl.path(), 'utf-8')).format).toBe(ENVELOPE_FORMAT)
  })
})
