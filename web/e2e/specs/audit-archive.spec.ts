import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { serverIsRemote } from '../../tests/dualpath'

/**
 * 审计定期自动归档（P-20261003-277）：审计是滚动保留窗口，窗口翻转即永久
 * 丢失——过期前事件先转 CSV 归档到 <dataDir>/artifacts/audit-archive/（车道 2）
 * 再清理。本用例验证「窗口翻转 → 归档文件生成且内容完整」：
 *   - PUT /api/settings 把 auditRetentionDays 翻到 1 天
 *   - 「注入过期」：服务端无时间旅行 API，经数据面直写 backdated auditlog 文档
 *     （filestore Get/List 每次读盘无缓存，运行中写入即时可见；
 *     approval-timeout.spec 回拨 createdAt 同机制）
 *   - 触发走确定性通道 POST /api/audit/archive（手动触发与每日 ticker 同一
 *     RunAuditRetentionPass；巡更是次日 tick，e2e 不等一天）
 *   - 断言：归档 CSV 生成（BOM+表头+过期事件全量、公式注入防护沿导出面同款）、
 *     活动窗口只剩窗内事件、audit.archive 入账、归档通知到账
 * 数据面目录探测（approval-timeout 同款机制反转）：先经 API 打一条真实审计
 * 事件（/api/audit/export 自身入账 audit.export），再在候选目录
 * （SC_E2E_DATA_DIR → .e2e-data/full-<port> → .e2e-data）里找这份刚落盘的
 * 文档——命中者即活动数据面，防陈旧候选目录误选。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

// 「注入过期」依赖测试侧 fs 直写服务端数据面文档（头注机制）：仅当数据面在
// 测试侧文件系统上（Windows 实例/同机形态）可行——跨拓扑数据面在服务端
// homedir 内结构性不可见，按环境门控 skip（dualpath.serverIsRemote 同
// approval-timeout.spec 惯例）
test.skip(serverIsRemote, 'auditlog 文档直写依赖测试侧可见的服务端数据面，跨拓扑不可达——仅同机拓扑')

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

async function unlockToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  expect(res.ok(), `unlock failed: ${res.status()}`).toBeTruthy()
  const token = ((await res.json()) as { token?: string }).token || ''
  expect(token, 'unlock 应回 token').not.toBe('')
  return token
}

function authHeaders(token: string): Record<string, string> {
  return { 'X-Lock-Token': token }
}

/** 数据面根候选（按序列举；SC_E2E_DATA_DIR 由 e2e-restart 注入时最优先） */
function dataDirCandidates(): string[] {
  const port = new URL(BASE).port || '80'
  const dirs: string[] = []
  if (process.env.SC_E2E_DATA_DIR) dirs.push(path.resolve(repoRoot, process.env.SC_E2E_DATA_DIR))
  dirs.push(path.join(repoRoot, '.e2e-data', `full-${port}`))
  dirs.push(path.join(repoRoot, '.e2e-data'))
  return dirs
}

/** 打一条真实审计事件（导出动作自身入账 audit.export），据其落盘位置探明
 * 活动数据面（近 1 分钟内落盘的 audit.export 文档所在候选目录） */
async function probeLiveDataDir(request: APIRequestContext): Promise<string> {
  const headers = authHeaders(await unlockToken(request))
  const res = await request.get(`${BASE}/api/audit/export`, { headers })
  expect(res.ok(), `audit export failed: ${res.status()}`).toBeTruthy()
  const cutoff = Date.now() - 60_000
  for (const dir of dataDirCandidates()) {
    const kindDir = path.join(dir, 'data', 'auditlog')
    if (!fs.existsSync(kindDir)) continue
    for (const f of fs.readdirSync(kindDir)) {
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(kindDir, f), 'utf-8')) as {
          action?: string
          time?: string
        }
        if (doc.action === 'audit.export' && new Date(doc.time ?? 0).getTime() >= cutoff) {
          return dir
        }
      } catch {
        // 坏文档跳过（filestore 自有隔离机制，读侧容错即可）
      }
    }
  }
  throw new Error(`live data dir not found, tried: ${dataDirCandidates().join(', ')}`)
}

interface SeededEvent { id: string; detail: string }

/** 直写一条 backdated 审计事件文档（<dataDir>/data/auditlog/<id>.json，
 * filestore keyPath 惯例；AuditEvent 字段名与 server/store/auditlog.go 同形） */
function seedAuditDoc(dataDir: string, daysAgo: number, action: string, detail: string): SeededEvent {
  const id = randomUUID()
  const doc = {
    id,
    time: new Date(Date.now() - daysAgo * 24 * 3600 * 1000).toISOString(),
    action,
    result: 'success',
    ip: '203.0.113.7',
    detail,
  }
  fs.writeFileSync(path.join(dataDir, 'data', 'auditlog', `${id}.json`), JSON.stringify(doc))
  return { id, detail }
}

test.beforeEach(async ({ request }) => {
  const headers = authHeaders(await unlockToken(request))
  // 窗口翻转：1 天窗让 3 天前的种子必然出窗（写入端边界 1~3650 合法档）
  const res = await request.put(`${BASE}/api/settings`, { headers, data: { auditRetentionDays: 1 } })
  expect(res.ok(), `flip retention failed: ${res.status()}`).toBeTruthy()
})

test.afterEach(async ({ request }) => {
  const headers = authHeaders(await unlockToken(request))
  // 复位默认窗口（显式 0=回落默认 30，audit-log.spec 保留期用例同款逃生口）
  await request.put(`${BASE}/api/settings`, { headers, data: { auditRetentionDays: 0 } })
  await request.post(`${BASE}/api/notifications/clear`, { headers })
})

test('窗口翻转触发归档：过期事件转 CSV 内容完整 + 活动窗口收敛 + 入账通知', async ({ request }) => {
  const headers = authHeaders(await unlockToken(request))
  const dataDir = await probeLiveDataDir(request)

  // 播种：2 条已出 1 天窗的过期事件（其一 Detail 带公式注入形态，验证防护
  // 沿导出面同款；负载不带逗号/引号——含引号的 Detail 在文件里是 RFC 4180
  // 引号加倍形态，裸文本 contains 断言不到，引号往返由 Go 单测
  // TestAuditArchive_ArchivesBeforeWindowCleanup 走 csv 解析器覆盖）+
  // 1 条窗内事件（保留、不入归档）
  const expired = [
    seedAuditDoc(dataDir, 3, 'remotehost.create', 'P-277 archived old plain'),
    seedAuditDoc(dataDir, 3, 'share.create', '=1+1|calc@archive-injection-test'),
  ]
  const fresh = seedAuditDoc(dataDir, 0, 'credential.save', 'P-277 stays in window')

  // 手动触发保留巡更（与每日 ticker 同一入口）
  const res = await request.post(`${BASE}/api/audit/archive`, { headers })
  expect(res.status()).toBe(200)
  const data = ((await res.json()) as {
    data: { archived: number; removed: number; file: string }
  }).data
  // 相对口径（≥2）：数据面复用形态（SC_E2E_FRESH=0 升级兼容验证模式）可能
  // 携带更早的出窗存量——归档/清理数不锚死绝对值，锚「种子必然在内」
  expect(data.archived).toBeGreaterThanOrEqual(2)
  expect(data.removed).toBeGreaterThanOrEqual(2)
  expect(data.file).toMatch(/^audit-archive-\d{4}-\d{2}-\d{2}\.csv$/)

  // 归档文件生成且内容完整：BOM + 表头 + 过期事件（含公式注入防护前缀），
  // 窗内事件不入档
  const archivePath = path.join(dataDir, 'artifacts', 'audit-archive', data.file)
  expect(fs.existsSync(archivePath), `archive file missing: ${archivePath}`).toBe(true)
  const raw = fs.readFileSync(archivePath, 'utf-8')
  expect(raw.startsWith('\uFEFF')).toBe(true)
  const lines = raw.replace(/^\uFEFF/, '').trim().split(/\r?\n/)
  expect(lines[0]).toBe('time,action,result,ip,detail')
  expect(lines.length - 1).toBeGreaterThanOrEqual(2)
  expect(raw).toContain('P-277 archived old plain')
  // 公式注入防护：= 前缀单引号（负载无逗号/引号 → 无 RFC 4180 包装，裸文本
  // 可断言；audit-log.spec 导出面同款断言形态）
  expect(raw).toContain(`'=1+1|calc@archive-injection-test`)
  expect(raw).not.toContain('P-277 stays in window')

  // 活动窗口收敛：过期事件已删、窗内事件保留
  const list = await request.get(`${BASE}/api/audit?limit=500`, { headers })
  expect(list.ok()).toBeTruthy()
  const events = ((await list.json()) as { data: { id: string; action: string }[] }).data
  for (const e of expired) {
    expect(events.find(x => x.id === e.id)).toBeUndefined()
  }
  expect(events.find(x => x.id === fresh.id)).toBeTruthy()
  // 归档动作同路入账（audit.archive 摘要行随列表可见）
  expect(events.find(x => x.action === 'audit.archive')).toBeTruthy()

  // 归档通知到账（category system，模板键双语由 i18n 对账门禁守护）
  const notifs = await request.get(`${BASE}/api/notifications`, { headers })
  expect(notifs.ok()).toBeTruthy()
  const items = ((await notifs.json()) as { data: { titleKey?: string; category: string }[] }).data
  const archiveNotice = items.find(n => n.titleKey === 'audit.notify.archive.title')
  expect(archiveNotice).toBeTruthy()
  expect(archiveNotice!.category).toBe('system')
})
