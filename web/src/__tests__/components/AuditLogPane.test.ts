import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { mount } from '@vue/test-utils'
import { NDropdown, NSelect } from 'naive-ui'
import AuditLogPane from '../../components/settings/AuditLogPane.vue'
import type { AuditEvent } from '../../api/client'

// 审计面板行内过滤（P-20261003-131）组件测试：
// mock auditApi 与 useMessage，naive-ui 组件本体走真实渲染。
// 核验：无过滤维持服务端分页拉取、过滤生效补拉 500 窗口后改条件零请求、
// 两下拉 AND 组合、匹配 0 空态文案、清除恢复完整列表、过滤态翻页纯客户端不发请求。

const listMock = vi.hoisted(() => vi.fn())
const exportCsvMock = vi.hoisted(() => vi.fn(async () => new Blob()))
vi.mock('../../api/client', () => ({
  auditApi: {
    list: listMock,
    exportCsv: exportCsvMock,
  },
}))

// useMessage 依赖 NMessageProvider 注入（jsdom 无 provider 会抛错）
vi.mock('naive-ui', async () => {
  const actual = await vi.importActual('naive-ui')
  return {
    ...(actual as object),
    useMessage: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
  }
})

// useI18n 单独 mock：setup.ts 的 vue-i18n 全局 mock 只供 t 不含 te，
// 而面板 actionLabel 依赖 te 对未知动作回退原文。t 走 zh 文案直译与全局 mock 同口径
vi.mock('../../composables/useI18n', async () => {
  const zh = await import('../../locales/zh-CN')
  const messages: Record<string, string> = {}
  const flatten = (obj: Record<string, unknown>, prefix = ''): void => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k
      if (v && typeof v === 'object') flatten(v as Record<string, unknown>, key)
      else messages[key] = String(v)
    }
  }
  flatten(zh.default as Record<string, unknown>)
  return {
    useI18n: () => ({
      t: (key: string, params?: Record<string, unknown>) => {
        const msg = messages[key] ?? key
        return params ? msg.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? '')) : msg
      },
      te: (key: string) => key in messages,
      locale: { value: 'zh-CN' },
    }),
  }
})

const ev = (id: string, action: string, result: AuditEvent['result']): AuditEvent => ({
  id,
  time: '2026-10-07T00:00:00Z',
  action,
  result,
  ip: '127.0.0.1',
  detail: `d-${id}`,
})

/** 4 行混合样本：3 动作族 × 2 结果（failure 落在 lock.unlock） */
const smallFixture = (): AuditEvent[] => [
  ev('1', 'lock.unlock', 'failure'),
  ev('2', 'credential.save', 'success'),
  ev('3', 'lock.config', 'success'),
  ev('4', 'token.create', 'success'),
]

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const mounted: ReturnType<typeof mount>[] = []

async function mountPane(data: AuditEvent[], extra?: Record<string, unknown>) {
  listMock.mockResolvedValue({ data, total: data.length, ...extra })
  const w = mount(AuditLogPane)
  mounted.push(w)
  await flush()
  return w
}

/** NDataTable 的 thead 也产 .n-data-table-tr，数据行按含 td 区分 */
function dataRows(w: ReturnType<typeof mount>) {
  return w.findAll('.n-data-table-tr').filter(r => r.find('td').exists())
}

/** 驱动第 index 个过滤下拉（0=动作 1=结果）：naive-ui 选项菜单 teleport 到
 *  body 之外，jsdom 里直接对组件实例发 update:value 与用户选中同路径 */
async function setFilter(w: ReturnType<typeof mount>, index: 0 | 1, value: string | null) {
  w.findAllComponents(NSelect)[index]!.vm.$emit('update:value', value)
  await flush()
}

beforeEach(() => {
  listMock.mockReset()
  exportCsvMock.mockClear()
  mounted.splice(0)
})

// 导出过滤联动（P-20261007-2）：主按钮恒全窗口零参数（留档默认全量），
// 过滤生效时主按钮旁出现下拉副柄——菜单副项走参数化导出（服务端全窗口
// 过滤，唯一能拿到 500 查看窗口之外匹配行的路径），只携已设维度参数
describe('AuditLogPane 导出过滤联动（P-20261007-2）', () => {
  beforeAll(() => {
    // jsdom 无 createObjectURL（下载收口依赖），桩成无害实现
    Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:mock'),
      revokeObjectURL: vi.fn(),
    })
  })

  it('无过滤：主按钮导出零参数（全窗口口径），下拉副柄不渲染', async () => {
    const w = await mountPane(smallFixture())
    await w.find('[data-testid="audit-export"]').trigger('click')
    await flush()
    expect(exportCsvMock).toHaveBeenLastCalledWith()
    expect(w.find('[data-testid="audit-export-filtered"]').exists()).toBe(false)
  })

  it('过滤生效：下拉副柄出现，副项导出仅携已设维度参数', async () => {
    const w = await mountPane(smallFixture())
    await setFilter(w, 0, 'credential.save')

    const handle = w.find('[data-testid="audit-export-filtered"]')
    expect(handle.exists()).toBe(true)
    w.findComponent(NDropdown).vm.$emit('select', 'filtered')
    await flush()
    expect(exportCsvMock).toHaveBeenCalledWith({ action: 'credential.save' })
  })

  it('组合过滤两维度同传；清除后副柄消失、主按钮恢复零参数', async () => {
    const w = await mountPane(smallFixture())
    await setFilter(w, 0, 'credential.save')
    await setFilter(w, 1, 'success')
    w.findComponent(NDropdown).vm.$emit('select', 'filtered')
    await flush()
    expect(exportCsvMock).toHaveBeenCalledWith({ action: 'credential.save', result: 'success' })

    await w.find('[data-testid="audit-filter-clear"]').trigger('click')
    await flush()
    expect(w.find('[data-testid="audit-export-filtered"]').exists()).toBe(false)

    await w.find('[data-testid="audit-export"]').trigger('click')
    await flush()
    expect(exportCsvMock).toHaveBeenLastCalledWith()
  })
})

describe('AuditLogPane 行内过滤（P-20261003-131）', () => {
  it('无过滤：首屏拉取 20 条（offset 形态，P-223 起随响应取 nextCursor 续翻），无清除钮', async () => {
    const w = await mountPane(smallFixture())
    expect(listMock).toHaveBeenCalledWith({ limit: 20, offset: 0 })
    expect(dataRows(w)).toHaveLength(4)
    expect(w.find('[data-testid="audit-total"]').text()).toBe('共 4 条')
    expect(w.find('[data-testid="audit-filter-clear"]').exists()).toBe(false)
    expect(w.find('[data-testid="audit-filter-count"]').exists()).toBe(false)
  })

  it('选动作过滤：补拉 500 窗口，仅显匹配行，计数与清除钮出现', async () => {
    const w = await mountPane(smallFixture())
    await setFilter(w, 0, 'credential.save')

    expect(listMock).toHaveBeenLastCalledWith({ limit: 500, offset: 0 })
    const rows = dataRows(w)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text()).toContain('保存 Git 凭据')
    expect(w.find('[data-testid="audit-filter-count"]').text()).toBe('匹配 1 / 共 4 条')
    expect(w.find('[data-testid="audit-filter-clear"]').exists()).toBe(true)
    expect(w.find('[data-testid="audit-total"]').exists()).toBe(false)
  })

  it('过滤生效后改条件零请求：再叠结果过滤走 AND，匹配 0 显空态', async () => {
    const w = await mountPane(smallFixture())
    await setFilter(w, 0, 'token.create')
    const callsAfterWindow = listMock.mock.calls.length

    await setFilter(w, 1, 'success')
    expect(listMock.mock.calls.length).toBe(callsAfterWindow) // 窗口已持，纯前端算
    expect(dataRows(w)).toHaveLength(1)

    // AND 组合无命中：token.create ∩ failure = 空集 → 空态文案切换
    await setFilter(w, 1, 'failure')
    expect(dataRows(w)).toHaveLength(0)
    expect(w.find('.pane-empty').text()).toBe('当前过滤条件下无匹配事件')
    expect(w.find('[data-testid="audit-filter-count"]').text()).toBe('匹配 0 / 共 4 条')
  })

  it('结果过滤单用：只显 failure 行（解锁失败）', async () => {
    const w = await mountPane(smallFixture())
    await setFilter(w, 1, 'failure')
    const rows = dataRows(w)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text()).toContain('解锁')
    expect(rows[0]!.text()).toContain('失败')
  })

  it('清除过滤：恢复完整列表与服务端分页拉取，计数回「共 N 条」', async () => {
    const w = await mountPane(smallFixture())
    await setFilter(w, 0, 'credential.save')
    await w.find('[data-testid="audit-filter-clear"]').trigger('click')
    await flush()

    expect(listMock).toHaveBeenLastCalledWith({ limit: 20, offset: 0 })
    expect(dataRows(w)).toHaveLength(4)
    expect(w.find('[data-testid="audit-total"]').text()).toBe('共 4 条')
    expect(w.find('[data-testid="audit-filter-count"]').exists()).toBe(false)
    expect(w.find('[data-testid="audit-filter-clear"]').exists()).toBe(false)
  })

  it('过滤态翻页纯客户端切片：匹配集跨页时不发新请求', async () => {
    const data = Array.from({ length: 25 }, (_, i) => ev(String(i + 1), 'token.create', 'success'))
    const w = await mountPane(data)
    await setFilter(w, 1, 'success')
    expect(listMock.mock.calls.length).toBe(2) // 首拉 + 窗口补拉
    expect(dataRows(w)).toHaveLength(20)
    expect(w.find('[data-testid="audit-filter-count"]').text()).toBe('匹配 25 / 共 25 条')

    // 点第 2 页 → 客户端切片剩 5 行，请求次数不变
    const page2 = w.findAll('.n-pagination-item').find(n => n.text() === '2')
    expect(page2).toBeTruthy()
    await page2!.trigger('click')
    await flush()
    expect(listMock.mock.calls.length).toBe(2)
    expect(dataRows(w)).toHaveLength(5)
  })
})

// 审计写失败警示（P-20261003-205）：响应顶面计数 >0 时警示条出现并如实
// 展示条数与最近失败时刻；0/缺字段（旧形态）不出现
describe('AuditLogPane 审计写失败警示（P-20261003-205）', () => {
  it('无失败（字段缺省/0）：不渲染警示条', async () => {
    const w0 = await mountPane(smallFixture(), { auditWriteFails: 0, auditLastWriteFail: '' })
    expect(w0.find('[data-testid="audit-write-fails"]').exists()).toBe(false)
    // 旧形态（无这两个字段）同口径不渲染
    const wOld = await mountPane(smallFixture())
    expect(wOld.find('[data-testid="audit-write-fails"]').exists()).toBe(false)
  })

  it('写失败 3 条：警示条出现，条数与最近失败时刻如实进文案', async () => {
    const w = await mountPane(smallFixture(), {
      auditWriteFails: 3,
      auditLastWriteFail: '2026-10-07T02:00:00Z',
    })
    const alert = w.find('[data-testid="audit-write-fails"]')
    expect(alert.exists()).toBe(true)
    // 标题行含条数与最近失败时刻（formatDateTime 本地时区文本，只锚定条数段
    // 与时刻前缀，不锚死时区偏移；title+tip 文本都渲染在 alert 子树内）
    expect(alert.text()).toContain('审计写失败 3 条（最近 ')
    expect(alert.text()).toContain('写失败的审计事件已静默丢失')
  })
})

// 条数上限弱提示（P-20261004-80）：保留语义 = 时间窗 AND 条数上限的诚实边界
// 注记——阈值由服务端响应透出（同源不漂移），旧服务端无该字段不渲染（回退兼容）
describe('AuditLogPane 条数上限弱提示（P-20261004-80）', () => {
  it('响应带 maxEntries：弱提示出现且阈值如实进文案', async () => {
    const w = await mountPane(smallFixture(), { maxEntries: 100000 })
    const hint = w.find('[data-testid="audit-cap-hint"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('容量上限 100000 条')
    expect(hint.text()).toContain('最早的条目优先清理')
  })

  it('旧服务端形态（无 maxEntries / 0）：弱提示不渲染', async () => {
    const w0 = await mountPane(smallFixture(), { maxEntries: 0 })
    expect(w0.find('[data-testid="audit-cap-hint"]').exists()).toBe(false)
    const wOld = await mountPane(smallFixture())
    expect(wOld.find('[data-testid="audit-cap-hint"]').exists()).toBe(false)
  })
})

// 滚动加载键集续翻（P-20261003-223）：无过滤视图近底滚动传 cursor 追加下一页，
// 到底（响应无 nextCursor）/旧服务端形态静停零请求；过滤态滚动被守卫短路
describe('AuditLogPane 滚动加载续翻（P-20261003-223）', () => {
  const scrollBox = (w: ReturnType<typeof mount>) => w.find('[data-testid="audit-scroll"]')

  async function scrollBottom(w: ReturnType<typeof mount>): Promise<void> {
    await scrollBox(w).trigger('scroll')
    await flush()
  }

  it('近底滚动传 cursor 追加下一页，不替换已加载行', async () => {
    // 首页 4 行 + nextCursor；续页 3 行、无 nextCursor（到底）
    const more = smallFixture().slice(0, 3).map(e => ({ ...e, id: e.id + '0' }))
    listMock.mockImplementation((params?: { cursor?: string }) => {
      if (!params?.cursor) {
        return Promise.resolve({ data: smallFixture(), total: 7, nextCursor: 'cursor-page-1' })
      }
      return Promise.resolve({ data: more, total: 7 })
    })
    const w = mount(AuditLogPane)
    await flush()

    expect(listMock).toHaveBeenLastCalledWith({ limit: 20, offset: 0 })
    expect(dataRows(w)).toHaveLength(4)
    expect(listMock.mock.calls.length).toBe(1)

    await scrollBottom(w)

    // 续翻以首页响应的 nextCursor 为锚（键集语义：锚在上一页尾条目）
    expect(listMock).toHaveBeenLastCalledWith({ limit: 20, cursor: 'cursor-page-1' })
    expect(dataRows(w)).toHaveLength(7) // 4 + 3 追加，不替换
    expect(w.find('[data-testid="audit-more-loading"]').exists()).toBe(false)

    // 到底后滚动零请求（末页响应无 nextCursor → 空串哨兵静停）
    const calls = listMock.mock.calls.length
    await scrollBottom(w)
    expect(listMock.mock.calls.length).toBe(calls)
  })

  it('旧服务端形态（响应无 nextCursor）：滚动零请求，视图静停首页', async () => {
    const w = await mountPane(smallFixture()) // mock 无 nextCursor 字段
    expect(listMock.mock.calls.length).toBe(1)

    await scrollBottom(w)

    expect(listMock.mock.calls.length).toBe(1)
    expect(dataRows(w)).toHaveLength(4)
  })

  it('过滤态滚动被守卫短路：窗口视图不触发续翻请求', async () => {
    const w = await mountPane(smallFixture(), { nextCursor: 'cursor-page-1' })
    await setFilter(w, 0, 'credential.save') // 补拉 500 窗口
    const callsAfterWindow = listMock.mock.calls.length

    await scrollBottom(w)

    expect(listMock.mock.calls.length).toBe(callsAfterWindow)
    expect(dataRows(w)).toHaveLength(1) // 过滤视图原样，未被续翻污染
  })

  it('清除过滤恢复滚动加载视图：重拉首页（offset 形态）', async () => {
    const w = await mountPane(smallFixture())
    await setFilter(w, 0, 'credential.save')
    await w.find('[data-testid="audit-filter-clear"]').trigger('click')
    await flush()

    expect(listMock).toHaveBeenLastCalledWith({ limit: 20, offset: 0 })
    expect(dataRows(w)).toHaveLength(4)
  })

  it('刷新回到首页：重拉 offset 首屏而非追加', async () => {
    const more = smallFixture().slice(0, 2).map(e => ({ ...e, id: e.id + '0' }))
    listMock.mockImplementation((params?: { cursor?: string }) => {
      if (!params?.cursor) {
        return Promise.resolve({ data: smallFixture(), total: 6, nextCursor: 'cursor-page-1' })
      }
      return Promise.resolve({ data: more, total: 6, nextCursor: 'cursor-page-2' })
    })
    const w = mount(AuditLogPane)
    await flush()
    await scrollBottom(w)
    expect(dataRows(w)).toHaveLength(6)

    await w.find('[data-testid="audit-refresh"]').trigger('click')
    await flush()

    expect(listMock).toHaveBeenLastCalledWith({ limit: 20, offset: 0 })
    expect(dataRows(w)).toHaveLength(4) // 重置为首屏，不残留续翻行
  })
})
