import { h, ref } from 'vue'
import { useMessage } from 'naive-ui'
import type { MessageReactive } from 'naive-ui'
import { projectApi, replaceApi, type ReplaceExecResult } from '../api/client'
import { useI18n } from './useI18n'
import { confirmDialog } from './useDialog'
import { OPS_FILES_EXTERNAL_CHANGE } from '../utils/opsEvents'
import { buildFilePreview, buildReplaceRegex, type FilePreview } from '../utils/replacePreview'

/**
 * 重命名后引用更新（P-20261005-157）：JetBrains/VS Code「rename 自动更新引用」
 * 的免 LSP 逼近。诚实定位 = 字符串精确匹配启发式 + 预览全量把关。
 *
 * 流程：代码类文件 rename 成功 → toast 带「更新引用？」动作 → 点击后按旧路径
 * 无扩展形态全局搜索（一发覆盖提案双 pattern——'a/b/c.ts' 是 'a/b/c' 的子串，
 * 替换 'a/b/c'→'x/y/d' 后扩展名留在命中段外自然保留，两形态一次替换全收）→
 * 命中走 search-replace 既有预览弹层（ReplacePreviewModal：逐行勾选/排除文件/
 * 预览-执行同函数纪律全复用）。同目录简式 './c' 无法区分指涉（他目录同名文件
 * 的 './c' 引用同形，且 RE2 执行面无 lookahead 可收窄），列「低置信」区默认不勾，
 * 用户逐行判断后再勾选执行。零命中静默不弹（不打扰无引用面的改名）；
 * 搜索失败如实报错（静默会让动作像坏了）。
 *
 * 执行按置信区拆两组分别调 replaceApi.execute（服务端 ReplaceAllLiteral 不支持
 * 捕获组替换，'x/y/d' 与 './d' 两种替换文本无法合并为单 pattern），每组各自
 * 落备份档 + 替换历史（既有记账链覆盖，marks 归属注记见提案④——引用更新产生的
 * 新变更由 replace 侧既有记账与 git 状态面自然呈现）。
 */

/** 代码类扩展 MVP 清单（提案指定）：import/require 引用高发载体；清单外扩展名
 *  （图片/二进制等）改名基本无引用面，直接走普通成功 toast */
const REF_CODE_EXTS = new Set(['ts', 'js', 'vue', 'go', 'py', 'md', 'json'])

/** 命中行形态（projectApi.searchContent 的 data 行，与 ProjectSearch.Match 同源子集） */
interface SearchMatch {
  path: string
  line: number
  content: string
}

/** 单个置信区的执行计划：pattern→replacement + 该区在预览中的文件集 */
interface ExecPlan {
  pattern: string
  replacement: string
  paths: string[]
}

/** 取叶子扩展名（'a/b/c.ts' → 'ts'；无点/隐藏文件/目录形态返回空串） */
function extOf(path: string): string {
  const base = path.split('/').pop() || ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1) : ''
}

/** 去最后一段扩展名（'a/b/c.ts' → 'a/b/c'；'a.b/c' 与 '.env' 不误剥） */
function stripExt(path: string): string {
  const dot = path.lastIndexOf('.')
  const slash = path.lastIndexOf('/')
  return dot > slash && dot > 0 ? path.slice(0, dot) : path
}

/** 搜索结果按文件分组（ProjectSearch.groupMatches 同构，扁平命中序不保留） */
function groupByFile(ms: SearchMatch[]): Map<string, SearchMatch[]> {
  const map = new Map<string, SearchMatch[]>()
  for (const m of ms) {
    const arr = map.get(m.path)
    if (arr) arr.push(m)
    else map.set(m.path, [m])
  }
  return map
}

export function useRenameRefUpdate(options: {
  projectId: () => string
}) {
  const { projectId } = options
  const message = useMessage()
  const { t } = useI18n()

  // ── 预览弹层状态（ReplacePreviewModal 的 props 契约）────────────────────
  const showPreview = ref(false)
  const previewFiles = ref<FilePreview[]>([])
  /** 低置信文件集（仅 './简式' 命中）：弹层内挂「低置信」徽标 */
  const lowConfidencePaths = ref<Set<string>>(new Set())
  /** 勾选集为单一事实源：高置信默认全勾，低置信默认不勾（双闸之「默认不勾」） */
  const selectedPaths = ref<Set<string>>(new Set())
  const executing = ref(false)
  // 两个置信区的执行计划（showPreview 打开期间有效；confirm 按勾选交集圈定 paths）
  let planHigh: ExecPlan | null = null
  let planLow: ExecPlan | null = null

  /**
   * rename 成功的统一反馈口（useFileTreeContext 经 options 转发）：代码类扩展
   * 换成带「更新引用？」动作的可点击 toast，其余保持既有 plain toast。
   */
  function renamedFeedback(oldPath: string, newPath: string) {
    const name = newPath.split('/').pop() || newPath
    if (!REF_CODE_EXTS.has(extOf(newPath))) {
      message.success(t('fileTree.renamedTo', { name }))
      return
    }
    // 动作 toast：10s 驻留 + hover 保活 + 可关闭（点动作即搜，未点到即错过——
    // 引用更新是可选动作，错过无副作用）。render 闭包先声明再赋值，点击时才读
    let toast: MessageReactive | null = null
    toast = message.success(() => h('span', null, [
      t('fileTree.renamedTo', { name }),
      h('span', {
        'data-testid': 'rename-ref-update',
        style: 'cursor:pointer;text-decoration:underline;text-underline-offset:3px;color:var(--brand-accent);font-weight:600;margin-left:6px;',
        onClick: () => {
          toast?.destroy()
          void searchAndPreview(oldPath, newPath)
        },
      }, t('fileTree.refUpdate.action')),
    ]), { duration: 10_000, keepAliveOnHover: true, closable: true })
  }

  /** 动作点击：双置信区并行搜索 → 组装预览（零命中静默返回） */
  async function searchAndPreview(oldPath: string, newPath: string) {
    const pid = projectId()
    if (!pid || executing.value || showPreview.value) return
    // 高置信：旧路径无扩展形态（覆盖 'a/b/c' 与 'a/b/c.ts' 两类引用，见头注）
    const hiPat = stripExt(oldPath)
    const hiRep = stripExt(newPath)
    // 低置信：同目录简式（'./c'），指涉歧义见头注
    const loPat = `./${hiPat.split('/').pop() || hiPat}`
    const loRep = `./${hiRep.split('/').pop() || hiRep}`
    const reHi = buildReplaceRegex(hiPat, { caseSensitive: true, wholeWord: false, useRegex: false })
    const reLo = buildReplaceRegex(loPat, { caseSensitive: true, wholeWord: false, useRegex: false })
    if (!reHi || !reLo) return
    try {
      // 大小写敏感字面量搜索：路径是大小写敏感标识（服务端 linux 盘），导入串同源；
      // 多取 1 条探测截断与 ProjectSearch 同语义（恰好 500 真实命中不误报）
      const [hiRes, loRes] = await Promise.all([
        projectApi.searchContent(pid, { q: hiPat, case: '1', max: 501 }, { silent: true }),
        projectApi.searchContent(pid, { q: loPat, case: '1', max: 501 }, { silent: true }),
      ])
      const hiAll = ((hiRes as any)?.data || []) as SearchMatch[]
      const loAll = ((loRes as any)?.data || []) as SearchMatch[]
      // 服务端 500 截断如实附告（搜索面板同款键）：预览命中集可能不完整
      if (hiAll.length > 500 || loAll.length > 500) {
        message.warning(t('projectSearch.truncatedHint'))
      }
      const hiByFile = groupByFile(hiAll.slice(0, 500))
      const loByFile = groupByFile(loAll.slice(0, 500))
      const files: FilePreview[] = []
      const lowConf = new Set<string>()
      const hiPaths: string[] = []
      const loPaths: string[] = []
      for (const [p, ms] of hiByFile) {
        files.push(buildFilePreview(p, ms, reHi, hiRep))
        hiPaths.push(p)
      }
      for (const [p, ms] of loByFile) {
        // 同文件混含两形态命中极罕见：归高置信组执行（简化：'./简式' 行不被
        // 高置信 pattern 命中即留在预览外，下一轮 rename 可再触发补齐）
        if (hiByFile.has(p)) continue
        files.push(buildFilePreview(p, ms, reLo, loRep))
        lowConf.add(p)
        loPaths.push(p)
      }
      if (files.length === 0) return // 零命中静默不弹
      previewFiles.value = files
      lowConfidencePaths.value = lowConf
      selectedPaths.value = new Set(hiPaths)
      planHigh = hiPaths.length ? { pattern: hiPat, replacement: hiRep, paths: hiPaths } : null
      planLow = loPaths.length ? { pattern: loPat, replacement: loRep, paths: loPaths } : null
      showPreview.value = true
    } catch (e: any) {
      message.error(e?.userMessage || t('errors.unknown'))
    }
  }

  // ── 勾选（ReplacePreviewModal 事件驱动，与 ProjectSearch 同款实现）──────
  function toggleFileSelection(path: string, checked: boolean) {
    const next = new Set(selectedPaths.value)
    if (checked) next.add(path)
    else next.delete(path)
    selectedPaths.value = next
  }

  function toggleSelectAll(checked: boolean) {
    selectedPaths.value = checked
      ? new Set(previewFiles.value.map(f => f.path))
      : new Set()
  }

  /**
   * 弹层确认：按勾选交集圈定每个置信区的 paths，逐组走服务端执行链
   * （敏感 409 → 确认弹层 → 带 confirmSensitive 重放，ProjectSearch.executeReplace
   * 同款循环）。全部成功才关弹层并广播外部变更；中途失败保持弹层打开
   * （已替换文件再跑一遍无命中会被服务端跳过，重试安全）。
   * 返回是否全部成功（敏感确认取消也算未完成，弹层保持打开）。
   */
  async function confirmExec(): Promise<boolean> {
    const pid = projectId()
    if (!pid || executing.value) return false
    const plans = [planHigh, planLow]
      .filter((p): p is ExecPlan => !!p)
      .map(p => ({ ...p, paths: p.paths.filter(x => selectedPaths.value.has(x)) }))
      .filter(p => p.paths.length > 0)
    if (plans.length === 0) return false
    executing.value = true
    const changedAll: string[] = []
    try {
      for (const plan of plans) {
        // 敏感闸重试循环（while+标志而非递归——递归会在外层 finally 关掉执行态）
        let confirmSensitive = false
        for (;;) {
          let data: ReplaceExecResult | undefined
          try {
            const res: any = await replaceApi.execute(pid, {
              pattern: plan.pattern,
              replacement: plan.replacement,
              caseSensitive: true,
              paths: plan.paths,
              confirmSensitive,
            })
            data = res?.data as ReplaceExecResult | undefined
          } catch (e: any) {
            if (!confirmSensitive && e?.data?.code === 'files.sensitive_confirm_required') {
              const hits = (e.data?.sensitiveHits || []) as string[]
              if (!await confirmDialog({
                title: t('search.replace.sensitive.title'),
                type: 'warning',
                content: () => h('div', { style: 'display:flex;flex-direction:column;gap:6px;' }, [
                  h('div', { style: 'color:var(--accent-yellow);' }, t('search.replace.sensitive.warn')),
                  h('div', null, t('search.replace.sensitive.files', { files: hits.join('、') })),
                  h('div', null, t('search.replace.sensitive.confirm')),
                ]),
              })) return false
              confirmSensitive = true
              continue
            }
            throw e
          }
          const changed = (data?.changed || []).map(c => c.path)
          changedAll.push(...changed)
          if (changed.length === 0) {
            // 全部被跳过/冲突（服务端逐文件甄别与前端预览可能失配）：如实回告
            message.warning(t('projectSearch.replacedNone'))
          } else {
            message.success(t('projectSearch.replacedAll', { files: changed.length, matches: data?.totalHits ?? 0 }))
            const skipped = data?.skipped?.length ?? 0
            const conflicts = data?.conflicts?.length ?? 0
            if (skipped + conflicts > 0) {
              message.warning(t('search.replace.partial', { skipped, conflicts }))
            }
            if (data?.truncated) {
              message.warning(t('search.replace.truncatedNote'))
            }
          }
          break
        }
      }
      // 已打开文件从磁盘重读（替换前内容留在编辑器内存里，直接保存会覆盖回替换）
      if (changedAll.length > 0) {
        window.dispatchEvent(new CustomEvent(OPS_FILES_EXTERNAL_CHANGE, { detail: { paths: changedAll } }))
      }
      showPreview.value = false
      return true
    } catch (e: any) {
      message.error(e?.userMessage || e?.message || t('errors.unknown'))
      return false
    } finally {
      executing.value = false
    }
  }

  return {
    renamedFeedback,
    showPreview, previewFiles, lowConfidencePaths, selectedPaths, executing,
    toggleFileSelection, toggleSelectAll, confirmExec,
  }
}
