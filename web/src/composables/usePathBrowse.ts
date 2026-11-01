import { computed, ref, watch, type Ref } from 'vue'
import { browseApi } from '../api/client'
import { serverPathSep } from './useServerPathSep'

export interface DirEntry {
  name: string
  path: string
  /** 条目为符号链接/junction 且指向目录（UI 显示链接标记） */
  link?: boolean
}

export interface PathBrowseOptions {
  /** 用户通过联想项或浏览面板「挑选」一个目录时触发（先于 pathRef 变更） */
  onSelect?: (path: string) => void
}

/**
 * 路径浏览 + 输入联想状态机。
 * 直接读写传入的 pathRef（单一数据源）；消费方负责路径相关的业务逻辑（如名称推断）。
 */
export function usePathBrowse(pathRef: Ref<string>, options?: PathBrowseOptions) {
  // 联想状态
  const suggestions = ref<DirEntry[]>([])
  const showSuggestions = ref(false)
  const selectedIdx = ref(-1)
  let suggestTimer: ReturnType<typeof setTimeout> | null = null
  let suggestGen = 0

  // 浏览面板状态
  const browseDirs = ref<DirEntry[]>([])
  const browseCurrent = ref('')
  const browseLoading = ref(false)
  // 浏览面板打开期间抑制输入联想：面板本身就是目录列表，联想下拉只会叠在
  // 面板上方造成双层列表（选择目录会改 pathRef，250ms 防抖联想必然误触发）
  const browseActive = ref(false)

  function pathSep(): string {
    // 按服务端 OS 取分隔符：路径拼接的目标是服务端文件系统，
    // 浏览器平台与部署平台无关（远程部署时浏览器是 Windows、服务是 Linux）
    return serverPathSep()
  }

  function parsePathSegments(input: string): { parent: string; prefix: string } | null {
    const normalized = input.replace(/\\/g, '/')
    if (normalized.length < 2) return null
    const lastSep = normalized.lastIndexOf('/')
    if (lastSep < 0) return null
    return {
      parent: normalized.substring(0, lastSep) || '/',
      prefix: normalized.substring(lastSep + 1).toLowerCase(),
    }
  }

  async function fetchSuggestions(gen: number) {
    if (browseActive.value) return
    const input = pathRef.value
    if (!input || (input.length < 2 && !/^[A-Za-z]$/.test(input))) {
      suggestions.value = []
      showSuggestions.value = false
      return
    }
    const normalized = input.replace(/\\/g, '/')
    // Windows 盘根输入（C / C: / C:/）补成盘根路径
    if (/^[A-Za-z](:?\/?)?$/.test(normalized)) {
      try {
        const driveRoot = /^[A-Za-z]:/.test(normalized) ? normalized.replace(/\/$/, '') : normalized + ':'
        const res: any = await browseApi.list(driveRoot)
        if (gen !== suggestGen) return
        suggestions.value = (res.data || []).filter((d: any) => d.name !== '..')
        showSuggestions.value = suggestions.value.length > 0
        selectedIdx.value = -1
      } catch {
        if (gen !== suggestGen) return
        suggestions.value = []
        showSuggestions.value = false
      }
      return
    }
    const parsed = parsePathSegments(input)
    if (!parsed) {
      suggestions.value = []
      showSuggestions.value = false
      return
    }
    try {
      const res: any = await browseApi.list(parsed.parent)
      if (gen !== suggestGen) return
      const dirs: DirEntry[] = res.data || []
      suggestions.value = dirs
        .filter(d => d.name !== '..')
        .filter(d => !parsed.prefix || d.name.toLowerCase().includes(parsed.prefix))
      showSuggestions.value = suggestions.value.length > 0
      selectedIdx.value = -1
    } catch {
      if (gen !== suggestGen) return
      suggestions.value = []
      showSuggestions.value = false
    }
  }

  // 路径变化：面板打开中（面板内导航 selectBrowseDir/goUp 也会改 pathRef）→
  // 面板保持打开由 browseDirectory 刷新、联想抑制；否则关闭面板 + 防抖联想。
  // 注意不能用「赋值前后置位同步标志」区分——Vue watcher 是异步 flush，
  // 回调执行时同步标志早已复位
  watch(pathRef, () => {
    if (browseActive.value) return
    closeBrowse()
    if (suggestTimer) clearTimeout(suggestTimer)
    const gen = ++suggestGen
    suggestTimer = setTimeout(() => {
      void fetchSuggestions(gen)
    }, 250)
  })

  function selectSuggestion(item: DirEntry) {
    const sep = pathSep()
    const next = item.path + sep
    options?.onSelect?.(next) // 先通知消费方（便于预设标志位）
    pathRef.value = next
    showSuggestions.value = false
    suggestions.value = []
    if (suggestTimer) clearTimeout(suggestTimer)
    const gen = ++suggestGen
    suggestTimer = setTimeout(() => {
      void fetchSuggestions(gen)
    }, 100)
  }

  function handleInputKeydown(e: KeyboardEvent) {
    if (!showSuggestions.value || suggestions.value.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selectedIdx.value = Math.min(selectedIdx.value + 1, suggestions.value.length - 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      selectedIdx.value = Math.max(selectedIdx.value - 1, -1)
    } else if (e.key === 'Enter' && selectedIdx.value >= 0) {
      e.preventDefault()
      selectSuggestion(suggestions.value[selectedIdx.value]!)
    } else if (e.key === 'Escape') {
      showSuggestions.value = false
    }
  }

  function blurSuggestions() {
    showSuggestions.value = false
  }

  async function browseDirectory(path?: string) {
    browseLoading.value = true
    browseActive.value = true
    showSuggestions.value = false
    suggestions.value = []
    try {
      const res: any = await browseApi.list(path)
      browseDirs.value = res.data || []
      browseCurrent.value = res.current || ''
    } catch {
      browseDirs.value = []
    } finally {
      browseLoading.value = false
    }
  }

  function selectBrowseDir(dir: DirEntry) {
    const sep = pathSep()
    const next = dir.path + sep
    options?.onSelect?.(next) // 先通知消费方
    pathRef.value = next
    void browseDirectory(dir.path)
  }

  // 服务端在列表首位恒置 '..' 父目录条目（盘符列表等顶层视图除外）；
  // 父级与当前目录相同（已到根/盘根）时上级按钮禁用
  const parentEntry = computed<DirEntry | null>(() =>
    browseDirs.value.find(d => d.name === '..') ?? null,
  )
  const canGoUp = computed(
    () => !!parentEntry.value && parentEntry.value.path !== browseCurrent.value,
  )

  function goUp() {
    if (parentEntry.value && canGoUp.value) selectBrowseDir(parentEntry.value)
  }

  /** 选择当前浏览中的目录本身（无需进入目录内部再确认，业界选择器惯例） */
  function selectCurrent() {
    if (!browseCurrent.value) return
    options?.onSelect?.(browseCurrent.value)
    pathRef.value = browseCurrent.value
    closeBrowse()
  }

  function handleBrowse() {
    void browseDirectory(pathRef.value || undefined)
  }

  function closeBrowse() {
    browseActive.value = false
    browseDirs.value = []
    browseCurrent.value = ''
    browseLoading.value = false
  }

  return {
    suggestions,
    showSuggestions,
    selectedIdx,
    browseDirs,
    browseCurrent,
    browseLoading,
    parentEntry,
    canGoUp,
    goUp,
    selectCurrent,
    handleInputKeydown,
    blurSuggestions,
    selectSuggestion,
    handleBrowse,
    selectBrowseDir,
    closeBrowse,
  }
}
