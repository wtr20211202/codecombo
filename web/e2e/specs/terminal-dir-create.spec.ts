import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 目录级终端直达（P-20261005-192）服务端契约 E2E：POST /terminals 项目会话可选
 * dir（项目根内子目录，相对/绝对均可）——
 *   1. 相对子目录 → 200，data.path = 子目录（创建即落点，服务端斜杠形态）
 *   2. 首 prompt cwd 在目标目录：GET /api/terminals 的 currentDir（OSC 7 随
 *      shellint 首个 prompt 发射，无 UI 链路同样成立）poll 到子目录
 *   3. 绝对路径（项目根内）→ 200 同落点
 *   4. 越界：相对 ".." 与项目外绝对路径 → 400 "path traversal not allowed"
 *      （P-29 errmarkers 稳定原文，前端 KNOWN_ERROR_I18N 既有映射）
 *   5. 缺失目录 → 400 "path does not exist or is not a directory"（项目注册同文）
 *   6. 缺省（无 dir）→ path = 项目根（既有行为零变化回归面）
 * 前置（spec 内自备）：临时项目 + sub/deeper 两级夹具；路径交服务端一律
 * serverPath（跨拓扑口径）；afterAll 清会话/项目/夹具
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-term-dir-create'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-term-dir-create')
const SUB = 'sub'
const DEEP = 'sub/deeper'
const SUB_FILE = path.join(REPO_DIR, DEEP, 'probe.txt')

let unlockToken = ''
let projId = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json }
}

interface SessionRow { id: string; path: string; currentDir?: string }

/** 统一斜杠后的路径（服务端 win/linux 形态折算，断言只看尾部相对结构） */
function norm(p: string): string {
  return p.replace(/\\/g, '/')
}

async function createSession(dir?: string): Promise<{ status: number; row?: SessionRow; message?: string }> {
  const res = await api('POST', '/api/terminals', dir === undefined ? { projectId: projId } : { projectId: projId, dir })
  const row = res.json?.data as SessionRow | undefined
  return { status: res.status, row, message: res.json?.error || res.json?.message }
}

/** 清理本项目全部终端会话（tmux 后端下会话随服务重启存活，残留会污染后续轮次） */
async function cleanupSessions(): Promise<void> {
  const res = await api('GET', '/api/terminals')
  for (const s of (res.json?.data || []) as SessionRow[]) {
    await api('DELETE', `/api/terminals/${s.id}`)
  }
}

test.beforeAll(async () => {
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''

  const stale = await api('GET', '/api/projects')
  const oldProj = ((stale.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (oldProj) {
    await cleanupSessions()
    await api('DELETE', `/api/projects/${oldProj.id}`)
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(path.dirname(SUB_FILE), { recursive: true })
  fs.writeFileSync(SUB_FILE, 'dir-terminal probe\n')
  // 注册项目：路径交给服务端一律 serverPath 折算（跨拓扑口径）
  const proj = await api('POST', '/api/projects', { name: PROJ_NAME, path: serverPath(REPO_DIR) })
  expect([200, 201]).toContain(proj.status)
  projId = String(proj.json?.data?.id || '')
})

test.afterAll(async () => {
  try { await cleanupSessions() } catch { /* 服务未起等场景忽略 */ }
  const list = await api('GET', '/api/projects')
  const mine = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (mine) await api('DELETE', `/api/projects/${mine.id}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* shell 占用时忽略 */ }
})

test('相对子目录创建：path 落子目录，首 prompt cwd（OSC 7）跟进', async () => {
  const { status, row } = await createSession(DEEP)
  expect(status, `创建应成功：${JSON.stringify(row)}`).toBe(200)
  expect(row?.id, '响应应带回会话 id').toBeTruthy()
  // 创建即落点：响应 path = 子目录（服务端斜杠形态尾部为相对结构）
  expect(norm(row?.path || '').endsWith(`${DEEP}`), `path 应落在 ${DEEP}，实际 ${row?.path}`).toBe(true)

  // 首 prompt cwd：shellint OSC 7 随首个 prompt 发射（无需 UI/输入），服务端
  // readLoop 旁挂解析进快照 currentDir——poll 到子目录即「会话建立即在目标目录」。
  // currentDir 是服务端本机路径形态（Windows 反斜杠），先 norm 统一斜杠再比对
  //（与上方 path 断言同口径；首次运行漏 norm 恒不命中即本用例）
  await expect.poll(async () => {
    const res = await api('GET', '/api/terminals')
    const mine = ((res.json?.data || []) as SessionRow[]).find(s => s.id === row?.id)
    return norm(mine?.currentDir ?? '')
  }, { timeout: 30000 }).toContain(DEEP)
})

test('绝对路径（项目根内）与缺省行为', async () => {
  // 绝对路径在根内 → 同一落点
  const abs = await createSession(serverPath(path.join(REPO_DIR, SUB)))
  expect(abs.status).toBe(200)
  expect(norm(abs.row?.path || '').endsWith(`/${SUB}`)).toBe(true)

  // 缺省（无 dir）→ 项目根（既有行为零变化）
  const def = await createSession()
  expect(def.status).toBe(200)
  expect(norm(def.row?.path || '').endsWith(PROJ_NAME)).toBe(true)
})

test('越界 400 稳定原文（P-29 errmarkers 族）', async () => {
  // 相对穿越
  const rel = await createSession('../..')
  expect(rel.status).toBe(400)
  expect(rel.message).toContain('path traversal not allowed')
  // 项目外绝对路径（折算后越界同判）
  const outside = await createSession(serverPath(path.join(path.dirname(REPO_DIR), 'outside-dir-terminal')))
  expect(outside.status).toBe(400)
  expect(outside.message).toContain('path traversal not allowed')
})

test('缺失目录 400 稳定原文（与项目注册同文同映射）', async () => {
  const res = await createSession('no-such-dir')
  expect(res.status).toBe(400)
  expect(res.message).toContain('path does not exist or is not a directory')
})
