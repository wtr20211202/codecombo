import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// 结构化错误码消费层（P-20261005-153）：code 命中优先 → 未登记/无 code 回退
// KNOWN_ERROR_I18N 正则层。本文件局部覆盖 setup.ts 的全局 axios mock（同
// http-retry.test.ts 模式）：真实捕获 http.ts 注册的响应拦截器错误分支，离线
// 驱动「分类 → code/正则映射 → userMessage → 错误入账」整链，不发真网络请求。
const h = vi.hoisted(() => {
  const captured = {
    responseErrorHandlers: [] as Array<(error: unknown) => Promise<unknown>>,
  }
  const apiInstance = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    interceptors: {
      request: {
        use: () => { /* 本组用例不关心请求拦截器 */ },
      },
      response: {
        use: (_onOk: unknown, onError: (error: unknown) => Promise<unknown>) => {
          captured.responseErrorHandlers.push(onError)
        },
      },
    },
  }
  return { captured, apiInstance }
})

vi.mock('axios', () => ({ default: { create: vi.fn(() => h.apiInstance) } }))

import { useErrorLogStore } from '@/stores/errorLog'
import { ERROR_CODE_I18N } from '@/api/http'

// http.ts 只注册 1 个响应拦截器（错误分类入账）
const onResponseError = h.captured.responseErrorHandlers[0]

// 驱动响应拦截器错误分支；拦截器契约是 reject(AppError)，就地吞掉
async function recordError(status: number, body: unknown, message = 'Request failed'): Promise<void> {
  await onResponseError({
    message,
    config: { method: 'post', url: '/projects/p1/file/create' },
    response: {
      status,
      data: body,
      headers: {},
    },
  }).catch(() => { /* 预期拒绝 */ })
}

describe('错误码消费层 code 优先命中（P-20261005-153）', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    useErrorLogStore().clear()
  })
  afterEach(() => consoleSpy.mockRestore())

  it('code 表内收录的码与 ERROR_CODE_I18N 一一可查（表即契约的单元面）', () => {
    // 防御性下限：首批 12 条，误删到空表时这里先红（check-i18n --errcodes 另有
    // 下限守卫与双端对账，此处管的是运行时导入面完好）
    expect(Object.keys(ERROR_CODE_I18N).length).toBeGreaterThanOrEqual(8)
    expect(ERROR_CODE_I18N['project.locked']).toBe('errors.known.projectLocked')
  })

  it('code 命中优先：文案改排后正则失配，code 层仍给出映射文案', async () => {
    // 服务端重排文案（不再含正则可匹配的稳定措辞）——正则层失配回退分类文案，
    // code 层命中后与改排前同一文案
    await recordError(403, {
      error: 'archived project is immutable (request denied by guard)',
      code: 'project.locked',
    })

    const entry = useErrorLogStore().logs[0]
    expect(entry.userMessage).toContain('项目已锁定')
  })

  it('无 code 字段回退正则层：稳定原文命中既有映射', async () => {
    // 未迁移端点旧形态（响应体仅 {error}）——行为与消费层落地前一致
    await recordError(409, { error: 'queue is full' })

    const entry = useErrorLogStore().logs[0]
    expect(entry.userMessage).toContain('排队指令已满')
  })

  it('未登记 code 同样回退正则层：死码不遮蔽正则命中', async () => {
    // 码不在 ERROR_CODE_I18N（如未来域提前下发）→ 正则层照常兜住原文
    await recordError(404, { error: 'project not found', code: 'future.domain.code' })

    const entry = useErrorLogStore().logs[0]
    expect(entry.userMessage).toContain('项目不存在')
  })

  it('错误入账携结构化 code：详情面板徽标数据源；无 code 条目字段缺省', async () => {
    await recordError(403, { error: 'project is locked (project.locked): archived', code: 'project.locked' })
    await recordError(500, { error: 'server down' })

    const logs = useErrorLogStore().logs // unshift 语义：后入账在前
    expect(logs[1].code).toBe('project.locked')
    expect(logs[0].code).toBeUndefined()
  })
})
