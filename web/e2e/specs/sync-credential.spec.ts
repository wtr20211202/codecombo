import { test, expect, type APIRequestContext } from '@playwright/test'
import http from 'node:http'
import crypto from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 手动携密同步 E2E（P-20261024-3）：配对密钥端到端加密通道 + 双端确认仪式 +
 * 定时/自动携密服务端硬拒（红线）。
 *
 *   1. 配对面：生成（一次性配对码）→ 录入归一（非法形态拒绝）→ 状态面 pairFp
 *   2. 红线面：未勾开关的 push 恒不触携密端点；units 走私凭据键拒绝（审计稳定
 *      标记）；定时任务模型无携密字段（配置漂移打不破）
 *   3. 发起面：配对未核对 → push 失败且审计带稳定标记 → verify 后重推 →
 *      对端存根收到 mode=cred E2E 信封（密文内无明文秘密）
 *   4. 接收面（真实服务端 = 接收端，node 存根 = 发起端；重置配对回到未核对态）：
 *      未核对 → 202 暂存不落盘 → 确认落盘 → 重放拒绝 → 篡改拒绝 → 审计在账
 *   5. 服务面（pull）：无指纹头 403 → 正确指纹出 E2E 信封 → node 端解链成功
 *   6. UI：携密开关 / 配对徽章 / 红线注记在场
 *
 * 对端存根与真实服务共享配对钥（spec 经 generate 端点取得一次性配对码），
 * node crypto HKDF-SHA256 + AES-256-GCM 与服务端 envelope 格式对齐（seal/open
 * 跨实现互验——信封格式的互操作契约由本 spec 锚定）。
 */

const BASE = API_BASE
const PEER_NAME = 'e2e-cred-peer'
const PEER_TOKEN = 'sc_e2e_cred_token'
const PROJ_NAME = 'e2e-cred-demo'
const PROJ_BASE = 'e2e-cred-demo-dir'
const SECRET_MARK = 'sc-e2e-cred-secret-DONT-LEAK'
const CRED_HOST = 'e2e-cred.example.com'
const HKDF_INFO = 'simple-coding.credsync/v1'

let unlockToken = ''
let instanceId = ''
let projectId = ''
let projRoot = ''
let prevCredentialIds: string[] = []

// stub 状态：携密信封（mode=cred）与普通落位（mode=land）分开计数
const stubState = {
  credPostCount: 0,
  credEnvelope: '' as string,
  landCount: 0,
}

// ── node 侧信封实现（与服务端 server/api/sync/crede2e.go 格式契约互验）──

function hkdfKey(pairingKey: Buffer, salt: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', pairingKey, salt, Buffer.from(HKDF_INFO), 32))
}

function pairFp(pairingKey: Buffer): string {
  return crypto.createHash('sha256').update(pairingKey).digest('hex').slice(0, 16)
}

/** sealEnvelope 与服务端 sealCredVault 同构：AAD=format|version|pairFp|dir|seq */
function sealEnvelope(pairingKey: Buffer, vault: unknown, dir: 'push' | 'pull', seq: number): Record<string, unknown> {
  const salt = crypto.randomBytes(16)
  const nonce = crypto.randomBytes(12)
  const key = hkdfKey(pairingKey, salt)
  const fp = pairFp(pairingKey)
  const aad = Buffer.from(`simple-coding.credsync|1|${fp}|${dir}|${seq}`)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad)
  const plain = Buffer.concat([cipher.update(JSON.stringify(vault), 'utf8'), cipher.final()])
  const ct = Buffer.concat([plain, cipher.getAuthTag()]) // Go gcm.Seal 输出形态 = 密文||tag
  return {
    format: 'simple-coding.credsync', version: 1, pairFp: fp, dir,
    kdf: 'hkdf-sha256', salt: salt.toString('base64'), nonce: nonce.toString('base64'),
    seq, ciphertext: ct.toString('base64'),
  }
}

function openEnvelope(pairingKey: Buffer, env: Record<string, unknown>): { vault: unknown; seq: number } {
  const salt = Buffer.from(env.salt as string, 'base64')
  const nonce = Buffer.from(env.nonce as string, 'base64')
  const key = hkdfKey(pairingKey, salt)
  const aad = Buffer.from(`simple-coding.credsync|1|${env.pairFp}|${env.dir}|${env.seq}`)
  const ct = Buffer.from(env.ciphertext as string, 'base64')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(aad)
  decipher.setAuthTag(ct.subarray(ct.length - 16))
  const plain = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()])
  return { vault: JSON.parse(plain.toString('utf8')), seq: env.seq as number }
}

// 对端存根：探活/能力/普通落位回执/携密收件（mode=cred 记录信封并按暂存回 202）
function stubHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.url?.startsWith('/api/settings')) {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ data: { version: '9.9.9-cred-e2e' } }))
    return
  }
  if (req.url?.startsWith('/api/meta')) {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      version: { version: '9.9.9-cred-e2e', commit: 'e2e', buildTime: '', apiVersion: '1.0.0' },
      capabilities: ['sync'],
    }))
    return
  }
  if (req.url?.startsWith('/api/sync/manifest')) {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ data: { units: [], diskFree: 1 << 30, destRoot: '/stub/dest', version: '9.9.9-cred-e2e' } }))
    return
  }
  if (req.url?.startsWith('/api/sync/units') && req.method === 'POST') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const mode = new URL(req.url!, 'http://x').searchParams.get('mode') || 'land'
      res.setHeader('Content-Type', 'application/json')
      if (mode === 'cred') {
        stubState.credPostCount++
        stubState.credEnvelope = Buffer.concat(chunks).toString('utf8')
        res.statusCode = 202
        res.end(JSON.stringify({ data: { staged: true, ticket: 'stub-ticket', summary: 'stub' } }))
        return
      }
      stubState.landCount++
      res.end(JSON.stringify({ data: { units: [{ key: `project:${PROJ_BASE}`, ok: true, projectId: 'stub-project' }], destRoot: '/stub/dest' } }))
    })
    return
  }
  res.statusCode = 404
  res.end('not a cred endpoint')
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  return { 'X-Lock-Token': ((await res.json()) as { token?: string }).token || '' }
}

let peer: http.Server
let pairingKeyBuf = Buffer.alloc(0) // 规范形态：64 位 hex 字符串字节（双端一致）
let pairingCodePlain = '' // 一次性配对码（供接收面重置配对回未核对态）

test.beforeAll(async ({ request }) => {
  unlockToken = (await unlockHeaders(request))['X-Lock-Token']
  const auth = { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken }

  peer = http.createServer(stubHandler)
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve))
  const peerPort = (peer.address() as AddressInfo).port

  // 记录既有凭据（afterAll 只清理本 spec 新增的）
  const listRes = await request.get(`${BASE}/api/credentials`, { headers: auth })
  prevCredentialIds = (((await listRes.json()) as { data?: Array<{ id: string }> }).data || []).map(c => c.id)

  // 播种凭据（携密载荷的明文断言锚点）
  const credRes = await request.post(`${BASE}/api/credentials`, {
    headers: auth,
    data: { host: CRED_HOST, username: 'e2e-user', secret: SECRET_MARK },
  })
  expect(credRes.ok(), `播种凭据应成功: ${await credRes.text()}`).toBeTruthy()

  // 夹具项目（红线面「未勾开关不携密」的真实推送载荷）
  projRoot = mkdtempSync(path.join(tmpdir(), 'sc-cred-e2e-'))
  const projDir = path.join(projRoot, PROJ_BASE)
  mkdirSync(projDir)
  writeFileSync(path.join(projDir, 'main.txt'), 'cred-e2e-payload')
  const addRes = await request.post(`${BASE}/api/projects`, {
    headers: auth,
    data: { name: PROJ_NAME, path: serverPath(projDir) },
  })
  expect(addRes.ok(), '注册夹具项目应成功').toBeTruthy()
  projectId = ((await addRes.json()) as { data?: { id?: string } }).data?.id || ''

  // 注册对端实例
  const instRes = await request.post(`${BASE}/api/instances`, {
    headers: auth,
    data: { name: PEER_NAME, url: `http://127.0.0.1:${peerPort}`, token: PEER_TOKEN },
  })
  expect(instRes.ok(), '注册对端实例应成功').toBeTruthy()
  instanceId = ((await instRes.json()) as { data?: { id?: string } }).data?.id || ''
  expect(instanceId).toBeTruthy()
})

test.afterAll(async ({ request }) => {
  const auth = { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken }
  if (instanceId) await request.delete(`${BASE}/api/instances/${instanceId}`, { headers: auth }).catch(() => {})
  if (projectId) await request.delete(`${BASE}/api/projects/${projectId}`, { headers: auth }).catch(() => {})
  const listRes = await request.get(`${BASE}/api/credentials`, { headers: auth }).catch(() => null)
  if (listRes && listRes.ok()) {
    for (const c of ((await listRes.json()) as { data?: Array<{ id: string; host: string }> }).data || []) {
      if (c.host === CRED_HOST && !prevCredentialIds.includes(c.id)) {
        await request.delete(`${BASE}/api/credentials/${c.id}`, { headers: auth }).catch(() => {})
      }
      // 接收面落盘的 stub 凭据按 host 清理
      if (c.host === 'landed.example.com') {
        await request.delete(`${BASE}/api/credentials/${c.id}`, { headers: auth }).catch(() => {})
      }
    }
  }
  if (projRoot) rmSync(projRoot, { recursive: true, force: true })
  peer?.close()
})

async function fetchOutcome(request: APIRequestContext): Promise<string> {
  const res = await request.get(`${BASE}/api/sync/progress`, { headers: { 'X-Lock-Token': unlockToken } })
  return ((await res.json()) as { data?: { outcome?: string } | null }).data?.outcome || 'idle'
}

// waitJobIdle 等待在途任务收口（测试起点可能有上一用例的 job 仍在跑——
// startExecute 对并发任务 409，先等空闲再发起）
async function waitJobIdle(request: APIRequestContext): Promise<void> {
  await expect.poll(() => fetchOutcome(request), { timeout: 30000 }).not.toBe('running')
}

// waitJobDone 等待最近一次同步任务跑到终态 done（进度快照是「最近一Job」单槽——
// 旧终态快照与新任务未启动不可区分，唯一可靠锚是「新 Job 把快照推进到 done」）
async function waitJobDone(request: APIRequestContext): Promise<void> {
  await expect.poll(() => fetchOutcome(request), { timeout: 30000 }).toBe('done')
}

// lastAuditAction 最近一条指定动作的审计事件（参数级失败落审计——失败任务
// 无单元行，进度快照不带错误原因）
async function lastAudit(request: APIRequestContext, action: string): Promise<{ result: string; detail: string }> {
  const res = await request.get(`${BASE}/api/audit?limit=50`, { headers: { 'X-Lock-Token': unlockToken } })
  // /api/audit 响应形态：{data: AuditEvent[]}（列表直出，非 events 包装）
  const events = ((await res.json()) as { data?: Array<{ action: string; result: string; detail?: string }> }).data || []
  const e = events.find(ev => ev.action === action)
  return { result: e?.result || '', detail: e?.detail || '' }
}

test('配对面：生成一次性配对码 → 非法录入拒绝 → 合法录入成立（pairFp 双端一致）', async ({ request }) => {
  const auth = { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken }

  // 生成：一次性返回配对码 + 短指纹
  const gen = await request.post(`${BASE}/api/sync/pairing/${instanceId}/generate`, { headers: auth })
  expect(gen.ok(), `生成配对码应成功: ${await gen.text()}`).toBeTruthy()
  const data = ((await gen.json()) as { data: { pairingCode: string; pairFp: string } }).data
  pairingCodePlain = data.pairingCode
  expect(pairingCodePlain).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{8}){7}$/)
  // 规范形态 = 64 位 hex 字符串的字节（服务端 SetPairing 落盘/读链形态——
  // 不是解码回 32B 原料，否则 pairFp/HKDF 双端不一致）
  pairingKeyBuf = Buffer.from(pairingCodePlain.replace(/-/g, ''), 'utf8')

  // 非法形态录入拒绝（400）
  const bad = await request.put(`${BASE}/api/sync/pairing/${instanceId}`, {
    headers: auth, data: { code: 'nothex' },
  })
  expect(bad.status()).toBe(400)

  // 合法录入（分隔符/大小写容错）→ 配对成立
  const upper = pairingCodePlain.replace(/-/g, '').toUpperCase()
  const grouped = upper.slice(0, 8) + '-' + upper.slice(8, 16) + ' ' + upper.slice(16)
  const set = await request.put(`${BASE}/api/sync/pairing/${instanceId}`, {
    headers: auth, data: { code: grouped },
  })
  expect(set.ok(), `录入应成功: ${await set.text()}`).toBeTruthy()
  expect(((await set.json()) as { data: { pairFp: string } }).data.pairFp).toBe(data.pairFp)

  // 状态面出现已配对行（未核对）
  const status = await request.get(`${BASE}/api/sync/pairing`, { headers: auth })
  const row = ((await status.json()) as { data?: Array<{ instanceId: string; paired: boolean; certVerified: boolean; pairFp: string }> }).data
    ?.find(r => r.instanceId === instanceId)
  expect(row?.paired).toBe(true)
  expect(row?.certVerified).toBe(false)
  expect(row?.pairFp).toBe(data.pairFp)
})

test('红线面：未勾开关不携密 / units 走私拒绝 / 定时模型无携密字段', async ({ request }) => {
  const auth = { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken }
  await waitJobIdle(request)

  // ① 真实单元 push（无携密开关）：任务成功 + 对端只收普通落位 + 携密端点零调用
  const exec = await request.post(`${BASE}/api/sync/push`, {
    headers: auth,
    data: { instanceIds: [instanceId], units: [`project:${PROJ_BASE}`], includeCredentials: false },
  })
  expect(exec.ok(), `push 应受理: ${await exec.text()}`).toBeTruthy()
  await expect.poll(() => stubState.landCount, { timeout: 30000 }, '普通单元应正常落位').toBeGreaterThan(0)
  await waitJobDone(request)
  expect(stubState.credPostCount, '未勾开关不得触携密端点').toBe(0)

  // ② units 显式携带凭据键而开关未开：参数级失败 + 审计稳定标记
  const smuggle = await request.post(`${BASE}/api/sync/push`, {
    headers: auth,
    data: { instanceIds: [instanceId], units: ['credentials'], includeCredentials: false },
  })
  expect(smuggle.ok()).toBeTruthy() // 异步执行：失败在审计面
  await expect.poll(async () => (await lastAudit(request, 'sync.push')).detail, { timeout: 30000 })
    .toContain('includeCredentials flag')

  // ③ 定时任务模型无携密字段：请求塞 includeCredentials 落库即被丢弃（配置漂移打不破）
  const cron = await request.post(`${BASE}/api/sync/crons`, {
    headers: auth,
    data: {
      name: 'e2e-cred-cron', direction: 'push', peerIds: [instanceId],
      hour: 3, minute: 15, includeCredentials: true,
    },
  })
  expect(cron.ok(), `建定时任务应成功: ${await cron.text()}`).toBeTruthy()
  const created = ((await cron.json()) as { data?: Record<string, unknown> }).data || {}
  expect(created).not.toHaveProperty('includeCredentials')
  await request.delete(`${BASE}/api/sync/crons/${created.id as string}`, { headers: auth })
})

test('发起面：配对未核对 push 拒（审计稳定标记）→ 核对后重推 → 对端收到 E2E 信封（无明文秘密）', async ({ request }) => {
  const auth = { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken }
  await waitJobIdle(request)

  // ① 配对但未核对：携密 push 参数级失败，审计带 CredSyncUnverified 稳定标记
  const exec = await request.post(`${BASE}/api/sync/push`, {
    headers: auth,
    data: { instanceIds: [instanceId], units: [], includeCredentials: true },
  })
  expect(exec.ok()).toBeTruthy()
  await expect.poll(async () => (await lastAudit(request, 'sync.push')).detail, { timeout: 30000 })
    .toContain('credential sync requires pairing and fingerprint verification')

  // ② 首次携密核对（ceremony 的服务端落账点）
  const verify = await request.post(`${BASE}/api/sync/credentials/verify`, {
    headers: auth, data: { instanceId },
  })
  expect(verify.ok(), `核对确认应成功: ${await verify.text()}`).toBeTruthy()

  // ③ 重推：对端存根收到 mode=cred 信封，密文内无明文秘密
  stubState.credPostCount = 0
  const exec2 = await request.post(`${BASE}/api/sync/push`, {
    headers: auth,
    data: { instanceIds: [instanceId], units: [], includeCredentials: true },
  })
  expect(exec2.ok()).toBeTruthy()
  await expect.poll(() => stubState.credPostCount, { timeout: 30000 }, '携密信封应到达对端').toBe(1)
  await waitJobDone(request)
  expect(stubState.credEnvelope).not.toContain(SECRET_MARK)
  expect(stubState.credEnvelope).not.toContain(CRED_HOST)
  const env = JSON.parse(stubState.credEnvelope) as Record<string, unknown>
  expect(env.format).toBe('simple-coding.credsync')
  expect(env.pairFp).toBe(pairFp(pairingKeyBuf))
  // node 侧按同一格式解链（互操作契约锚定）：密文内明文可见
  const opened = openEnvelope(pairingKeyBuf, env)
  expect((opened.vault as { schema: string }).schema).toBe('simple-coding.credvault')
  expect(JSON.stringify(opened.vault)).toContain(SECRET_MARK)

  // ④ 审计入账（send 侧）且凭据明文不入账
  const send = await lastAudit(request, 'sync.cred.send')
  expect(send.result).toBe('success')
  expect(send.detail).not.toContain(SECRET_MARK)
})

test('接收面：真实服务端 = 接收端——重置配对回未核对 → 暂存不落盘 → 确认落盘 → 重放/篡改拒绝', async ({ request }) => {
  const auth = { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken }

  // 重新录入同一配对码（SetPairing 重置仪式态 → 回到未核对，接收面走暂存仪式）
  const reset = await request.put(`${BASE}/api/sync/pairing/${instanceId}`, {
    headers: auth, data: { code: pairingCodePlain },
  })
  expect(reset.ok(), `重置配对应成功: ${await reset.text()}`).toBeTruthy()

  // 对端存根以共享配对钥封一枚 vault 推给真实服务端（node = 发起端）
  const vault = {
    schema: 'simple-coding.credvault', version: 1, host: 'stub-src',
    sentAt: new Date().toISOString(),
    // store.Credential 的 JSON 契约是 snake_case（auth_type/status——与服务端
    // migration 收集器序列化同形，手拼载荷必须对齐）
    credentials: { git: [{ host: 'landed.example.com', username: 'stub-user', secret: 'stub-land-secret', auth_type: 'basic', status: 'active' }] },
  }
  const env = sealEnvelope(pairingKeyBuf, vault, 'push', 1)

  // ① 接收端该对未核对 → 202 暂存（不落盘）
  const post1 = await request.post(`${BASE}/api/sync/units?mode=cred`, { headers: auth, data: env })
  expect(post1.status(), `首收应暂存: ${await post1.text()}`).toBe(202)
  const staged1 = ((await post1.json()) as { data: { staged: boolean; ticket: string; summary: string } }).data
  expect(staged1.staged).toBe(true)
  expect(staged1.summary).toContain('git=1')

  // 暂存清单可见（元数据形态）
  const stagedList = await request.get(`${BASE}/api/sync/credentials/staged`, { headers: auth })
  const rows = ((await stagedList.json()) as { data?: Array<{ ticket: string; peerName: string }> }).data || []
  expect(rows.some(r => r.ticket === staged1.ticket)).toBe(true)

  // 落盘未发生（凭据不在库）
  const credList1 = await request.get(`${BASE}/api/credentials`, { headers: auth })
  expect((((await credList1.json()) as { data?: Array<{ host: string }> }).data || [])
    .some(c => c.host === 'landed.example.com')).toBe(false)

  // ② 确认落盘：凭据进库
  const resolve = await request.post(`${BASE}/api/sync/credentials/staged/${staged1.ticket}/resolve`, {
    headers: auth, data: { accept: true },
  })
  expect(resolve.ok(), `确认落盘应成功: ${await resolve.text()}`).toBeTruthy()
  await expect.poll(async () => {
    const list = await request.get(`${BASE}/api/credentials`, { headers: auth })
    return (((await list.json()) as { data?: Array<{ host: string }> }).data || []).some(c => c.host === 'landed.example.com')
  }, { timeout: 10000 }).toBe(true)

  // ③ 重放同一信封：水位已前进 → 400 统一文案
  const replay = await request.post(`${BASE}/api/sync/units?mode=cred`, { headers: auth, data: env })
  expect(replay.status()).toBe(400)
  expect(await replay.text()).toContain('credential sync envelope rejected')

  // ④ 篡改信封：AEAD 拒绝
  const tampered = { ...env, ciphertext: (env.ciphertext as string).slice(0, -4) + 'AAAA' }
  const tam = await request.post(`${BASE}/api/sync/units?mode=cred`, { headers: auth, data: tampered })
  expect(tam.status()).toBe(400)
  expect(await tam.text()).toContain('credential sync envelope rejected')

  // ⑤ recv 侧审计入账（staged + confirmed）
  await expect.poll(async () => {
    const res = await request.get(`${BASE}/api/audit?limit=50`, { headers: auth })
    const events = ((await res.json()) as { data?: Array<{ action: string }> }).data || []
    return events.filter(e => e.action === 'sync.cred.recv').length
  }, { timeout: 10000 }).toBeGreaterThanOrEqual(2)
})

test('服务面（pull）：无指纹头 403 → 正确指纹出 E2E 信封 → node 端解链成功', async ({ request }) => {
  const auth = { 'X-Lock-Token': unlockToken }

  // 无指纹头拒绝
  const noFp = await request.get(`${BASE}/api/sync/units?keys=credentials&cred=1`, { headers: auth })
  expect(noFp.status()).toBe(403)

  // 正确指纹：出信封且无明文秘密
  const fp = pairFp(pairingKeyBuf)
  const serve = await request.get(`${BASE}/api/sync/units?keys=credentials&cred=1`, {
    headers: { ...auth, 'X-Sync-Pair-Fp': fp },
  })
  expect(serve.ok(), `服务面应成功: ${await serve.text()}`).toBeTruthy()
  const body = await serve.text()
  expect(body).not.toContain(SECRET_MARK)
  const opened = openEnvelope(pairingKeyBuf, JSON.parse(body) as Record<string, unknown>)
  expect((opened.vault as { schema: string }).schema).toBe('simple-coding.credvault')
})

test('UI：同步中心携密面（携密开关/配对徽章/红线注记）', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  // 同步入口在项目页活动栏（sync-center 同款导航前置）
  await projectCardByName(page, PROJ_NAME).first().click()
  await page.waitForURL('**/project')

  // 活动栏入口打开同步中心（奇数次点击保证最终打开——侧栏 toggle 语义）
  const panel = page.locator('[data-testid="sync-panel"]')
  for (let i = 0; i < 3; i++) {
    if (await panel.isVisible().catch(() => false)) break
    await page.locator('.rail-btn[title="多实例同步"]').click()
    await expect(panel).toBeVisible({ timeout: 5000 }).catch(() => { /* 收起竞态重试 */ })
  }
  await expect(panel).toBeVisible()

  // 携密开关（缺省关）与红线注记（自动永不携密/手动走加密通道）在场
  await expect(panel.locator('[data-testid="sync-cred-include"]')).toBeVisible()
  await expect(panel.locator('[data-testid="sync-redline"]')).toContainText('手动')

  // 选中对端 → 配对徽章在场（前序用例已配对）
  await panel.locator('[data-testid="sync-peers"] label', { hasText: PEER_NAME }).click()
  await expect(
    panel.locator('[data-testid="sync-peers"] label', { hasText: PEER_NAME })
      .locator('[data-testid="sync-cred-badge"]'),
  ).toBeVisible({ timeout: 10000 })
})
