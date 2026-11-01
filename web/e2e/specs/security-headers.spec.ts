import { test, expect, type APIRequestContext } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 主应用安全响应头基线（P-20261002-42，server/middleware SecurityHeaders）E2E：
 * 全局中间件对主引擎全部响应施三头——
 *   1. SPA 入口（/ → index.html，经 NoRoute 静态路径）
 *   2. SPA deep-link 回落（未注册前端路由 → index.html 回落，锁屏所在载体）
 *   3. 免鉴权 API（/api/lock/state）与注册 API（/api/health）
 * 三头：X-Content-Type-Options: nosniff / Referrer-Policy:
 * strict-origin-when-cross-origin / X-Frame-Options: SAMEORIGIN（同源嵌框放行，
 * e2e 全程同源不阻断）。无 TLS 实例不断言 HSTS。
 * 分享访客子服务（独立端口）自带更严头，不在本 spec 范围。
 * P-20261002-121 追加：私有内容 no-store 缓存头——files 域读取面携带，
 * 公共静态（index.html no-cache 分级）不被波及（作用域纪律）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

const BASELINE: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
}

/** 私有内容缓存头对（与服务端 noStoreHeaders 同值） */
const NO_STORE: Record<string, string> = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
}

/** 断言三头存在、值精确且无重复（中央代理剥上游冗余后同值单发） */
async function expectBaselineHeaders(
  request: APIRequestContext,
  path: string,
  sanity?: { status: number; contentTypeIncludes: string },
) {
  const res = await request.get(`${BASE}${path}`)
  if (sanity) {
    expect(res.status()).toBe(sanity.status)
    expect(res.headers()['content-type']).toContain(sanity.contentTypeIncludes)
  }
  for (const [name, want] of Object.entries(BASELINE)) {
    const values = res.headersArray().filter(h => h.name.toLowerCase() === name.toLowerCase()).map(h => h.value)
    expect(values, `${path} ${name}`).toEqual([want])
  }
}

test('SPA 入口与 deep-link 回落携三头基线', async ({ request }) => {
  await expectBaselineHeaders(request, '/', { status: 200, contentTypeIncludes: 'text/html' })
  // 未注册前端路由：NoRoute 回落 index.html（锁屏 overlay 所在页载体，
  // SAMEORIGIN 挡第三方站点 iframe clickjacking 的正是这一响应）
  await expectBaselineHeaders(request, '/projects/some-deep-link', { status: 200, contentTypeIncludes: 'text/html' })
})

test('API 响应携三头基线（免鉴权与注册路由各一）', async ({ request }) => {
  await expectBaselineHeaders(request, '/api/lock/state', { status: 200, contentTypeIncludes: 'application/json' })
  await expectBaselineHeaders(request, '/api/health', { status: 200, contentTypeIncludes: 'application/json' })
})

// ── P-20261002-121：私有内容 no-store ──

test('公共静态维持自身缓存策略，不被 no-store 波及', async ({ request }) => {
  // index.html → no-cache（app.go 分级策略：保证新版本入口即时可见）；
  // no-store 是路由级中间件，只属于私有内容端点，静态路径不得被覆盖
  const res = await request.get(`${BASE}/`)
  expect(res.status()).toBe(200)
  expect(res.headers()['cache-control']).toBe('no-cache')
})

test('files 域读取面（策略/内容/下载）携 no-store 双头', async ({ request }) => {
  // 自备临时仓库（范式同 file-policy-cards：unlock → 注册 → 断言 → 清理）
  const dir = path.join(os.tmpdir(), 'sc-e2e-nostore')
  const git = (args: string[]) =>
    execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd: dir, encoding: 'utf8' })
  const unlock = async (): Promise<Record<string, string>> => {
    const res = await fetch(`${API_BASE}/api/lock/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: DEFAULT_PASSWORD }),
    })
    const token = ((await res.json()) as { token?: string }).token || ''
    return { 'X-Lock-Token': token }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'note.txt'), 'no-store e2e\n')
  git(['add', '.'])
  git(['commit', '-m', 'root: nostore 基线'])
  const headers = await unlock()
  // 残留清理（范式同 file-policy-cards：同名先删再注册）
  const stale = (await (await fetch(`${API_BASE}/api/projects`, { headers })).json()) as {
    data?: { id: string; name: string }[]
  }
  for (const p of stale.data || []) {
    if (p.name === 'e2e-nostore') {
      await request.delete(`${BASE}/api/projects/${p.id}`, { headers })
    }
  }
  const regRes = await request.post(`${BASE}/api/projects`, {
    headers,
    data: { name: 'e2e-nostore', path: serverPath(dir) },
  })
  expect([200, 201]).toContain(regRes.status())
  const projectId = (((await regRes.json()) as { data?: { id?: string } }).data?.id) || ''
  try {
    for (const p of ['/file-policy?path=note.txt', '/file?path=note.txt', '/file/download?path=note.txt']) {
      const res = await request.get(`${BASE}/api/projects/${projectId}${p}`, { headers })
      expect(res.status(), p).toBe(200)
      for (const [name, want] of Object.entries(NO_STORE)) {
        const values = res.headersArray().filter(h => h.name.toLowerCase() === name.toLowerCase()).map(h => h.value)
        expect(values, `${p} ${name}`).toEqual([want])
      }
    }
  } finally {
    if (projectId) {
      await request.delete(`${BASE}/api/projects/${projectId}`, { headers })
    }
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
})
