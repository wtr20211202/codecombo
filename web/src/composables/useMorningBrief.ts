// 开工检查单（P-20261005-219）首页横幅卡的共享封装：拉取 GET /api/morning-brief
//（人机同源——agent 晨间巡检读同一 brief）+ 当日显示纪律（utils/morningBrief
// 纯函数层承载）+ 未推送项一键 push（复用既有推送链 remoteApi.push，服务端
// 解析 tracking 目标；push 后 ahead 缓存经 post-push fetch 失效，重拉 brief 行消失）。
// 拉取失败/源缺席完全静默（不弹错误不打扰）——检查单是提醒面，不是能力面。
import { computed, ref } from 'vue'
import { useMessage } from 'naive-ui'
import { morningBriefApi, type MorningBrief, type MorningUnpushedProject } from '../api/domains/system'
import { remoteApi } from '../api/domains/git'
import {
  briefTodayKey,
  dismissBriefItem,
  readBriefDismissed,
  visibleBriefItems,
  type MorningBriefItemKey,
} from '../utils/morningBrief'
import { useI18n } from './useI18n'

export function useMorningBrief() {
  const { t } = useI18n()
  const message = useMessage()

  const brief = ref<MorningBrief | null>(null)
  // 当日已阅清单（组件内状态，写操作同步 utils 纯函数层落 safeStorage）
  const dismissed = ref<string[]>([])
  const loading = ref(false)
  // 逐项目 push 进行态（键=projectId）：行内按钮 loading + 防重入
  const pushing = ref<Record<string, boolean>>({})

  const visibleItems = computed(() => visibleBriefItems(brief.value, dismissed.value))
  const showCard = computed(() => visibleItems.value.length > 0)

  /** load 拉取晨报并读当日已阅态。静默失败：brief 保持 null = 不渲染。
   *  服务端 date 仅随载荷透传（横幅卡用本地日期做当日键，见 utils 头注） */
  async function load() {
    if (loading.value) return
    loading.value = true
    try {
      const res = await morningBriefApi.get()
      brief.value = res?.data ?? null
      dismissed.value = readBriefDismissed(briefTodayKey())
    } catch {
      // 晨报不可达 = 检查单缺席（零打扰），不打扰
    } finally {
      loading.value = false
    }
  }

  function syncDismissed() {
    dismissed.value = readBriefDismissed(briefTodayKey())
  }

  /** dismissToday 整卡「已阅」：当日不再显示（未处置项还在通知中心/面板可达） */
  function dismissToday() {
    dismissBriefItem(briefTodayKey(), 'all')
    syncDismissed()
  }

  /** dismissItemToday 单项「今天不再提醒」：其余项照常提醒 */
  function dismissItemToday(key: MorningBriefItemKey) {
    dismissBriefItem(briefTodayKey(), key)
    syncDismissed()
  }

  /** pushProject 未推送项一键 push（复用既有推送链）：成功 toast + 重拉晨报
   *  （ahead 归零该行消失）；失败拦截器已弹友好提示（含 git 失败恢复 hint 直达），
   *  这里静默不叠加。remote/branch 缺省 = 服务端按 tracking 解析推送目标 */
  async function pushProject(p: MorningUnpushedProject) {
    if (pushing.value[p.id]) return
    pushing.value = { ...pushing.value, [p.id]: true }
    try {
      await remoteApi.push(p.id)
      message.success(t('morningBrief.pushDone', { name: p.name }))
      await load()
    } catch {
      // 拦截器已提示（网络/凭据/non-fast-forward 各有本地化文案与直达）
    } finally {
      pushing.value = { ...pushing.value, [p.id]: false }
    }
  }

  return {
    brief,
    visibleItems,
    showCard,
    loading,
    pushing,
    load,
    dismissToday,
    dismissItemToday,
    pushProject,
  }
}
