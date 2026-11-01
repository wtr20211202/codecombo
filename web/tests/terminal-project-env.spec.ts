import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD } from './helpers'
import { serverIsLinux, serverPath } from './dualpath'

/**
 * 项目标识环境注入 E2E（P-20261003-307）：
 *   1. 项目绑定会话（kind=shell + projectId）：终端内 echo 探针 →
 *      SC_PROJECT_ID = 注册 id、SC_PROJECT_PATH = 注册根路径
 *   2. 免项目会话（kind=agent + runtime=shell，临时目录）：同探针 → 两枚缺省
 *      （GET /api/projects 按路径反查语义保留）
 *
 * 全 API 驱动：建会话 → broadcast-write 写探针（unlock 令牌是用户本人 scl_，
 * 不受 AgentGuard 机器令牌限制）→ 轮询 scrollback 断言。探针命令按服务端
 * shell 语法二态（dualpath.serverIsLinux，同 serverPath 的服务端形态约定）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

interface ProjectInfo {
  id: string
  path: string
}

async function getSeededProject(request: APIRequestContext): Promise<ProjectInfo> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/projects`, { headers })
  const list = ((await res.json()) as { data?: { id: string; path: string; name: string }[] }).data || []
  const p = list.find(x => x.name === 'simple-coding')
  if (!p) throw new Error('simple-coding project not found')
  return { id: p.id, path: p.path }
}

/** 建会话（body 透传），返回会话 id 并登记给 afterEach 清理 */
async function createSession(
  request: APIRequestContext,
  body: Record<string, string>,
  created: string[],
): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.post(`${BASE}/api/terminals`, { headers, data: body })
  expect(res.ok()).toBeTruthy()
  const { data } = (await res.json()) as { data?: { id?: string } }
  const id = data?.id || ''
  expect(id).not.toBe('')
  created.push(id)
  return id
}

/** 向会话写探针命令（原始 PTY 输入，尾部 \r 执行） */
async function writeProbe(request: APIRequestContext, id: string, probe: string): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.post(`${BASE}/api/terminals/broadcast-write`, {
    headers,
    data: { ids: [id], data: probe + '\r' },
  })
  expect(res.ok()).toBeTruthy()
}

async function readScrollback(request: APIRequestContext, id: string): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals/${id}/scrollback`, { headers })
  expect(res.ok()).toBeTruthy()
  return await res.text()
}

/** 轮询 scrollback 直到出现 substr——shell 就绪 + 探针执行完的确定性等待 */
async function waitForScrollback(request: APIRequestContext, id: string, substr: string): Promise<string> {
  let text = ''
  await expect(async () => {
    text = await readScrollback(request, id)
    expect(text).toContain(substr)
  }).toPass({ timeout: 20000 })
  return text
}

/** 探针命令行：输出 ID=<值> / PATH=<值> / SC_PROBE_DONE 哨兵（PowerShell/bash 二态） */
function probeCommand(): string {
  return serverIsLinux
    ? 'echo ID=$SC_PROJECT_ID; echo PATH=$SC_PROJECT_PATH; echo SC_PROBE_DONE'
    : 'echo ID=$env:SC_PROJECT_ID; echo PATH=$env:SC_PROJECT_PATH; echo SC_PROBE_DONE'
}

test.describe('项目标识环境注入（P-20261003-307）', () => {
  let created: string[] = []

  test.afterEach(async ({ request }) => {
    const headers = await unlockHeaders(request)
    for (const id of created) {
      await request.delete(`${BASE}/api/terminals/${id}`, { headers })
    }
    created = []
  })

  test('项目绑定会话：echo 输出 SC_PROJECT_ID/SC_PROJECT_PATH', async ({ request }) => {
    const project = await getSeededProject(request)
    const id = await createSession(request, { name: 'projenv-probe', projectId: project.id }, created)
    await writeProbe(request, id, probeCommand())
    const text = await waitForScrollback(request, id, `ID=${project.id}`)
    expect(text).toContain(`PATH=${project.path}`)
  })

  test('免项目会话：两枚缺省（反查语义保留）', async ({ request }) => {
    const project = await getSeededProject(request)
    const dir = await mkdtemp(path.join(tmpdir(), 'sc-projenv-'))
    const id = await createSession(
      request,
      { kind: 'agent', runtime: 'shell', dir: serverPath(dir) },
      created,
    )
    await writeProbe(request, id, probeCommand())
    // SC_PROBE_DONE 出现 = 探针命令已执行完，此后的缺省断言才成立
    const text = await waitForScrollback(request, id, 'SC_PROBE_DONE')
    expect(text).not.toContain(`ID=${project.id}`)
    expect(text).not.toContain(`PATH=${project.path}`)
  })
})
