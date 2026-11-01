import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { Router } from 'vue-router'
import type { Composer } from 'vue-i18n'
import { createDiscreteApi } from 'naive-ui'
import type { MessageApi } from 'naive-ui'
import { useI18n } from './useI18n'
import { useThemeStore } from '../stores/theme'
import { useLockStore } from '../stores/lock'
import { useProjectStore } from '../stores/project'
import { claudeApi, type ClaudeSessionInfo } from '../api/domains/claude'
import { turnParam } from '../utils/sessionDeepLink'

/**
 * 回放深链消费（P-20261003-154）：/project?session=<id>&turn=<N>[&project=<pid>]
 * 直达回放弹层并定位到目标条目——?file= 文件深链（useLayoutViews）同款
 * 挂起-消费模式：
 * - 挂载早期只捕获挂起不清 query：bootstrap 未完成（uiState 项目恢复会切走
 *   上下文）或锁定态（API 全被 423 拒，会话解析必败）时消费必败；query 清除
 *   延迟到消费时，实例切换 remount 后新宿主仍能从 URL 重新捕获
 * - bootstrap 完成后由 useLayoutShell 调 flushSessionReplayDeepLink 消费；
 *   此后 SPA 内再入（query 变化）即时消费；锁定期间到点的深链由解锁 watcher
 *   接力（与文件深链 unlock 接力同款）
 * - 项目定位（?file= 同语义）：先行切到归属项目——回放弹层不受项目切换的
 *   「清空打开文件」watcher 影响，切换只为「链接落点 = 会话工作现场」上下文
 *   一致；项目已不存在不拦截打开（session id 全局可寻址，见 utils/sessionDeepLink
 *   模块头注释的语义辨析）
 *
 * 弹层状态收口为模块单例：宿主组件 SessionReplayDeepLinkHost 在 Layout 挂载
 * 一次负责渲染；实例切换 = Layout 重挂载，宿主 onBeforeUnmount 收口弹层
 * （防旧实例会话 id 打新实例数据面），挂起未消费的 pending 不清——URL 重捕获接力。
 */
const pending = ref<{ session: string; turn?: number; project: string } | null>(null)
const replaySession = ref<ClaudeSessionInfo | null>(null)
/** 定位目标条目（0-based，jumpToIndex 参照系）；-1 = 只开会话不定位 */
const replayTurn = ref(-1)
let ready = false

// 首个宿主 setup 时捕获的上下文（router/t/message 依赖组件注入环境，模块层
// 不能直接取——useFileDeepLink 的离散 message 同款考量的变体）：消费链从此
// 在宿主生命周期之外照常工作（shell flush / 解锁 watcher）
let ctx: {
  router: Router
  t: Composer['t']
  message: MessageApi
} | null = null

/** 消费挂起深链：清 query（防刷新重复消费）→ 切归属项目 → 解析会话 → 开弹层 */
async function consumePendingSessionQuery(): Promise<void> {
  const p = pending.value
  if (!p || !ctx) return
  pending.value = null
  if (ctx.router.currentRoute.value.query.session !== undefined) {
    void ctx.router.replace({ path: '/project' })
  }
  await openDeepLinkedSession(p)
}

/** 解析会话并开弹层。深链只带 id，回放弹层还需要 title/cwd/active——active
 *  守卫「继续此会话」入口（防双进程写同一对话），不能拿骨架对象空开：经会话
 *  列表 q 搜索解析（id 行级子串命中，server/claudesessions.List q 语义），
 *  找不到/读取失败如实 toast 降级，不静默也不开空弹层 */
async function openDeepLinkedSession(p: { session: string; turn?: number; project: string }) {
  if (!ctx) return
  const { t, message } = ctx
  const projectStore = useProjectStore()
  if (p.project && p.project !== projectStore.currentProjectId &&
      projectStore.projects.some(pr => pr.id === p.project)) {
    projectStore.selectProject(p.project)
  }
  let info: ClaudeSessionInfo | null
  try {
    const res = (await claudeApi.sessions({ q: p.session, limit: 200 })) as unknown as {
      data?: { sessions?: ClaudeSessionInfo[] }
    }
    info = res?.data?.sessions?.find(s => s.id === p.session) ?? null
  } catch {
    message.error(t('claudeSessions.deepLink.loadFail'))
    return
  }
  if (!info) {
    message.warning(t('claudeSessions.deepLink.notFound'))
    return
  }
  // turn（1 计）→ 0-based 索引；缺省 -1 = 不定位（回放自然停在顶部首屏）。
  // 目标越界（会话被截断/收缩）不在此拒：jumpToIndex 钳到尾条保底可打开
  replayTurn.value = p.turn !== undefined ? p.turn - 1 : -1
  replaySession.value = info
}

/** bootstrap 完成（uiState 项目/标签恢复落定）后由 useLayoutShell 调用：消费挂起深链 */
export function flushSessionReplayDeepLink(): Promise<void> {
  ready = true
  // 锁定态消费必败（API 全被 423 拒）：保持挂起与 query 原样，等解锁 watcher
  // 接力（文件深链 flushFileDeepLink 同款守卫）
  if (useLockStore().isLocked) return Promise.resolve()
  return consumePendingSessionQuery()
}

/** 收口弹层（宿主关闭/卸载时调用）：pending 不清——未消费的深链靠 URL 重捕获 */
export function closeReplayDeepLink() {
  replaySession.value = null
  replayTurn.value = -1
}

/** 宿主组件（SessionReplayDeepLinkHost）setup 调用：注册 query 捕获与解锁接力
 *  watcher（组件作用域，随宿主卸载自动摘除），返回弹层渲染状态 */
export function useSessionReplayDeepLink() {
  const route = useRoute()
  const router = useRouter()
  const { t } = useI18n()
  if (!ctx) {
    // 离散 message（useFileDeepLink 同范式）：消费链在宿主组件生命周期之外的
    // 时机发提示（shell flush / 解锁 watcher），不依赖祖先 NMessageProvider
    const themeStore = useThemeStore()
    ctx = {
      router,
      t,
      message: createDiscreteApi(['message'], {
        configProviderProps: computed(() => ({
          theme: themeStore.naiveTheme,
          themeOverrides: themeStore.naiveOverrides,
        })),
      }).message,
    }
  }

  function consumeSessionQuery() {
    const session = route.query.session
    if (typeof session !== 'string' || !session) return
    const project = typeof route.query.project === 'string' ? route.query.project : ''
    // 只捕获不清 query（文件深链 consumeFileQuery 同款）：锁定/bootstrap 未就绪
    // 时挂起，实例切换 remount 后新宿主仍能从 URL 重新捕获
    pending.value = { session, project, turn: turnParam(route.query.turn) }
    if (!ready || useLockStore().isLocked) return
    // 已就绪（SPA 内再入 router.push 而来）：捕获后即时消费
    void consumePendingSessionQuery()
  }
  watch(() => route.query.session, consumeSessionQuery, { immediate: true })

  // 解锁接力：锁定期间到达的深链在解锁后消费（query 未清，URL 仍是完整深链）
  watch(() => useLockStore().isLocked, (locked) => {
    if (locked || !ready) return
    void consumePendingSessionQuery()
  })

  return { replaySession, replayTurn }
}
