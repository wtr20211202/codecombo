import { describe, it, expect, vi, afterEach } from 'vitest'
import { effectScope, ref } from 'vue'

vi.mock('@/composables/useI18n', () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock('@/api/client', () => ({
  projectApi: { fileTree: vi.fn(), fileList: vi.fn() },
  remoteHostApi: { list: vi.fn().mockResolvedValue({ data: [] }) },
  branchApi: { list: vi.fn().mockResolvedValue({ data: [] }) },
  // 实例命令组（P-20261002-111）：stores/instance 依赖的 api/client 面
  instanceApi: {
    list: vi.fn().mockResolvedValue({ data: [] }),
    check: vi.fn().mockResolvedValue({ data: {} }),
    checkBatch: vi.fn().mockResolvedValue({ data: [] }),
    add: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
  },
  setInstanceContext: vi.fn(),
  // 能力探测（P-20261004-4）：stores/meta 读当前实例上下文归一缓存键
  getCurrentInstanceContext: vi.fn(() => ({ instanceId: null, isRemote: false })),
  cancelAllRequests: vi.fn(),
}))
// 能力探测源（P-20261004-4）：stores/meta 依赖的 metaApi 面（拦住真实
// api/domains/system → http.ts 重依赖链）；声明 flat-file-list 让快路径用例照常走
vi.mock('@/api/domains/system', () => ({
  metaApi: {
    get: vi.fn().mockResolvedValue({
      version: { version: 'test', commit: 'test', buildTime: 'test', apiVersion: '1.0.0' },
      capabilities: ['flat-file-list'],
    }),
  },
}))
// stores/instance 的四个叶子 store 依赖：本文件用不到其行为，
// mock 掉避免连带执行各自的重依赖（i18n/WebSocket/lock 等）
vi.mock('@/stores/changes', () => ({ useChangesStore: () => ({ files: [] }) }))
vi.mock('@/stores/console', () => ({ useConsoleStore: () => ({ clear: vi.fn() }) }))
vi.mock('@/stores/errorLog', () => ({ useErrorLogStore: () => ({ clear: vi.fn() }) }))
vi.mock('@/stores/notification', () => ({ useNotificationStore: () => ({ switchInstance: vi.fn() }) }))

import { useQuickNav } from '@/composables/useQuickNav'
import { useRemoteRecentFiles } from '@/composables/useRemoteRecentFiles'
import { useEditorNavHistory } from '@/composables/useEditorNavHistory'
import { PROJECT_FILE_CHANGED } from '@/composables/useWebSocket'
import { OPS_FILES_EXTERNAL_CHANGE } from '@/utils/opsEvents'
import { setActivePinia, createPinia } from 'pinia'
import { useProjectStore } from '@/stores/project'
import { useRemoteHostStore } from '@/stores/remoteHost'
import { useBranchStore } from '@/stores/branch'
import { useInstanceStore } from '@/stores/instance'
import { useAgentTaskTemplates } from '@/composables/useAgentTaskTemplates'
import { beforeEach } from 'vitest'

beforeEach(() => {
  setActivePinia(createPinia())
  useProjectStore().currentProjectId = 'p1'
  // 远程最近清单（P-20261004-137）模块级单例逐用例复位
  useRemoteRecentFiles().clearRemoteRecent()
})

afterEach(() => {
  vi.useRealTimers()
  // SWR TTL 注入缝（P-20261003-299）逐用例清理，防泄漏到其他用例
  delete (window as unknown as { __scQuickOpenSwrTtlMs?: number }).__scQuickOpenSwrTtlMs
  // 任务模板单例（P-20261005-10 模板命令组注册源）逐用例复位：openCommandPalette
  // 的 load 兜底失败会把出厂预置写进模块级单例，不清理会泄漏到后续用例
  const taskTemplates = useAgentTaskTemplates()
  taskTemplates.templates.value = []
  taskTemplates.customized.value = false
  taskTemplates.loaded.value = false
  // 活动文件信标（P-20261006-20 折叠命令组注册源）是模块级单例，逐用例复位
  // 防本文件用例写入泄漏到同文件后续用例
  useEditorNavHistory().activeFilePath.value = ''
})

describe('useQuickNav', () => {
  it('所有面板初始关闭', () => {
    const n = useQuickNav()
    expect(n.showCommandPalette.value).toBe(false)
    expect(n.showQuickOpen.value).toBe(false)
    expect(n.showProjectSearch.value).toBe(false)
  })

  it('openCommandPalette 打开面板', () => {
    const n = useQuickNav()
    n.openCommandPalette()
    expect(n.showCommandPalette.value).toBe(true)
  })

  it('openProjectSearch 打开搜索', () => {
    const n = useQuickNav()
    n.openProjectSearch()
    expect(n.showProjectSearch.value).toBe(true)
    expect(n.projectSearchSeed.value).toBe('')
  })

  it('openProjectSearch 种子查询词：降级入口带词，普通入口重置（P-20261002-86）', () => {
    const n = useQuickNav()
    n.openProjectSearch('foo bar')
    expect(n.showProjectSearch.value).toBe(true)
    expect(n.projectSearchSeed.value).toBe('foo bar')
    // 关闭后从其他入口（Ctrl+Shift-F / 命令面板）再开，种子必须已重置为空
    n.showProjectSearch.value = false
    n.openProjectSearch()
    expect(n.showProjectSearch.value).toBe(true)
    expect(n.projectSearchSeed.value).toBe('')
  })

  it('closePalettes 关闭所有', () => {
    const n = useQuickNav()
    n.openCommandPalette()
    n.closePalettes()
    expect(n.showCommandPalette.value).toBe(false)
  })

  it('paletteCommands 有期望的命令', () => {
    const n = useQuickNav()
    expect(n.paletteCommands.value.length).toBeGreaterThan(0)
    expect(n.paletteCommands.value.some(c => c.id === 'toggle-theme')).toBe(true)
    // 值班大屏（P-20261002-80）：面板之外的独立路由也有统一面板入口
    expect(n.paletteCommands.value.some(c => c.id === 'monitor')).toBe(true)
  })

  it('paletteCommands 含通知中心命令且 id 无重复', () => {
    const n = useQuickNav()
    const ids = n.paletteCommands.value.map(c => c.id)
    const notifications = n.paletteCommands.value.find(c => c.id === 'notifications')
    expect(notifications).toBeDefined()
    expect(ids.filter(id => id === 'notifications')).toHaveLength(1)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('paletteCommands 含项目规则管理区块直达与按清单展开的规则文件命令（P-20261006-43）', () => {
    const n = useQuickNav()
    const ids = n.paletteCommands.value.map(c => c.id)
    // 区块直达：设置弹窗携锚点（'settings:<tab>' 前缀族外的独立 id）
    expect(ids).toContain('project-rules')
    // 文件级命令按 PROJECT_RULE_FILES 清单展开（单一事实源 projectRuleTemplates）
    expect(ids).toContain('edit-rule:CLAUDE.md')
    expect(ids).toContain('edit-rule:AGENTS.md')
    expect(ids).toContain('edit-rule:.cursorrules')
  })

  it('无激活编辑器不注册折叠命令（P-20261006-20，locate-in-tree 同款条件注册）', () => {
    useEditorNavHistory().activeFilePath.value = ''
    const ids = useQuickNav().paletteCommands.value.map(c => c.id)
    expect(ids).not.toContain('fold-all')
    expect(ids).not.toContain('unfold-all')
    expect(ids).not.toContain('fold-level-1')
    // 信标条件只门控编辑器作用域族：locate-in-tree 同源同隐
    expect(ids).not.toContain('locate-in-tree')
  })

  it('有激活编辑器注册三条折叠命令且 id 契约与分发映射一致（P-20261006-20）', () => {
    useEditorNavHistory().activeFilePath.value = 'src/very-long-file.ts'
    const cmds = useQuickNav().paletteCommands.value.filter(
      c => ['fold-all', 'unfold-all', 'fold-level-1'].includes(c.id),
    )
    expect(cmds.map(c => c.id)).toEqual(['fold-all', 'unfold-all', 'fold-level-1'])
    // 标题/分类走 i18n 键（本文件 t mock 返回键名）
    expect(cmds[0]!.title).toBe('commandPalette.cmdFoldAll')
    expect(cmds[1]!.title).toBe('commandPalette.cmdUnfoldAll')
    expect(cmds[2]!.title).toBe('commandPalette.cmdFoldLevel1')
    expect(cmds[0]!.category).toBe('layout.view')
  })

  it('无当前项目不注册规则文件命令（路径相对项目根），区块直达仍在（P-20261006-43）', () => {
    const projectStore = useProjectStore()
    projectStore.currentProjectId = ''
    const n = useQuickNav()
    const ids = n.paletteCommands.value.map(c => c.id)
    expect(ids.some(id => id.startsWith('edit-rule:'))).toBe(false)
    expect(ids).toContain('project-rules')
  })

  it('分享当前文件：仅项目内已保存的活跃文件注册（P-20261020-8）', () => {
    const files = ref([{ path: 'src/a.ts', name: 'a.ts', content: 'saved', originalContent: 'saved' }])
    useEditorNavHistory().activeFilePath.value = 'src/a.ts'
    const cmd = useQuickNav(files).paletteCommands.value.find(c => c.id === 'share-current-file')
    expect(cmd?.title).toBe('commandPalette.cmdShareCurrentFile')
    expect(cmd?.category).toBe('layout.view')

    // 未保存修改（脏 buffer）：服务端分享取磁盘版本，不注册
    files.value = [{ path: 'src/a.ts', name: 'a.ts', content: 'dirty', originalContent: 'saved' }]
    expect(useQuickNav(files).paletteCommands.value.some(c => c.id === 'share-current-file')).toBe(false)

    // 远程伪路径：远程文件分享是独立数据面，不注册
    files.value = [{ path: 'remote:h1:/srv/a.ts', name: 'a.ts', content: 'saved', originalContent: 'saved' }]
    useEditorNavHistory().activeFilePath.value = 'remote:h1:/srv/a.ts'
    expect(useQuickNav(files).paletteCommands.value.some(c => c.id === 'share-current-file')).toBe(false)

    // 无打开文件（信标空）：不注册
    useEditorNavHistory().activeFilePath.value = ''
    expect(useQuickNav(files).paletteCommands.value.some(c => c.id === 'share-current-file')).toBe(false)
  })

  it('paletteCommands 按主机动态生成连接/诊断/执行三形态命令（P-20261005-218）', () => {
    const hostStore = useRemoteHostStore()
    hostStore.hosts = [
      { id: 'h1', name: 'WSL', host: '127.0.0.1', port: 23, user: 'root', authType: 'password', createdAt: '', updatedAt: '' },
    ] as never
    const n = useQuickNav()
    const ids = n.paletteCommands.value.map(c => c.id)
    // 连接主机（P-20261005-218）：第三形态，标题前缀「连接：」与诊断/执行区分
    expect(ids).toContain('connect-host:h1')
    expect(ids).toContain('diag-host:h1')
    expect(ids).toContain('exec-host:h1')
    const connect = n.paletteCommands.value.find(c => c.id === 'connect-host:h1')
    expect(connect?.title).toBe('commandPalette.cmdConnectHost')
    expect(connect?.category).toBe('commandPalette.categoryRemoteOps')
    // keywords 携连接语义（提案指定：connect ssh 远程 连接）
    expect(connect?.keywords).toContain('connect')
    expect(connect?.keywords).toContain('连接')
  })

  it('paletteCommands 含多主机巡检对比命令且与单主机命令不重复（P-20261004-58）', () => {
    const hostStore = useRemoteHostStore()
    hostStore.hosts = [
      { id: 'h1', name: 'WSL', host: '127.0.0.1', port: 23, user: 'root', authType: 'password', createdAt: '', updatedAt: '' },
    ] as never
    const n = useQuickNav()
    const ids = n.paletteCommands.value.map(c => c.id)
    expect(ids).toContain('diag-compare-batch')
    expect(ids.filter(id => id === 'diag-compare-batch')).toHaveLength(1)
  })

  it('paletteCommands 生成项目切换命令且排除当前项目', () => {
    const projectStore = useProjectStore()
    projectStore.projects = [
      { id: 'p1', name: '当前项目' },
      { id: 'p2', name: '其他项目' },
      { id: 'p3', name: '第三个项目' },
    ] as never
    const n = useQuickNav()
    const cmds = n.paletteCommands.value.filter(c => c.id.startsWith('switch-project:'))
    expect(cmds.map(c => c.id).sort()).toEqual(['switch-project:p2', 'switch-project:p3'])
  })

  it('paletteCommands 按本地分支生成分支切换命令（当前置顶标注，其余按名）', () => {
    const branchStore = useBranchStore()
    branchStore.branches = [
      { name: 'feature/x', isCurrent: false, isRemote: false, isMerged: false, upstream: '', ahead: 0, behind: 0 },
      { name: 'main', isCurrent: true, isRemote: false, isMerged: false, upstream: '', ahead: 0, behind: 0 },
      { name: 'develop', isCurrent: false, isRemote: false, isMerged: false, upstream: '', ahead: 0, behind: 0 },
      // 远程分支不进命令组（checkout 语义只对本地分支）
      { name: 'remotes/origin/main', isCurrent: false, isRemote: true, isMerged: false, upstream: '', ahead: 0, behind: 0 },
    ] as never
    const n = useQuickNav()
    const branchCmds = n.paletteCommands.value.filter(c => c.id.startsWith('checkout:'))
    expect(branchCmds.map(c => c.id)).toEqual(['checkout:main', 'checkout:develop', 'checkout:feature/x'])
    // 当前分支置顶 + 副标题标注；非当前分支无标注
    expect(branchCmds[0]!.subtitle).toBeTruthy()
    expect(branchCmds[1]!.subtitle).toBeUndefined()
    // 关键词含分支名：输分支名即可过滤直达
    expect(branchCmds[0]!.keywords).toContain('main')
    expect(branchCmds[2]!.keywords).toContain('feature/x')
  })

  it('分支清单为空或加载中不生成分支命令组', () => {
    const branchStore = useBranchStore()
    branchStore.branches = []
    const n = useQuickNav()
    expect(n.paletteCommands.value.some(c => c.id.startsWith('checkout:'))).toBe(false)
    // 加载中：即使有数据也不显示（防闪出过期清单）
    branchStore.loading = true
    branchStore.branches = [
      { name: 'main', isCurrent: true, isRemote: false, isMerged: false, upstream: '', ahead: 0, behind: 0 },
    ] as never
    const m = useQuickNav()
    expect(m.paletteCommands.value.some(c => c.id.startsWith('checkout:'))).toBe(false)
  })

  it('paletteCommands 按实例清单生成实例切换命令（本机置顶、远程按名，当前标注）', () => {
    const instanceStore = useInstanceStore()
    instanceStore.instances = [
      { id: 'inst-b', name: 'Beta机', isLocal: false, url: 'http://10.0.0.2:9990', status: 'online' },
      { id: 'local', name: '本机', isLocal: true, url: '', status: 'online' },
      { id: 'inst-a', name: 'Alpha机', isLocal: false, url: 'http://192.168.1.10:8800', status: 'offline' },
    ] as never
    instanceStore.currentInstanceId = 'inst-a'
    const n = useQuickNav()
    const cmds = n.paletteCommands.value.filter(c => c.id.startsWith('switch-instance:'))
    // 复用 orderedInstances 展示序：本机置顶、远程按名升序
    expect(cmds.map(c => c.id)).toEqual(['switch-instance:local', 'switch-instance:inst-a', 'switch-instance:inst-b'])
    // 当前实例带副标题标注，其余无
    expect(cmds[1]!.subtitle).toBeTruthy()
    expect(cmds[0]!.subtitle).toBeUndefined()
    expect(cmds[2]!.subtitle).toBeUndefined()
    // 关键词含实例名与主机地址：输名或地址都能过滤直达
    expect(cmds[2]!.keywords).toContain('Beta机')
    expect(cmds[2]!.keywords).toContain('10.0.0.2')
    // 本机展示名经 t('instance.local')（本文件 t mock 返回键名）
    expect(cmds[0]!.keywords).toContain('instance.local')
  })

  it('实例清单为空或仅本机单实例不生成实例切换命令', () => {
    const instanceStore = useInstanceStore()
    instanceStore.instances = []
    expect(useQuickNav().paletteCommands.value.some(c => c.id.startsWith('switch-instance:'))).toBe(false)
    // 仅本机：没有可切换目标，组不显示
    instanceStore.instances = [
      { id: 'local', name: '本机', isLocal: true, url: '', status: 'online' },
    ] as never
    expect(useQuickNav().paletteCommands.value.some(c => c.id.startsWith('switch-instance:'))).toBe(false)
  })

  it('paletteCommands 按模板清单生成「按模板新建会话」命令，keywords 携正文（P-20261005-10）', () => {
    useAgentTaskTemplates().templates.value = [
      { id: 'tpl-x', name: '审查文件', prompt: '请审查 {file} 当前改动并给出意见' },
      { id: 'tpl-y', name: '写测试', prompt: '为当前文件补充单元测试' },
    ]
    const n = useQuickNav()
    const cmds = n.paletteCommands.value.filter(c => c.id.startsWith('template:'))
    expect(cmds.map(c => c.id)).toEqual(['template:tpl-x', 'template:tpl-y'])
    // 标题/分类走 i18n 键（本文件 t mock 返回键名）
    expect(cmds[0]!.title).toBe('commandPalette.cmdNewFromTemplate')
    expect(cmds[0]!.category).toBe('commandPalette.categoryTemplate')
    // 模板正文头部进 keywords：输模板内容片段也能搜到（内容可搜）
    expect(cmds[0]!.keywords).toContain('请审查')
    expect(cmds[1]!.keywords).toContain('补充单元测试')
  })

  it('模板清单为空不生成模板命令组', () => {
    useAgentTaskTemplates().templates.value = []
    expect(useQuickNav().paletteCommands.value.some(c => c.id.startsWith('template:'))).toBe(false)
  })

  it('isPaletteOpen 反应状态', () => {
    const n = useQuickNav()
    expect(n.isPaletteOpen.value).toBe(false)
    n.openCommandPalette()
    expect(n.isPaletteOpen.value).toBe(true)
  })

  it('loadPaletteFiles 快路径请求 max=20000 且达上限标记截断（P-20261002-77）', async () => {
    const { projectApi } = await import('@/api/client')
    const fileList = projectApi.fileList as ReturnType<typeof vi.fn>
    // 恰好 20000 条 = 服务端在 max 处停止遍历 → 视为截断
    fileList.mockResolvedValue({ data: Array.from({ length: 20000 }, (_, i) => ({ name: `f${i}.ts`, path: `src/f${i}.ts` })) })
    const n = useQuickNav()
    await n.loadPaletteFiles()
    expect(fileList).toHaveBeenCalledWith('p1', 20000)
    expect(n.paletteFiles.value).toHaveLength(20000)
    expect(n.paletteFilesTruncated.value).toBe(true)

    // 未达上限不标记截断
    fileList.mockResolvedValue({ data: [{ name: 'a.ts', path: 'src/a.ts' }] })
    const m = useQuickNav()
    await m.loadPaletteFiles()
    expect(m.paletteFiles.value).toHaveLength(1)
    expect(m.paletteFilesTruncated.value).toBe(false)
  })

  // —— 事件失效链（P-20261003-73）：仅清缓存键（惰性重拉），1s 尾沿去抖 ——
  // 经 effectScope 实例化：失效监听随 scope.stop 注销，避免跨用例泄漏

  it('PROJECT_FILE_CHANGED（WS file.changed 广播）1s 尾沿后清缓存键，下次拉取重发请求', async () => {
    const { projectApi } = await import('@/api/client')
    const fileList = projectApi.fileList as ReturnType<typeof vi.fn>
    fileList.mockClear() // 模块级 mock 跨用例累计计数，先清零再断言增量
    fileList.mockResolvedValue({ data: [{ name: 'a.ts', path: 'src/a.ts' }] })
    const scope = effectScope()
    const n = scope.run(() => useQuickNav())!
    await n.loadPaletteFiles()
    await n.loadPaletteFiles()
    expect(fileList).toHaveBeenCalledTimes(1) // 项目级缓存命中基线
    expect(n.paletteFilesCacheKey.value).toBe('p1')

    vi.useFakeTimers()
    window.dispatchEvent(new CustomEvent(PROJECT_FILE_CHANGED))
    await vi.advanceTimersByTimeAsync(999)
    expect(n.paletteFilesCacheKey.value).toBe('p1') // 去抖窗口内未失效
    await vi.advanceTimersByTimeAsync(1)
    vi.useRealTimers()
    expect(n.paletteFilesCacheKey.value).toBe('') // 尾沿到点清键

    await n.loadPaletteFiles()
    expect(fileList).toHaveBeenCalledTimes(2) // 惰性重拉
    scope.stop()
  })

  it('OPS_FILES_EXTERNAL_CHANGE 同样失效；scope 注销后事件不再清键', async () => {
    const { projectApi } = await import('@/api/client')
    const fileList = projectApi.fileList as ReturnType<typeof vi.fn>
    fileList.mockClear() // 模块级 mock 跨用例累计计数，先清零再断言增量
    fileList.mockResolvedValue({ data: [{ name: 'a.ts', path: 'src/a.ts' }] })
    const scope = effectScope()
    const n = scope.run(() => useQuickNav())!
    await n.loadPaletteFiles()
    expect(fileList).toHaveBeenCalledTimes(1)

    vi.useFakeTimers()
    window.dispatchEvent(new CustomEvent(OPS_FILES_EXTERNAL_CHANGE, { detail: { paths: ['src/a.ts'] } }))
    await vi.advanceTimersByTimeAsync(1000)
    vi.useRealTimers()
    await n.loadPaletteFiles()
    expect(fileList).toHaveBeenCalledTimes(2)

    scope.stop() // onScopeDispose 生效路径：监听随作用域注销
    vi.useFakeTimers()
    window.dispatchEvent(new CustomEvent(OPS_FILES_EXTERNAL_CHANGE))
    await vi.advanceTimersByTimeAsync(1000)
    vi.useRealTimers()
    expect(n.paletteFilesCacheKey.value).toBe('p1') // 键未被再清
    await n.loadPaletteFiles()
    expect(fileList).toHaveBeenCalledTimes(2) // 仍命中缓存
  })

  // —— SWR 陈旧换新（P-20261003-299）：超 TTL 打开面板旧表立即可搜、后台
  // 静默重拉换新；TTL 经 window.__scQuickOpenSwrTtlMs 注入缝驱动过期路径

  it('新鲜缓存打开不重发；注入 TTL=0 后打开旧表保留、后台重拉换新、无 loading', async () => {
    const { projectApi } = await import('@/api/client')
    const fileList = projectApi.fileList as ReturnType<typeof vi.fn>
    fileList.mockClear()
    fileList.mockResolvedValue({ data: [{ name: 'a.ts', path: 'src/a.ts' }] })
    const scope = effectScope()
    const n = scope.run(() => useQuickNav())!
    await n.loadPaletteFiles()
    await n.loadPaletteFiles()
    expect(fileList).toHaveBeenCalledTimes(1) // 新鲜命中基线（默认 TTL 30s）
    expect(n.paletteFilesLoading.value).toBe(false)

    // 注入 TTL=0：每次打开都视为陈旧 → SWR 后台重拉
    ;(window as unknown as { __scQuickOpenSwrTtlMs?: number }).__scQuickOpenSwrTtlMs = 0
    let release!: () => void
    fileList.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }).then(() => ({
      data: [{ name: 'a.ts', path: 'src/a.ts' }, { name: 'b.ts', path: 'src/b.ts' }],
    })))
    void n.loadPaletteFiles() // 陈旧路径：立即返回，不等响应
    await vi.waitFor(() => expect(fileList).toHaveBeenCalledTimes(2)) // 重拉已发出且挂起
    expect(n.paletteFiles.value).toHaveLength(1) // 旧表保留（立即可搜）
    expect(n.paletteFilesLoading.value).toBe(false) // 无 loading 遮罩
    release()
    await vi.waitFor(() => expect(n.paletteFiles.value).toHaveLength(2)) // 响应回来换新
    expect(fileList).toHaveBeenCalledTimes(2)
    scope.stop()
  })

  it('SWR 重拉失败静默保留旧表（陈旧好过空白），loading 不置位', async () => {
    const { projectApi } = await import('@/api/client')
    const fileList = projectApi.fileList as ReturnType<typeof vi.fn>
    const fileTree = projectApi.fileTree as ReturnType<typeof vi.fn>
    fileList.mockClear()
    fileList.mockResolvedValue({ data: [{ name: 'a.ts', path: 'src/a.ts' }] })
    const scope = effectScope()
    const n = scope.run(() => useQuickNav())!
    await n.loadPaletteFiles()
    expect(n.paletteFiles.value).toHaveLength(1)

    ;(window as unknown as { __scQuickOpenSwrTtlMs?: number }).__scQuickOpenSwrTtlMs = 0
    // 快路径 fileList 失败会被 catch 回退 BFS 慢路径——两条路都得断才叫重拉失败
    fileList.mockRejectedValueOnce(new Error('network down'))
    fileTree.mockRejectedValueOnce(new Error('network down'))
    await n.loadPaletteFiles() // 触发后台重拉（内部吞错）
    await vi.waitFor(() => expect(fileList).toHaveBeenCalledTimes(2))
    await new Promise(r => setTimeout(r, 0)) // 冲掉拒绝链的微任务
    expect(n.paletteFiles.value).toHaveLength(1) // 旧表保留
    expect(n.paletteFilesTruncated.value).toBe(false)
    expect(n.paletteFilesLoading.value).toBe(false)
    scope.stop()
  })

  it('SWR 响应回来时项目已切换则丢弃（cacheKey 竞态守卫）', async () => {
    const { projectApi } = await import('@/api/client')
    const fileList = projectApi.fileList as ReturnType<typeof vi.fn>
    fileList.mockClear()
    fileList.mockResolvedValue({ data: [{ name: 'a-p1.ts', path: 'src/a-p1.ts' }] })
    const scope = effectScope()
    const n = scope.run(() => useQuickNav())!
    await n.loadPaletteFiles() // p1 缓存
    expect(n.paletteFilesCacheKey.value).toBe('p1')

    ;(window as unknown as { __scQuickOpenSwrTtlMs?: number }).__scQuickOpenSwrTtlMs = 0
    let releaseP1!: () => void
    fileList.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseP1 = resolve }).then(() => ({
      data: [{ name: 'stale-p1.ts', path: 'src/stale-p1.ts' }],
    })))
    void n.loadPaletteFiles() // p1 后台重拉（挂起中）
    // 切到 p2 走全量加载，p2 响应就绪先落
    useProjectStore().currentProjectId = 'p2'
    fileList.mockResolvedValue({ data: [{ name: 'b-p2.ts', path: 'src/b-p2.ts' }] })
    await n.loadPaletteFiles()
    expect(n.paletteFiles.value.map(f => f.name)).toEqual(['b-p2.ts'])

    // p1 的过期响应此刻才到：必须被丢弃，不得覆盖 p2 的列表与缓存键
    releaseP1()
    await new Promise(r => setTimeout(r, 0))
    expect(n.paletteFiles.value.map(f => f.name)).toEqual(['b-p2.ts'])
    expect(n.paletteFilesCacheKey.value).toBe('p2')
    scope.stop()
  })

  // —— 远程文件层（P-20261004-137）：已开远程签 + 最近远程派生，与项目清单
  // 换新链解耦（SWR 整体替换/首页清空都不影响远程层）

  it('paletteRemoteFiles：已开签优先 + 最近远程补尾、hostId+rpath 去重，首页无项目仍可用', async () => {
    const recent = useRemoteRecentFiles()
    recent.pushRemoteRecent({ hostId: 'h1', rpath: '/srv/a.txt', name: 'a.txt' })
    recent.pushRemoteRecent({ hostId: 'h1', rpath: '/srv/b.txt', name: 'b.txt' })
    const hostStore = useRemoteHostStore()
    hostStore.hosts = [
      { id: 'h1', name: 'Alpha' }, { id: 'h2', name: 'Beta' },
    ] as never
    // 首页（无当前项目）：远程层不依赖项目上下文
    useProjectStore().currentProjectId = ''
    const openFiles = ref([
      { path: 'remote:h1:/srv/a.txt', name: 'a.txt' }, // 与最近远程重复：只出一次（已开签位）
      { path: 'remote:h2:/srv/c.txt', name: 'c.txt' },
      { path: 'src/local.ts', name: 'local.ts' }, // 本地签不入远程层
    ])
    const n = useQuickNav(openFiles)

    const list = n.paletteRemoteFiles.value
    expect(list.map(f => `${f.hostId}:${f.rpath}`)).toEqual([
      'h1:/srv/a.txt', 'h2:/srv/c.txt', 'h1:/srv/b.txt',
    ])
    expect(list[0]).toMatchObject({
      path: 'remote:h1:/srv/a.txt', name: 'a.txt', hostId: 'h1', rpath: '/srv/a.txt', hostName: 'Alpha',
    })

    // 修正注记①的换新点：首页 loadPaletteFiles 清空项目清单（SWR 整体替换同点）
    // 不触远程层——远程分组不会因一次换新消失
    await n.loadPaletteFiles()
    expect(n.paletteFiles.value).toEqual([])
    expect(n.paletteRemoteFiles.value).toHaveLength(3)

    // 已开签关闭（从 openFiles 消失）后，最近远程仍保候选（环形序：后打开的在前）
    openFiles.value = []
    expect(n.paletteRemoteFiles.value.map(f => f.rpath)).toEqual(['/srv/b.txt', '/srv/a.txt'])
    recent.clearRemoteRecent()
  })
})
