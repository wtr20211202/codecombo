import { ref } from 'vue'
import { projectApi } from '../api/client'
import { MOVE_BATCH_CAP } from './useFileTreeDragDrop'

/**
 * 批量重命名执行链（P-20261003-283）：预览弹层确认后走批量端点单请求收口
 * （P-20261006-39，此前逐个调单路径 renameFile = N 次串行往返），与批量移动
 * moveEntries（P-20261003-160）同族语义——单批 ≤MOVE_BATCH_CAP 量级护栏、
 * 失败/重名按逐条结果报告不中断批次（P-117 目标防护服务端化为逐条 error
 * 「file already exists」）、silent 调用汇总一次反馈。
 * 输入是弹层产出的有效对照对（非法红标行不上抛，本链不再重复校验名称合法性）。
 * 父目录先于子项的前缀改写（目录改名成功后子项旧路径自动跟进新父路径）由
 * 服务端按提交序 resolve（batch.go batchRenameEntries），本链只负责排序交出。
 */

/** 单条改名对照：弹层预览计算（utils/batchRename.computeBatchRename）过滤
 *  changed 且无 issue 的行产出；执行链只认对照不再解释查找/替换串 */
export interface BatchRenamePair {
  oldPath: string
  newPath: string
}

export function useBatchRename(options: {
  projectId: () => string
  refreshRoot: () => Promise<void>
  message: { success(m: string): void; warning(m: string): void; error(m: string): void }
  t: (k: string, p?: Record<string, unknown>) => string
}) {
  const { projectId, refreshRoot, message, t } = options
  // 批量重命名进行中（宿主可挂忙碌态，与 moving 同族）
  const renaming = ref(false)

  /** 跳过清单条目：叶子名 + 原因 i18n 键（toast 汇总时统一翻译拼装） */
  interface SkipItem {
    name: string
    reasonKey: string
    reasonParams?: Record<string, unknown>
  }

  /**
   * 执行一批改名。父目录先于子项（oldPath 升序保证）：服务端按提交序执行，
   * 目录改名成功后登记旧父前缀 → 新父前缀映射，子项旧路径据此改写（父目录
   * 也在选中集时子项不因旧路径失效而误跳过）。
   */
  async function applyBatchRenames(pairs: BatchRenamePair[]): Promise<void> {
    if (!projectId() || pairs.length === 0) return
    const sorted = [...pairs].sort((a, b) => (a.oldPath < b.oldPath ? -1 : a.oldPath > b.oldPath ? 1 : 0))
    const capped = sorted.slice(0, MOVE_BATCH_CAP)
    const overflow = sorted.length - capped.length

    renaming.value = true
    let ok = 0
    const skipped: SkipItem[] = []
    try {
      try {
        // 拦截器已解包 envelope；响应体为 {ok, skipped, failed, results}
        //（path = 提交对照的 oldPath，调用方按提交清单对账）
        const res: any = await projectApi.batchFiles(
          projectId(),
          { action: 'rename', renames: capped },
          { silent: true },
        )
        for (const r of (res?.results || []) as Array<{ path: string; status: string; error?: string }>) {
          if (r.status === 'ok') {
            ok++
            continue
          }
          skipped.push({
            name: r.path.split('/').pop() || r.path,
            // error 稳定原文「file already exists」= P-117 目标存在防护（重名，
            // 含服务端批内撞名：前对已把同径目标占住）
            reasonKey: r.error === 'file already exists'
              ? 'fileTree.batchRename.skipExists'
              : 'fileTree.batchRename.skipFailed',
          })
        }
      } catch {
        // 整批请求级失败（网络抖动/5xx）：silent 下拦截器不提示，块内条目
        // 逐条计入跳过清单——半成可见，不静默吞批
        for (const pair of capped) {
          skipped.push({ name: pair.oldPath.split('/').pop() || pair.oldPath, reasonKey: 'fileTree.batchRename.skipFailed' })
        }
      }
      if (ok > 0) await refreshRoot() // 命中的父目录不定（跨层级多选）：整树刷新（保留展开状态）
    } finally {
      renaming.value = false
    }

    if (overflow > 0) message.warning(t('fileTree.batchRename.cap', { cap: MOVE_BATCH_CAP, n: overflow }))
    if (skipped.length === 0) {
      message.success(t('fileTree.batchRename.done', { n: ok }))
    } else {
      // 跳过清单取前 3 项摘要（moveEntries 同款截断惯例），失败项不让批次「静默半成」
      const heads = skipped.slice(0, 3)
        .map(s => t('fileTree.batchRename.skipItem', { name: s.name, reason: t(s.reasonKey, s.reasonParams) }))
        .join(', ')
      const itemsNote = heads + (skipped.length > 3 ? '…' : '')
      message.warning(t('fileTree.batchRename.partial', { ok, failed: skipped.length, items: itemsNote }))
    }
  }

  return { renaming, applyBatchRenames }
}
