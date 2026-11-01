import { nextTick, onBeforeUnmount, watch, type Ref, type WatchSource } from 'vue'

/**
 * 通知滚动自动已读（P-20261003-260）：面板打开且开关开启时，把滚动容器内
 * 「仍需标已读」的行登记进 IntersectionObserver，滚入视口即交还调用方标记
 * （Slack「滚过即读」惯例）。机制上与 Shift+A / 分界线正交——本 composable
 * 只产生 markRead 调用，不动任何既有清理动作。
 *
 * 设计要点：
 * - observer 惰性创建且 root 绑定滚动容器（面板是 v-if，每次打开都是新元素，
 *   旧 observer 的 detached root 不再可用——以 root 元素身份判断重建）
 * - 行集合变化后全量重登记（disconnect + 重扫 [data-nav-idx] 行）。通知列表
 *   ≤200 条，重扫是一次 querySelectorAll + 每行一次回调评估，量级可忽略；
 *   换取的是不侵入组件的模板 ref 生命周期（函数 ref 每次渲染换身份会反复
 *   解绑/重绑，重扫式登记没有这层耦合）
 * - 「仍需标已读」由调用方的 idsForElement 在回调时点现场评估（行对象携带
 *   最新 read 位），已标过的行再次触发交集不会产生重复调用
 * - 标记经 300ms 合流窗去重后批量交还：面板打开瞬间视口内一批未读同时触发
 *   （含「未读」页签下标读→行消失→新行入视口的连锁），合流避免逐帧散发
 * - IntersectionObserver 缺失（jsdom 测试环境）时整体 no-op，不抛错
 */

/** 交还调用方的合流窗口：一帧内多行滚入只产生一次批量标记 */
export const AUTO_READ_FLUSH_MS = 300

export interface NotifyAutoReadOptions {
  /** 滚动容器（IntersectionObserver root）；面板 v-if 下每次打开是新元素 */
  listRef: Ref<HTMLElement | undefined>
  /** 自动已读生效中（开关开 且 面板打开）；false 时注销观察并停止登记 */
  isActive: () => boolean
  /** 行元素 → 当前仍需标已读的条目 id（回调时点现场评估，空数组 = 无事可做） */
  idsForElement: (el: Element) => string[]
  /** 单条标记（既有 store.markRead：本地先置位 + 静默同步后端） */
  markRead: (id: string) => void
  /** 触发重扫的响应源（行集合/开关/面板开合） */
  rescanOn: Array<WatchSource<unknown>>
  /** 测试注入口：替代全局 IntersectionObserver 构造器（jsdom 无此 API） */
  observerImpl?: typeof IntersectionObserver
}

export function useNotifyAutoRead(options: NotifyAutoReadOptions) {
  const { listRef, isActive, idsForElement, markRead, rescanOn } = options

  let observer: IntersectionObserver | null = null
  let observerRoot: HTMLElement | null = null
  // 合流窗内的待标集：去重（同一行重复触发不叠加）+ 延迟批量交还
  const pending = new Set<string>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  function flush(): void {
    flushTimer = null
    const batch = [...pending]
    pending.clear()
    for (const id of batch) markRead(id)
  }

  function queue(ids: string[]): void {
    for (const id of ids) pending.add(id)
    if (flushTimer === null) flushTimer = setTimeout(flush, AUTO_READ_FLUSH_MS)
  }

  function teardown(): void {
    observer?.disconnect()
    observer = null
    observerRoot = null
  }

  function rescan(): void {
    if (!isActive()) {
      teardown()
      return
    }
    const list = listRef.value
    if (!list) return
    const Impl = options.observerImpl
      ?? (typeof IntersectionObserver !== 'undefined' ? IntersectionObserver : undefined)
    if (!Impl) return
    // 面板 v-if 每次打开重建滚动容器：root 换元素即换 observer（旧 root 已 detached）
    if (!observer || observerRoot !== list) {
      teardown()
      observerRoot = list
      observer = new Impl((entries) => {
        const ids: string[] = []
        for (const entry of entries) {
          // 只在「进入视口」方向标记；离开视口不做任何事
          if (!entry.isIntersecting) continue
          ids.push(...idsForElement(entry.target))
        }
        if (ids.length > 0) queue(ids)
      }, { root: list, threshold: 0 })
    }
    // 全量重登记：行集合已变化，旧登记目标全量失效后按当前行重建
    observer.disconnect()
    list.querySelectorAll<HTMLElement>('[data-nav-idx]').forEach((el) => {
      if (idsForElement(el).length > 0) observer!.observe(el)
    })
  }

  watch(rescanOn, () => { void nextTick(rescan) })

  onBeforeUnmount(() => {
    teardown()
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    pending.clear()
  })

  return { rescan }
}
