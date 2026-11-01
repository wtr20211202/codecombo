import { test, expect, type APIRequestContext } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 出域路径相对化 E2E（P-20261003-113）：含绝对路径的 transcript → md/JSONL
 * 双导出内容均把项目根绝对路径改写为项目相对形态（cwd 字段、正文、工具输入；
 * 反斜杠/正斜杠两种分隔形态都覆盖），兄弟目录名前缀与非项目路径原样保留
 * （降级不改写口径）。UI 下载动线由 session-export-md/jsonl.spec.ts 覆盖，
 * 本用例走 API 直取导出内容做内容契约断言。
 *
 * 测试数据：播种 fixture transcript 到真实 ~/.claude/projects（与同域既有
 * 用例同款约定，独立 id/目录互不干扰），afterAll 精确删除。拓扑说明：服务端
 * 直读其所在文件系统的 ~/.claude/projects，仅服务实例与测试同机时可跑。
 */

const MARK = '[e2e-rel]'
const FAKE_DIR_NAME = 'D--e2e-rel-fixtures'
const SESSION_ID = 'e2e-rel-a1b2c3d4e5f6'
const ROOT = 'D:\\e2e-rel-fixtures'
const createdFiles: string[] = []

/** 播种 fixture transcript：正文/工具输入嵌项目根绝对路径 + 兄弟目录前缀 + 非项目路径 */
function buildFixtures() {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${SESSION_ID}.jsonl`)
  const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString()
  const lines = [
    `{"type":"last-prompt","sessionId":"${SESSION_ID}"}`,
    JSON.stringify({
      parentUuid: null, isSidechain: false, type: 'user',
      message: { role: 'user', content: `${MARK} 相对化导出验证：请看 D:\\e2e-rel-fixtures\\docs\\plan.md` },
      timestamp: at(5), cwd: ROOT,
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_rel1', name: 'Read', input: { file_path: 'D:\\e2e-rel-fixtures\\src\\main.ts' } },
        { type: 'tool_use', id: 'toolu_rel2', name: 'Read', input: { file_path: 'D:/e2e-rel-fixtures/notes/idea.md' } },
        { type: 'tool_use', id: 'toolu_rel3', name: 'Edit', input: { file_path: 'D:\\e2e-rel-fixtures-sib\\other.ts' } },
        { type: 'tool_use', id: 'toolu_rel4', name: 'Bash', input: { command: 'type C:\\elsewhere\\cfg.json' } },
        { type: 'text', text: '改动集中在 D:\\e2e-rel-fixtures\\ws 包' },
      ] },
      timestamp: at(4),
    }),
  ]
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
  // mtime 落在服务端 activeWindow(5 分钟) 外：与同域用例同约定
  const at10 = new Date(Date.now() - 10 * 60_000)
  fs.utimesSync(file, at10, at10)
  createdFiles.push(file)
}

function cleanupFixtures() {
  if (process.env.SC_KEEP_FIXTURES) return // 调试用：保留 fixture
  for (const f of createdFiles) {
    try { fs.unlinkSync(f) } catch { /* already gone */ }
  }
  try { fs.rmdirSync(path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)) } catch { /* non-empty or gone */ }
}

// 用 API 解锁拿 token（session-export-md.spec 同款；锁定关闭时 unlock 端点同样发 token）
async function unlockToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  if (!res.ok()) throw new Error(`unlock failed: ${res.status()}`)
  return ((await res.json()) as { token: string }).token
}

test.describe('出域路径相对化（P-20261003-113）', () => {
  test.beforeAll(() => {
    buildFixtures()
  })

  test.afterAll(() => {
    cleanupFixtures()
  })

  test('md 导出：项目根绝对路径已相对化，兄弟目录与非项目路径保留', async ({ request }) => {
    const token = await unlockToken(request)
    const res = await request.get(`${API_BASE}/api/claude/sessions/${SESSION_ID}/export?format=md`, {
      headers: { 'X-Lock-Token': token },
    })
    expect(res.ok()).toBe(true)
    const md = await res.text()

    // 相对化形态：反斜杠/正斜杠两种分隔形态都剥除根前缀，正文与工具输入覆盖
    for (const want of ['docs\\plan.md', 'src\\main.ts', 'notes/idea.md', 'ws 包']) {
      expect(md).toContain(want)
    }
    // 根前缀形态（root+分隔符）不再出现；串尾裸 root 收敛 "." 不适用于本
    // fixture（无裸 root 出场），root 本体只允许活在兄弟目录名前缀里
    expect(md).not.toContain('D:\\e2e-rel-fixtures\\')
    // 误判面：兄弟目录名前缀与非项目路径原样保留（降级不改写）
    expect(md).toContain('D:\\e2e-rel-fixtures-sib\\other.ts')
    expect(md).toContain('C:\\elsewhere\\cfg.json')
  })

  test('JSONL 导出：cwd 字段相对化、结构逐行保留，其余路径同口径', async ({ request }) => {
    const token = await unlockToken(request)
    const res = await request.get(`${API_BASE}/api/claude/sessions/${SESSION_ID}/export?format=jsonl`, {
      headers: { 'X-Lock-Token': token },
    })
    expect(res.ok()).toBe(true)
    expect(res.headers()['content-type']).toBe('application/x-ndjson')
    const jsonl = await res.text()

    // cwd 字段值收敛 "."（转义字节层：值后随 JSON 串界引号）
    expect(jsonl).toContain('"cwd":"."')
    // 工具输入相对形态保留 JSON 转义（单反斜杠加倍）；正斜杠形态无转义
    expect(jsonl).toContain('"src\\\\main.ts"')
    expect(jsonl).toContain('"notes/idea.md"')
    // 兄弟目录名前缀与非项目路径保留（转义形态原样）
    expect(jsonl).toContain('D:\\\\e2e-rel-fixtures-sib\\\\other.ts')
    expect(jsonl).toContain('C:\\\\elsewhere\\\\cfg.json')
    // 根前缀（转义形态 root+分隔符）不再出现
    expect(jsonl).not.toContain('D:\\\\e2e-rel-fixtures\\\\')
    // 行结构无损：3 行（末行含换行）
    expect(jsonl.split('\n').filter(l => l.trim() !== '').length).toBe(3)
  })
})
