import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectRules } from './useProjectRules'

/**
 * 项目规则组合式单测（P-20261003-181）：扫描状态机（exists/missing/竞态防回写）
 * 与模板创建结果分支（created/409→exists/失败）。api 面经 vi.mock 替身，
 * 不触真实 HTTP（组合式本体不依赖 i18n/naive，可直接实例化）。
 * 扫描经文件树根清单成员判定（console-hygiene 收口：逐文件 filePolicy 对缺失
 * 文件的 404 会被浏览器记控制台错误），mock 面即 fileTree 响应。
 */

const { fileTreeMock, createFileMock } = vi.hoisted(() => ({
  fileTreeMock: vi.fn(),
  createFileMock: vi.fn(),
}))

vi.mock('../api/client', () => ({
  projectApi: { fileTree: fileTreeMock, createFile: createFileMock },
}))

/** axios 形态的拒绝错误（axiosStatus 守卫的输入面） */
function httpError(status: number): { response: { status: number } } {
  return { response: { status } }
}

/** 根清单条目工厂（与 FileEntry 形状对齐，scan 只消费 name/path/isDir） */
function entry(name: string, isDir = false): { name: string; path: string; isDir: boolean } {
  return { name, path: name, isDir }
}

beforeEach(() => {
  fileTreeMock.mockReset()
  createFileMock.mockReset()
})

describe('scan', () => {
  it('根清单命中→exists / 缺席→missing，全部落定后 scanning 复位', async () => {
    fileTreeMock.mockResolvedValue({ data: [entry('CLAUDE.md'), entry('src', true), entry('README.md')] })
    const { statuses, scanning, scan } = useProjectRules()
    await scan('p1')
    expect(statuses.value).toEqual({
      'CLAUDE.md': 'exists',
      'AGENTS.md': 'missing',
      '.cursorrules': 'missing',
    })
    expect(scanning.value).toBe(false)
    // silent 探测：失效路径项目的 500 不弹拦截器全局错误
    expect(fileTreeMock).toHaveBeenCalledWith('p1', undefined, { silent: true })
  })

  it('清单不可达（网络/失效路径 500）也按缺失呈现（可行动面：创建会被真实错误拦住）', async () => {
    fileTreeMock.mockRejectedValue(httpError(500))
    const { statuses, scan } = useProjectRules()
    await scan('p1')
    expect(statuses.value['AGENTS.md']).toBe('missing')
  })

  it('目录形态的同名条目不算规则文件（isDir 排除）', async () => {
    fileTreeMock.mockResolvedValue({ data: [entry('AGENTS.md', true)] })
    const { statuses, scan } = useProjectRules()
    await scan('p1')
    expect(statuses.value['AGENTS.md']).toBe('missing')
  })

  it('过期扫描不回写：切项目后旧响应晚到不覆盖新状态', async () => {
    let releaseOld!: () => void
    fileTreeMock.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseOld = resolve }))
    fileTreeMock.mockResolvedValue({ data: [entry('CLAUDE.md')] })
    const { statuses, scan } = useProjectRules()
    const old = scan('old-project')
    const fresh = scan('new-project')
    await fresh
    releaseOld()
    await old
    // 旧扫描（会先全部置 checking）晚到不覆盖新扫描结果
    expect(statuses.value['CLAUDE.md']).toBe('exists')
  })

  it('空 projectId 直接跳过（不发起请求）', async () => {
    const { scan } = useProjectRules()
    await scan('')
    expect(fileTreeMock).not.toHaveBeenCalled()
  })
})

describe('createFromTemplate', () => {
  it('创建成功置 exists 并返回 created', async () => {
    createFileMock.mockResolvedValue({})
    const { statuses, createFromTemplate } = useProjectRules()
    const r = await createFromTemplate('p1', 'CLAUDE.md', 'zh-CN')
    expect(r).toBe('created')
    expect(statuses.value['CLAUDE.md']).toBe('exists')
    expect(createFileMock).toHaveBeenCalledWith('p1', 'CLAUDE.md', expect.stringContaining('# CLAUDE.md'))
  })

  it('409（扫描后被人抢先创建）按 exists 收场不报错', async () => {
    createFileMock.mockRejectedValue(httpError(409))
    const { statuses, createFromTemplate } = useProjectRules()
    const r = await createFromTemplate('p1', 'AGENTS.md', 'en-US')
    expect(r).toBe('exists')
    expect(statuses.value['AGENTS.md']).toBe('exists')
  })

  it('其余失败返回 failed 且不改状态（拦截器已 toast）', async () => {
    createFileMock.mockRejectedValue(httpError(500))
    const { statuses, createFromTemplate } = useProjectRules()
    const r = await createFromTemplate('p1', 'AGENTS.md', 'en-US')
    expect(r).toBe('failed')
    expect(statuses.value['AGENTS.md']).toBeUndefined()
  })

  it('未知文件名/空项目防御：不落盘空模板', async () => {
    const { createFromTemplate } = useProjectRules()
    expect(await createFromTemplate('p1', 'README.md', 'zh-CN')).toBe('failed')
    expect(await createFromTemplate('', 'CLAUDE.md', 'zh-CN')).toBe('failed')
    expect(createFileMock).not.toHaveBeenCalled()
  })
})
