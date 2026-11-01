import { ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useProjectStore } from '../stores/project'
import { useNotificationStore } from '../stores/notification'
import { remoteApi, type FetchAllItem } from '../api/domains/git'
import { useI18n } from './useI18n'

/** 批量拉取结果 → 通知/摘要文案素材（纯函数：逐仓明细格式与 partial/done
 *  文案选择是首页与命令面板双入口共享的行为契约，单测锚点） */
export interface FetchAllNotice {
  allOk: boolean
  noticeType: 'success' | 'warning'
  titleKey: string
  titleParams: Record<string, unknown>
  toastKey: string
  toastParams: Record<string, unknown>
  detail: string
}

export function buildFetchAllNotice(items: FetchAllItem[]): FetchAllNotice {
  const failed = items.filter(i => !i.ok)
  const allOk = failed.length === 0
  return {
    allOk,
    noticeType: allOk ? 'success' : 'warning',
    titleKey: allOk ? 'git.fetchAll.doneTitle' : 'git.fetchAll.partialTitle',
    titleParams: allOk ? { n: items.length } : { fail: failed.length },
    toastKey: allOk ? 'git.fetchAll.doneToast' : 'git.fetchAll.partialToast',
    toastParams: allOk ? { n: items.length } : { ok: items.length - failed.length, fail: failed.length },
    detail: items.map(i => i.ok ? `✓ ${i.name}` : `✗ ${i.name}：${i.error}`).join('\n'),
  }
}

/**
 * 一键全部拉取（P-20261002-41 批量链路的共享封装，P-20261003-309 自首页
 * HomeView 抽出）：POST /fetch-all（服务端并发池逐项目 fetch、失败隔离逐项
 * 报告）→ 通知中心记逐仓明细（✓/✗ 行）+ toast 报摘要。防抖 fetchingAll 防重入；
 * 整批 HTTP 失败时响应拦截器已弹友好提示，这里不再打扰。完成后刷新项目清单
 * （fetch 后分支可能变化），调用方经 refreshAheadBehind 挂自己的 ahead/behind
 * 刷新（首页项目卡与 Layout 顶栏下拉各自持有 map 状态，不共享）。
 */
export function useFetchAll(options: { refreshAheadBehind?: () => unknown } = {}) {
  const fetchingAll = ref(false)
  const projectStore = useProjectStore()
  const notificationStore = useNotificationStore()
  const { t } = useI18n()
  const message = useMessage()

  async function fetchAllProjects() {
    if (fetchingAll.value || projectStore.projects.length === 0) return
    fetchingAll.value = true
    try {
      const res = await remoteApi.fetchAll() as unknown as { data?: FetchAllItem[] }
      const n = buildFetchAllNotice(res.data || [])
      notificationStore.add({
        type: n.noticeType,
        category: 'git',
        title: t(n.titleKey, n.titleParams),
        body: n.detail,
      })
      if (n.allOk) message.success(t(n.toastKey, n.toastParams))
      else message.warning(t(n.toastKey, n.toastParams))
    } catch {
      // 整批 HTTP 失败：响应拦截器已弹友好提示，这里不重复打扰
    } finally {
      fetchingAll.value = false
    }
    projectStore.fetchProjects()
      // 回调留在链内：ahead/behind 刷新失败同走 silent catch（原首页实现语义）
      .then(() => options.refreshAheadBehind?.())
      .catch(() => { /* silent */ })
  }

  return { fetchingAll, fetchAllProjects }
}
