import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// 全局 setup.ts 把 vue-router 整体 mock（业务单测不触路由）——本测试要真实
// 路由表（别名路由注册断言），文件级还原真实现（优先级高于 setup 级 mock）
vi.mock('vue-router', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()) }))
import router from '../../router'
import {
  buildFileDeepLinkQuery, FILE_DEEPLINK_PARAMS, parseFileDeepLinkQuery,
  projectFilesAliasRedirect, VIEW_DEEPLINK_VIEWS,
} from '../../utils/presentAtoms'

/**
 * 原子呈现能力注册表 web 侧镜像门禁（P-20261022-3）：读取服务端注册表双侧快照
 * server/agentops/testdata/present-atoms.json（Go 侧 capabilities_test.go 与
 * 注册表对账同一文件），核对——
 *  ① opsEvents.ts 事件 detail 接口字段 ⊇ 注册表载荷字段（服务端声明的字段前端
 *     必须能消费；NavigateDetail 走全等——navigate 族无前端内部扩展字段）；
 *  ② 前端深链消费常量 == 快照深链参数全集（parseFileDeepLinkQuery /
 *     consumeViewQuery 消费面对账）；
 *  ③ 路由别名 /project/:id/files 的重定向产出 = file 深链同参（编造 URL 收口）。
 * 接口字段用源码正则提取（check-event-names.mjs 审计脚本同思路）：接口加减字段
 * 本测试立即可见，与快照不同步即红。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OPS_EVENTS_TS = fs.readFileSync(path.resolve(HERE, '../../utils/opsEvents.ts'), 'utf8')
const SNAPSHOT = JSON.parse(
  fs.readFileSync(path.resolve(HERE, '../../../../server/agentops/testdata/present-atoms.json'), 'utf8'),
) as {
  atoms: { id: string; verb: string; event: string; payload: string[]; deepLink?: string }[]
  deepLinks: { id: string; pattern: string; params: string[]; viewValues?: string[] }[]
}

/** 从 opsEvents.ts 源码提取 interface 的顶层字段名（跳过注释行） */
function interfaceFields(name: string): string[] {
  const m = OPS_EVENTS_TS.match(new RegExp(`export interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`))
  if (!m) throw new Error(`opsEvents.ts 未找到 interface ${name}——接口改名时同步本测试`)
  return m[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('*') && !l.startsWith('/*') && !l.startsWith('//'))
    .map((l) => {
      const f = l.match(/^(\w+)\??[,:]/)
      return f?.[1] ?? ''
    })
    .filter(Boolean)
}

function snapshotAtomsByEvent(event: string) {
  return SNAPSHOT.atoms.filter((a) => a.event === event)
}

describe('注册表快照 ⇄ opsEvents.ts 接口（漂移门禁）', () => {
  it('navigate 族字段并集 == NavigateDetail 接口字段（全等）', () => {
    const union = new Set(snapshotAtomsByEvent('navigate').flatMap((a) => a.payload))
    expect([...union].sort()).toEqual(interfaceFields('NavigateDetail').sort())
  })

  it('open-file-at / locate-in-tree / watch.invite / preview.port / notify.persist / frontend.*：注册表字段 ⊆ 接口字段', () => {
    // 子集而非全等：接口可携前端内部扩展（如 OpenFileAtDetail.diffVsHead 为
    // 审批卡派发形态独有，不经 ops-notify 上报），注册表只管 agent 可上报面
    const cases: Array<[string, string]> = [
      ['open-file-at', 'OpenFileAtDetail'],
      ['locate-in-tree', 'LocateInTreeDetail'],
      ['watch.invite', 'WatchInviteDetail'],
      ['preview.port', 'PreviewPortDetail'],
      ['notify.persist', 'NotifyPersistDetail'],
      ['frontend.download', 'FrontendDownloadDetail'],
      ['frontend.clipboard', 'FrontendClipboardDetail'],
      ['frontend.open', 'FrontendOpenDetail'],
      ['frontend.reload', 'FrontendReloadDetail'],
    ]
    for (const [event, iface] of cases) {
      const fields = interfaceFields(iface)
      for (const atom of snapshotAtomsByEvent(event)) {
        for (const f of atom.payload) {
          expect(fields, `${iface} 缺注册表字段 ${f}（${atom.id}）`).toContain(f)
        }
      }
    }
  })

  it('快照原子 id 唯一且动词族合法（防快照手误）', () => {
    const ids = SNAPSHOT.atoms.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const a of SNAPSHOT.atoms) {
      expect(a.id).toMatch(new RegExp(`^${a.verb}\\.`))
      // frontend 动词族（P-20261023-4）：替用户执行浏览器动作的原子
      expect(['navigate', 'present', 'notify', 'frontend']).toContain(a.verb)
    }
  })
})

describe('深链消费面 ⇄ 快照深链表（双向锁死）', () => {
  it('FILE_DEEPLINK_PARAMS == 快照 file 深链参数全集', () => {
    const file = SNAPSHOT.deepLinks.find((d) => d.id === 'file')
    expect(file).toBeTruthy()
    expect([...FILE_DEEPLINK_PARAMS].sort()).toEqual([...(file?.params ?? [])].sort())
  })

  it('VIEW_DEEPLINK_VIEWS == 快照 view 深链取值域', () => {
    const view = SNAPSHOT.deepLinks.find((d) => d.id === 'view')
    expect(view).toBeTruthy()
    expect([...VIEW_DEEPLINK_VIEWS].sort()).toEqual([...(view?.viewValues ?? [])].sort())
  })

  it('parseFileDeepLinkQuery：合法深链全参解析', () => {
    expect(
      parseFileDeepLinkQuery({ file: 'src/app.go', project: 'p1', line: '55', col: '8', diff: '1' }),
    ).toEqual({ file: 'src/app.go', project: 'p1', line: 55, col: 8, diff: true })
  })

  it('parseFileDeepLinkQuery：缺 file 返回 null（非深链早退，消费方零副作用）', () => {
    expect(parseFileDeepLinkQuery({})).toBeNull()
    expect(parseFileDeepLinkQuery({ file: '' })).toBeNull()
  })

  it('parseFileDeepLinkQuery：非法/越界 line/col 忽略（P-20261003-302 防呆语义原样）', () => {
    expect(parseFileDeepLinkQuery({ file: 'a.ts', line: 'abc', col: '0' })).toEqual({
      file: 'a.ts', project: '', diff: false,
    })
    expect(parseFileDeepLinkQuery({ file: 'a.ts', line: ['5', '6'] })).toMatchObject({ line: undefined })
    expect(parseFileDeepLinkQuery({ file: 'a.ts', diff: 'true' })).toMatchObject({ diff: false })
  })

  it('buildFileDeepLinkQuery 产出可被 parseFileDeepLinkQuery 无损回读（产出/消费同参同形）', () => {
    const q = buildFileDeepLinkQuery({ file: 'a/b.md', project: 'p', line: 3 })
    expect(parseFileDeepLinkQuery(q)).toEqual({ file: 'a/b.md', project: 'p', line: 3, diff: false })
    // 空项目不携带（消费侧空串语义 = 当前项目）
    expect(buildFileDeepLinkQuery({ file: 'a.ts' })).toEqual({ file: 'a.ts' })
  })
})

describe('防御性路由别名 /project/:id/files（编造 URL 收口）', () => {
  function aliasRedirect() {
    const rec = router.getRoutes().find((r) => r.path === '/project/:id/files')
    expect(rec, '别名路由未注册').toBeTruthy()
    expect(typeof rec?.redirect).toBe('function')
    return rec
  }

  it('注册表在册且重定向为 file 深链同参（path→file、id→project，line/col 透传）', () => {
    const rec = aliasRedirect()
    const target = (rec!.redirect as (to: unknown) => { path: string; query: Record<string, string> })({
      params: { id: 'prj-1' },
      query: { path: 'dlp_ck_event_export.sh', line: '42' },
    })
    expect(target.path).toBe('/project')
    expect(parseFileDeepLinkQuery(target.query)).toEqual({
      file: 'dlp_ck_event_export.sh', project: 'prj-1', line: 42, diff: false,
    })
  })

  it('缺 path 参数落干净项目页（无 ?file= 尾巴）', () => {
    const rec = aliasRedirect()
    const target = (rec!.redirect as (to: unknown) => { path: string; query: Record<string, string> })({
      params: { id: 'prj-1' },
      query: {},
    })
    expect(target).toEqual({ path: '/project', query: {} })
  })

  it('projectFilesAliasRedirect 纯函数与路由 redirect 同源', () => {
    expect(
      projectFilesAliasRedirect({ id: 'p' }, { path: 'a.ts', col: '3' }),
    ).toEqual({ path: '/project', query: { file: 'a.ts', project: 'p', col: '3' } })
  })
})
