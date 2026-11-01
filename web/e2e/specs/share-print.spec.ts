import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD } from '../../tests/helpers'

/**
 * 分享访客页打印样式（独立渲染页 server/share/page.go page-css）E2E：
 * emulateMedia print 后——
 *   1. 导航/装饰隐藏：滚动指示条 topbar / 背景 blob / 页头操作按钮
 *   2. 暗色主题翻转为黑字白底（浏览器打印默认去背景，暗色浅字必须显式翻转）
 *   3. pre 换行防溢出页宽、代码块/表格 break-inside: avoid 防跨页截断
 * 探针 md（代码块+表格）经管理 API 建到真实项目，跑完清理不残留
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJECT_NAME = 'simple-coding'
const PROBE_PATH = 'e2e-share-print.md'

const PROBE_MD = [
  '# 打印样式验证',
  '',
  '正文段落用于确认打印媒体下的可读性。',
  '',
  '```go',
  'func main() {',
  '\tprintln("hello print")',
  '}',
  '```',
  '',
  '| 列A | 列B |',
  '| ---- | ---- |',
  '| a1 | b1 |',
  '',
].join('\n')

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清空全部分享（服务端全局状态，保证确定性） */
async function cleanupShares(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/share`, { headers })
  const list = ((await res.json()) as { data?: { token: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/share/${s.token}`, { headers })
  }
}

async function getProjectId(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/projects`, { headers })
  const projects = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  const p = projects.find(x => x.name === PROJECT_NAME)
  if (!p) throw new Error(`project ${PROJECT_NAME} not found`)
  return p.id
}

async function getShareBase(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/share/status`, { headers })
  const status = ((await res.json()) as { data?: { running: boolean; port: number; scheme: string } }).data
  if (!status?.running) throw new Error('share service not running')
  return `${status.scheme || 'http'}://localhost:${status.port}`
}

test.beforeEach(async ({ request }) => {
  await cleanupShares(request)
})

test('打印媒体：导航装饰隐藏 + 暗色翻转为黑字白底 + 代码表格防截断', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)

  // 探针 md：含代码块与表格（break-inside / pre-wrap 断言载体）；先删后建幂等
  await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path: PROBE_PATH } })
  const res = await request.post(`${BASE}/api/projects/${projectId}/file/create`, {
    headers, data: { path: PROBE_PATH, content: PROBE_MD },
  })
  expect(res.ok()).toBeTruthy()
  const created = await request.post(`${BASE}/api/share`, {
    headers, data: { projectId, path: PROBE_PATH },
  })
  const s = ((await created.json()) as { data?: { token: string } }).data
  expect(s?.token).toBeTruthy()

  const shareBase = await getShareBase(request, headers)
  await page.goto(`${shareBase}/s/${s!.token}`)

  // md 渲染片段注入完成：代码块与表格就位
  const pre = page.locator('.md-article pre').first()
  await expect(pre).toBeVisible({ timeout: 10_000 })
  const tblWrap = page.locator('.tbl-wrap').first()
  await expect(tblWrap).toBeVisible()

  // 屏显基线（暗色系统偏好）：正文为浅色字，证明后续翻转断言非空转
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('.md-article h1')).toHaveCSS('color', 'rgb(230, 234, 243)')

  // 切打印媒体（保持暗色偏好，验证 token 翻转压过暗色主题）
  await page.emulateMedia({ media: 'print', colorScheme: 'dark' })

  // ① 导航/装饰隐藏：滚动指示条 / 背景 blob / 页头操作按钮（下载/复制/导出/主题）
  await expect(page.locator('.topbar')).toHaveCSS('display', 'none')
  await expect(page.locator('.blob').first()).toHaveCSS('display', 'none')
  await expect(page.locator('.header .actions')).toHaveCSS('display', 'none')

  // ② 暗色 token 翻转：黑字白底（打印去背景下依然可读）
  await expect(page.locator('.md-article h1')).toHaveCSS('color', 'rgb(0, 0, 0)')
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)')

  // ③ pre 换行防溢出页宽 + 代码块/表格防跨页截断
  await expect(pre).toHaveCSS('white-space', 'pre-wrap')
  await expect(pre).toHaveCSS('break-inside', 'avoid')
  await expect(tblWrap).toHaveCSS('break-inside', 'avoid')

  // 清理：撤销分享 + 删探针文件（此 spec 用真实项目仓库，不得残留）
  await request.delete(`${BASE}/api/share/${s!.token}`, { headers })
  const cleanup = await request.post(`${BASE}/api/projects/${projectId}/file/delete`, {
    headers, data: { path: PROBE_PATH },
  })
  expect(cleanup.ok()).toBeTruthy()
})
