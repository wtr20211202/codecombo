import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 单文件下载 Content-Disposition 契约（P-20261003-109）：服务端头值统一经
 * shared.ContentDispositionFile 净化产出——ASCII 名与历史手拼形态逐字节兼容、
 * 中文名走 RFC 5987 filename* 百分号编码；再用真实浏览器锚点下载验证中文
 * 文件名可存（浏览器按 filename* 解码出保存名）。净化/注入剥离的全量边界
 * 在 server/api/shared/contentdisposition_test.go（Go 单测），此处只钉端到端面。
 *
 * 前置：播种金态锁定关闭（e2e-seed 惯例）——浏览器锚点下载无法携带
 * X-Lock-Token 头，依赖锁定关闭态放行 /api。探针建在 simple-coding 仓库
 * docs/ 下（file-tree-dir-zip 同款播种惯例），afterAll 清理。
 */

const PROBE_DIR = 'e2e-dl-disp'
const ASCII_FILE = `${PROBE_DIR}/plain.txt`
const CJK_NAME = '中文下载.txt'
const CJK_FILE = `${PROBE_DIR}/${CJK_NAME}`
// 中 U+4E2D→E4B8AD 文 U+6587→E69687 下 U+4E0B→E4B88B 载 U+8F7D→E8BDBD（大写 hex，RFC 5987 口径）
const CJK_ENCODED = '%E4%B8%AD%E6%96%87%E4%B8%8B%E8%BD%BD'

async function lockToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  if (!res.ok()) throw new Error(`unlock failed: ${res.status()}`)
  return ((await res.json()) as { token: string }).token
}

async function projectId(request: APIRequestContext): Promise<string> {
  const token = await lockToken(request)
  const list = await (await request.get(`${API_BASE}/api/projects`, { headers: { 'X-Lock-Token': token } })).json()
  const mine = ((list?.data || []) as { id: string; name: string }[]).find(p => p.name === 'simple-coding')
  if (!mine) throw new Error('simple-coding 项目不存在')
  return mine.id
}

/** 播种/清理共用：file/create 写探针、file/delete 摘除（dir-zip spec 同款端点） */
async function fileOp(
  request: APIRequestContext,
  action: 'create' | 'delete',
  path: string,
): Promise<{ ok: boolean; status: number }> {
  const token = await lockToken(request)
  const res = await request.post(`${API_BASE}/api/projects/` + (await projectId(request)) + `/file/${action}`, {
    headers: { 'X-Lock-Token': token },
    data: { path, content: 'dl-disposition-probe' },
  })
  return { ok: res.ok(), status: res.status() }
}

test.beforeAll(async ({ request }) => {
  // delete 容忍 404（首跑无残留属常态）；create 失败必须炸响——静默失败会把
  // 问题拖成用例中段的诡异 404（file-tree-dir-zip 首跑实测教训）
  for (const p of [ASCII_FILE, CJK_FILE, PROBE_DIR]) {
    await fileOp(request, 'delete', p).catch(() => null)
  }
  for (const p of [ASCII_FILE, CJK_FILE]) {
    const r = await fileOp(request, 'create', p)
    if (!r.ok) throw new Error(`seed create ${p} failed: HTTP ${r.status}`)
  }
})

test.afterAll(async ({ request }) => {
  for (const p of [ASCII_FILE, CJK_FILE, PROBE_DIR]) {
    await fileOp(request, 'delete', p).catch(() => null)
  }
})

test('ASCII 名：下载头双形式与历史手拼输出逐字节一致', async ({ request }) => {
  const token = await lockToken(request)
  const pid = await projectId(request)
  const res = await request.get(
    `${API_BASE}/api/projects/${pid}/file/download?path=${encodeURIComponent(ASCII_FILE)}`,
    { headers: { 'X-Lock-Token': token } },
  )
  expect(res.status()).toBe(200)
  // 统一 helper 的 ASCII 兼容断言：切换前后浏览器可见形态不变（双形式全保留）
  expect(res.headers()['content-disposition']).toBe(
    `attachment; filename="plain.txt"; filename*=UTF-8''plain.txt`,
  )
})

test('中文名：RFC 5987 头形态 + 浏览器锚点下载保存名还原中文', async ({ page, request }) => {
  const token = await lockToken(request)
  const pid = await projectId(request)

  // 服务端头形态：filename 兜底折叠非 ASCII（中文下载 4 字 → 4 下划线），
  // filename* 承载真实名（大写 hex）
  const res = await request.get(
    `${API_BASE}/api/projects/${pid}/file/download?path=${encodeURIComponent(CJK_FILE)}`,
    { headers: { 'X-Lock-Token': token } },
  )
  expect(res.status()).toBe(200)
  expect(res.headers()['content-disposition']).toBe(
    `attachment; filename="____.txt"; filename*=UTF-8''${CJK_ENCODED}.txt`,
  )

  // 浏览器真实下载：同源锚点（无 download 属性 → 保存名由响应头 filename*
  // 决定），Chromium 解码 RFC 5987 得中文保存名——「中文文件名可存」端到端证据
  await gotoAndUnlock(page, '/')
  const dlPromise = page.waitForEvent('download')
  await page.evaluate(
    url => {
      const a = document.createElement('a')
      a.href = url
      document.body.appendChild(a)
      a.click()
      a.remove()
    },
    `${API_BASE}/api/projects/${pid}/file/download?path=${encodeURIComponent(CJK_FILE)}`,
  )
  const dl = await dlPromise
  expect(dl.suggestedFilename()).toBe(CJK_NAME)
})
