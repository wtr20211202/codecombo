<script setup lang="ts">
// 通知设置分区：嵌入 SettingsModal，复用 store 的偏好与 updatePrefs
// - 每类开关走 prefs.enabled
// - 长任务阈值滑块（1-60 秒）映射 prefs.longTaskThresholdMs
// - 长会话完成提醒阈值滑块（1-120 分钟）映射 prefs.longSessionNotifySec（P-20261002-140）
// - 会话花费阈值告警（P-20261003-157）：开关 + tokens 数值输入映射
//   prefs.claudeSpendAlertTokens（0 = 关默认；命中入账通知中心，每会话一次）
// - 桌面通知开关 + 权限请求/状态显示
// - 桌面通知精简模式开关（P-20261003-90）：仅显「新通知」不携 title/body 明细
//   （localStorage 偏好，语义同免打扰/音效——确认保存时才落地）
// - 等待音效开关（P-20261003-33）：审批/提问卡到达提示音（localStorage 偏好）
// - 外部推送段（P-20261002-31）：webhook 偏好 + 测试推送（Bark/ntfy/自定义）
// - 项目静音管理（P-20261003-168）：项目×类别二维静音清单的查看与解除
//   （条目快捷静音的清单在此管理，随「保存」一并提交）
import { computed, ref, watch } from 'vue'
import { NCheckbox, NButton, NInput, NInputNumber, NSelect } from 'naive-ui'
import { useNotificationStore } from '../../stores/notification'
import { useProjectStore } from '../../stores/project'
import { useDndStore } from '../../stores/dnd'
import { useSoundStore } from '../../stores/sound'
import { useNotifySimpleStore } from '../../stores/notifySimple'
import { useNotifyScrollReadStore } from '../../stores/notifyScrollRead'
import { useI18n } from '../../composables/useI18n'
import { useDesktopNotify } from '../../composables/useDesktopNotify'
import { notificationApi, type NotificationPrefs, type WebhookPrefs } from '../../api/client'
import { DND_DEFAULTS } from '../../stores/dnd'
import { DND_EXCEPTION_DEFAULTS, type DndWindow } from '../../utils/dndSchedule'
import SettingModifiedMark from './SettingModifiedMark.vue'

const store = useNotificationStore()
const projectStore = useProjectStore()
const dndStore = useDndStore()
const soundStore = useSoundStore()
const simpleStore = useNotifySimpleStore()
const scrollReadStore = useNotifyScrollReadStore()
const { t } = useI18n()
const { requestPermission } = useDesktopNotify()

// 行级「已修改」标记（P-20261003-171，P-20261006-49 分区补全）的出厂默认：
// 镜像服务端 notification.DefaultPrefs（server/notification/types.go，GET 空值
// 回落同口径）+ 四个设备本地 store 的缺省档。全分区是本地编辑副本（暂存行）
// ——恢复钮只复位 pending 值，仍走「保存」链落盘，isDirty 护栏语义不变；
// 项目静音清单默认空集，非空即「已修改」，恢复=整表清空（未保存前可反悔）
const NOTIF_DEFAULTS = {
  categoryEnabled: true,
  longTaskThresholdSec: 5,
  longSessionMinutes: 5,
  spendAlertTokens: 0,
  desktopNotify: true,
  sound: true,
  simple: false,
  scrollRead: false,
} as const
// webhook 段默认（服务端 DefaultPrefs.Webhook 同值）：副本行整段对比+整段恢复
const NOTIF_WEBHOOK_DEFAULTS: WebhookPrefs = { enabled: false, mode: 'post', url: '', scope: 'important' }
// 免打扰段默认（stores/dnd.ts DND_DEFAULTS 导出常量 + 例外类别出厂档）
const NOTIF_DND_DEFAULTS: DndWindow = { ...DND_DEFAULTS, except: [...DND_EXCEPTION_DEFAULTS] }

// webhook 段防御性兜底：旧后端响应缺 webhook 字段时绑定不炸（正常路径后端
// 始终回传该字段，此处仅对半升级环境兜底）；projectMutes 同口径归一为数组
//（存量偏好无该字段 → undefined，管理列表按空清单渲染）
function withWebhookDefaults(p: NotificationPrefs): NotificationPrefs {
  return {
    ...p,
    webhook: { ...NOTIF_WEBHOOK_DEFAULTS, ...p.webhook },
    // 会话花费阈值（P-20261003-157）：旧后端响应缺该字段时按关兜底（0）
    claudeSpendAlertTokens: p.claudeSpendAlertTokens ?? 0,
    projectMutes: p.projectMutes ?? [],
  }
}

// 本地编辑副本（确认保存时才同步到 store）
const localPrefs = ref(withWebhookDefaults(JSON.parse(JSON.stringify(store.prefs))))
const desktopPermission = ref<NotificationPermission | 'unsupported'>(
  typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
)

watch(() => store.prefs, (newPrefs) => {
  localPrefs.value = withWebhookDefaults(JSON.parse(JSON.stringify(newPrefs)))
}, { deep: true })

// 免打扰时段（P-20261002-40）：本地编辑副本语义与 prefs 段一致——确认保存时
// 才经 dndStore.set 落地（localStorage）
const localDnd = ref<DndWindow>(JSON.parse(JSON.stringify(dndStore.prefs)))

watch(() => dndStore.prefs, (p) => {
  localDnd.value = JSON.parse(JSON.stringify(p))
}, { deep: true })

// 等待音效开关（P-20261003-33）：本地编辑副本语义与免打扰一致——确认保存时
// 才经 soundStore.set 落地（localStorage，默认开）
const localSound = ref(soundStore.enabled)

watch(() => soundStore.enabled, (v) => {
  localSound.value = v
})

// 桌面通知精简模式（P-20261003-90）：本地编辑副本语义与免打扰/音效一致——
// 确认保存时才经 simpleStore.set 落地（localStorage，默认关=完整内容）
const localSimple = ref(simpleStore.enabled)

watch(() => simpleStore.enabled, (v) => {
  localSimple.value = v
})

// 滚动自动已读（P-20261003-260）：本地编辑副本语义同上——确认保存时才经
// scrollReadStore.set 落地（localStorage，默认关=滚过不清未读）
const localScrollRead = ref(scrollReadStore.enabled)

watch(() => scrollReadStore.enabled, (v) => {
  localScrollRead.value = v
})

const categories = computed(() => [
  { key: 'git', label: t('settings.notifCategoryGit') },
  { key: 'task', label: t('settings.notifCategoryTask') },
  { key: 'clone', label: t('settings.notifCategoryClone') },
  { key: 'system', label: t('settings.notifCategorySystem') },
  { key: 'error', label: t('settings.notifCategoryError') },
  { key: 'drop', label: t('settings.notifCategoryDrop') },
])

// 项目静音管理（P-20261003-168）：类别显示名复用上方类别清单（未登记类别
// 原样展示）；项目显示名从项目 store 解析，已删项目/清单未加载回落原始 id
// ——静音项不因项目消失而不可解除
const projectMutes = computed(() => localPrefs.value.projectMutes ?? [])
function categoryLabel(category: string): string {
  return categories.value.find(c => c.key === category)?.label ?? category
}
function projectDisplayName(projectId: string): string {
  return projectStore.projects.find(p => p.id === projectId)?.name || projectId
}
function removeMute(index: number) {
  localPrefs.value.projectMutes = projectMutes.value.filter((_, i) => i !== index)
}

// webhook / 免打扰段的「已修改」判定：段内任一字段偏离出厂默认即整段出标记
// （恢复钮同段整段复位——启用开关+字段都在段内，逐字段挂标记反而琐碎）
const webhookModified = computed(() => {
  const w = localPrefs.value.webhook
  return w.enabled !== NOTIF_WEBHOOK_DEFAULTS.enabled
    || w.mode !== NOTIF_WEBHOOK_DEFAULTS.mode
    || w.scope !== NOTIF_WEBHOOK_DEFAULTS.scope
    || w.url !== NOTIF_WEBHOOK_DEFAULTS.url
})
const dndModified = computed(() => {
  const d = localDnd.value
  return d.enabled !== NOTIF_DND_DEFAULTS.enabled
    || d.start !== NOTIF_DND_DEFAULTS.start
    || d.end !== NOTIF_DND_DEFAULTS.end
    || (d.except ?? []).join(',') !== (NOTIF_DND_DEFAULTS.except ?? []).join(',')
    || (d.exceptError ?? true) !== NOTIF_DND_DEFAULTS.exceptError
})

// 免打扰例外类别多选（P-20261003-115）：复用上方类别清单，追加 approval
//（审批卡不进通知中心，走卡片堆 + 等待音效通道，此处作为独立提醒类别纳管；
// key 与 utils/dndSchedule.ts 的 DND_EXCEPTION_CATEGORIES 全集一致）
const dndExceptionOptions = computed(() => [
  ...categories.value,
  { key: 'approval', label: t('settings.notifCategoryApproval') },
].map(c => ({ label: c.label, value: c.key })))

// 阈值滑块用秒单位显示，存储用毫秒
const thresholdSeconds = computed({
  get: () => Math.round(localPrefs.value.longTaskThresholdMs / 1000),
  set: (v: number) => { localPrefs.value.longTaskThresholdMs = v * 1000 },
})

// 长会话完成提醒阈值（P-20261002-140）：滑块用分钟显示（1-120），存储用秒。
// `|| 300` 对半升级环境兜底（旧后端响应缺该字段时绑定为默认 5 分钟）
const longSessionMinutes = computed({
  get: () => Math.max(1, Math.round((localPrefs.value.longSessionNotifySec || 300) / 60)),
  set: (v: number) => { localPrefs.value.longSessionNotifySec = v * 60 },
})

// 会话花费阈值告警（P-20261003-157）：0 = 关（默认）。开关联动数值——开启时
// 预置 100 万 tokens 起步值（P-20261002-139 口径含逐轮 input/cache_read，正常
// 会话累计百万级起步，更低只产生噪声）；关闭即归零。下限 10 万与服务端
// ClampSpendTokens 写入端边界一致（GET 回读即合法值，前端只做输入体验约束）
const SPEND_ALERT_DEFAULT_ON = 1_000_000
const spendAlertEnabled = computed({
  get: () => (localPrefs.value.claudeSpendAlertTokens ?? 0) > 0,
  set: (v: boolean) => { localPrefs.value.claudeSpendAlertTokens = v ? SPEND_ALERT_DEFAULT_ON : 0 },
})

async function grantPermission() {
  const ok = await requestPermission()
  desktopPermission.value = ok ? 'granted' : (typeof Notification !== 'undefined' ? Notification.permission : 'unsupported')
  if (ok) localPrefs.value.desktopNotify = true
}

// 发送测试通知：真实走一遍「通知中心条目 + 桌面系统通知」双链路，
// 让用户在配置页即可确认端到端可用（useDesktopNotify 的语义）
async function sendTestNotification() {
  // 失败路径补全（P-20261002-100）：点击时懒检查权限——设置页开着的间隙里
  // 权限可能在站点设置被撤销，快照过期会让 notify() 静默失败（通知中心有账、
  // 桌面无弹窗，学费全无）。重读后被拒 → ref 切 denied，引导提示行接管
  recheckPermission()
  if (desktopPermission.value !== 'granted') return
  const title = t('settings.notifDesktopTestTitle')
  await store.add({ type: 'info', category: 'system', title, body: t('settings.notifDesktopTestBody') })
  const { notify } = useDesktopNotify()
  notify(title, t('settings.notifDesktopTestBody'), 'system')
}

// 权限被拒引导链接（P-20261002-100）：chrome://settings/content/notifications
// 无法从页面直接打开（浏览器禁止导航 chrome:// scheme），退而指向 Chrome 官方
// 帮助的站点通知设置文档；文案走 i18n（notify.permission.guideLink）
const PERMISSION_GUIDE_URL = 'https://support.google.com/chrome/answer/3220216'

// 权限被拒后在浏览器站点设置开启的场景：Chrome 对源权限即时生效，
// 重新读取即可恢复（granted 时同样联动桌面开关意向）
function recheckPermission() {
  desktopPermission.value = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
  if (desktopPermission.value === 'granted') localPrefs.value.desktopNotify = true
}

// ============== 外部推送（webhook） ==============

const webhookModeOptions = computed(() => [
  { label: t('notify.webhook.modePost'), value: 'post' },
  { label: t('notify.webhook.modeGet'), value: 'get' },
])
const webhookScopeOptions = computed(() => [
  { label: t('notify.webhook.scopeImportant'), value: 'important' },
  { label: t('notify.webhook.scopeAll'), value: 'all' },
])

// 测试推送（复用桌面测试通知的交互模式）：先保存当前编辑（测试端点走已保存
// 偏好，保存即生效），再同步外发；结果内联展示（成功/失败原因）
const webhookTesting = ref(false)
const webhookTestResult = ref<{ ok: boolean; msg: string } | null>(null)

async function sendTestWebhook() {
  webhookTesting.value = true
  webhookTestResult.value = null
  try {
    await store.updatePrefs(localPrefs.value)
    await (notificationApi.testWebhook() as Promise<unknown>)
    webhookTestResult.value = { ok: true, msg: t('notify.webhook.testOk') }
  } catch (e) {
    const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error || String(e)
    webhookTestResult.value = { ok: false, msg: t('notify.webhook.testFail', { msg }) }
  } finally {
    webhookTesting.value = false
  }
}

// 父组件 SettingsModal 保存时调
async function save() {
  // 若用户关闭桌面通知开关，无需降级权限
  await store.updatePrefs(localPrefs.value)
  // 免打扰时段与通知偏好同一保存时机（modal 确认保存才生效）
  dndStore.set(localDnd.value)
  // 等待音效开关同一保存时机（P-20261003-33）
  soundStore.set(localSound.value)
  // 桌面通知精简模式同一保存时机（P-20261003-90）
  simpleStore.set(localSimple.value)
  // 滚动自动已读开关同一保存时机（P-20261003-260）
  scrollReadStore.set(localScrollRead.value)
}

// 关闭护栏：本地编辑副本相对 store 偏离即视为未保存（grantPermission 置位的
// desktopNotify 也算——它只是本地意向，未走 updatePrefs）；免打扰时段与等待
// 音效开关同口径
function isDirty(): boolean {
  return JSON.stringify(localPrefs.value) !== JSON.stringify(store.prefs)
    || JSON.stringify(localDnd.value) !== JSON.stringify(dndStore.prefs)
    || localSound.value !== soundStore.enabled
    || localSimple.value !== simpleStore.enabled
    || localScrollRead.value !== scrollReadStore.enabled
}

defineExpose({ save, isDirty })
</script>

<template>
  <div class="notif-settings">
    <h3 class="pane-title">
      {{ t('settings.notifTitle') }}
    </h3>

    <!-- 分类开关 -->
    <div class="form-group">
      <div class="form-label">
        {{ t('settings.notifCategoryTitle') }}
      </div>
      <label
        v-for="cat in categories"
        :key="cat.key"
        class="setting-row"
      >
        <n-checkbox
          :checked="!!localPrefs.enabled[cat.key]"
          size="small"
          @update:checked="(v: boolean) => localPrefs.enabled[cat.key] = v"
        />
        <span class="setting-meta">{{ cat.label }}</span>
        <SettingModifiedMark
          :modified="localPrefs.enabled[cat.key] !== NOTIF_DEFAULTS.categoryEnabled"
          @restore="localPrefs.enabled[cat.key] = NOTIF_DEFAULTS.categoryEnabled"
        />
      </label>
    </div>

    <!-- 项目静音管理（P-20261003-168）：条目快捷「静音此项目此类」的清单
         与解除入口——二维组合（项目×类别）不再产生通知，解除随「保存」生效。
         非空清单即「已修改」（默认空集），恢复钮整表清空（仍随「保存」生效） -->
    <div
      class="form-group"
      data-testid="settings-project-mutes"
    >
      <div class="form-label form-label-with-mark">
        <span>{{ t('settings.projectMute.title') }}</span>
        <SettingModifiedMark
          :modified="projectMutes.length > 0"
          @restore="localPrefs.projectMutes = []"
        />
      </div>
      <div
        v-if="projectMutes.length === 0"
        class="form-hint"
      >
        {{ t('settings.projectMute.empty') }}
      </div>
      <div
        v-for="(m, i) in projectMutes"
        :key="`${m.projectId}:${m.category}`"
        class="mute-row"
      >
        <span class="mute-project">{{ projectDisplayName(m.projectId) }}</span>
        <span class="mute-sep">·</span>
        <span class="mute-category">{{ categoryLabel(m.category) }}</span>
        <n-button
          size="tiny"
          quaternary
          class="mute-remove"
          data-testid="settings-project-mute-remove"
          :title="t('settings.projectMute.remove')"
          @click="removeMute(i)"
        >
          {{ t('settings.projectMute.remove') }}
        </n-button>
      </div>
      <div class="form-hint">
        {{ t('settings.projectMute.hint') }}
      </div>
    </div>

    <!-- 长任务阈值 -->
    <div class="form-group">
      <div class="form-label-row">
        <span>{{ t('settings.notifThreshold') }}</span>
        <div class="form-label-row-end">
          <span class="slider-value">{{ thresholdSeconds }}s</span>
          <SettingModifiedMark
            :modified="thresholdSeconds !== NOTIF_DEFAULTS.longTaskThresholdSec"
            @restore="localPrefs.longTaskThresholdMs = NOTIF_DEFAULTS.longTaskThresholdSec * 1000"
          />
        </div>
      </div>
      <input
        v-model.number="thresholdSeconds"
        type="range"
        min="1"
        max="60"
        step="1"
        class="font-slider"
      >
      <div class="form-hint">
        {{ t('settings.notifThresholdDesc') }}
      </div>
    </div>

    <!-- 长会话完成提醒阈值（P-20261002-140）：agent 会话运行超过该时长后正常
         退出时发完成知情；纯 shell 会话不打扰、智能体已上报终态的不重复提醒
         （去重在服务端退出钩子内完成） -->
    <div class="form-group">
      <div class="form-label-row">
        <span>{{ t('notify.longSession.settingsLabel') }}</span>
        <div class="form-label-row-end">
          <span class="slider-value">{{ t('notify.longSession.minutesValue', { n: longSessionMinutes }) }}</span>
          <SettingModifiedMark
            :modified="longSessionMinutes !== NOTIF_DEFAULTS.longSessionMinutes"
            @restore="localPrefs.longSessionNotifySec = NOTIF_DEFAULTS.longSessionMinutes * 60"
          />
        </div>
      </div>
      <input
        v-model.number="longSessionMinutes"
        type="range"
        min="1"
        max="120"
        step="1"
        class="font-slider"
      >
      <div class="form-hint">
        {{ t('notify.longSession.settingsDesc') }}
      </div>
    </div>

    <!-- 会话花费阈值告警（P-20261003-157）：Claude 会话累计 token 达到阈值时
         通知一次（该收尾或接力了）；默认关。数值输入随开关展开，0 = 关由
         开关联动维护（服务端写入端再钳制兜底） -->
    <div
      class="form-group"
      data-testid="settings-spend-alert"
    >
      <label class="setting-row">
        <n-checkbox
          :checked="spendAlertEnabled"
          size="small"
          data-testid="settings-spend-alert-enable"
          @update:checked="(v: boolean) => spendAlertEnabled = v"
        />
        <div class="setting-meta">
          <div>{{ t('notify.spendAlert.settingsLabel') }}</div>
          <div class="form-hint">{{ t('notify.spendAlert.settingsDesc') }}</div>
        </div>
        <SettingModifiedMark
          :modified="(localPrefs.claudeSpendAlertTokens ?? 0) !== NOTIF_DEFAULTS.spendAlertTokens"
          @restore="localPrefs.claudeSpendAlertTokens = NOTIF_DEFAULTS.spendAlertTokens"
        />
      </label>
      <div
        v-if="spendAlertEnabled"
        class="spend-fields"
      >
        <label class="dnd-time">
          <span>{{ t('notify.spendAlert.tokensLabel') }}</span>
          <n-input-number
            v-model:value="localPrefs.claudeSpendAlertTokens"
            size="small"
            class="spend-input"
            :min="100000"
            :step="100000"
            :show-button="false"
            data-testid="settings-spend-alert-tokens"
          />
        </label>
        <div class="form-hint">
          {{ t('notify.spendAlert.onceNote') }}
        </div>
      </div>
    </div>

    <!-- 桌面通知 -->
    <div class="form-group">
      <label class="setting-row">
        <n-checkbox
          :checked="localPrefs.desktopNotify"
          size="small"
          :disabled="desktopPermission === 'denied' || desktopPermission === 'unsupported'"
          @update:checked="(v: boolean) => localPrefs.desktopNotify = v"
        />
        <div class="setting-meta">
          <div>{{ t('settings.notifDesktop') }}</div>
          <div class="form-hint">{{ t('settings.notifDesktopDesc') }}</div>
        </div>
        <SettingModifiedMark
          :modified="localPrefs.desktopNotify !== NOTIF_DEFAULTS.desktopNotify"
          @restore="localPrefs.desktopNotify = NOTIF_DEFAULTS.desktopNotify"
        />
      </label>

      <!-- 权限状态 / 请求按钮 -->
      <div
        v-if="desktopPermission === 'default'"
        class="permission-row"
      >
        <n-button
          size="tiny"
          @click="grantPermission"
        >
          {{ t('settings.notifDesktopRequest') }}
        </n-button>
      </div>
      <div
        v-else-if="desktopPermission === 'granted'"
        class="permission-status granted"
      >
        ✓ {{ t('settings.notifDesktopGranted') }}
        <n-button
          size="tiny"
          quaternary
          class="permission-recheck"
          @click="sendTestNotification"
        >
          {{ t('settings.notifDesktopTest') }}
        </n-button>
      </div>
      <!-- 权限被拒（P-20261002-100）：黄色提示行带出路——指引链接 + 重检 -->
      <div
        v-else-if="desktopPermission === 'denied'"
        class="permission-status denied-guide"
      >
        <span>⚠ {{ t('notify.permission.deniedHint') }}</span>
        <a
          class="permission-guide"
          :href="PERMISSION_GUIDE_URL"
          target="_blank"
          rel="noopener"
        >{{ t('notify.permission.guideLink') }}</a>
        <n-button
          size="tiny"
          quaternary
          class="permission-recheck"
          @click="recheckPermission"
        >
          {{ t('settings.notifDesktopRecheck') }}
        </n-button>
      </div>
      <div
        v-else
        class="permission-status denied"
      >
        ⚠ {{ t('settings.notifDesktopDenied') }}
        <n-button
          size="tiny"
          quaternary
          class="permission-recheck"
          @click="recheckPermission"
        >
          {{ t('settings.notifDesktopRecheck') }}
        </n-button>
      </div>

      <!-- 桌面通知精简模式（P-20261003-90）：仅随桌面通知开关出现——总开关
           关闭时精简没有作用面；开关后点「发送测试通知」可即时验证泛化效果 -->
      <label
        v-if="localPrefs.desktopNotify"
        class="setting-row simple-row"
      >
        <n-checkbox
          :checked="localSimple"
          size="small"
          @update:checked="(v: boolean) => localSimple = v"
        />
        <div class="setting-meta">
          <div>{{ t('settings.notifSimpleMode') }}</div>
          <div class="form-hint">{{ t('settings.notifSimpleModeDesc') }}</div>
        </div>
        <SettingModifiedMark
          :modified="localSimple !== NOTIF_DEFAULTS.simple"
          @restore="localSimple = NOTIF_DEFAULTS.simple"
        />
      </label>
    </div>

    <!-- 等待音效（P-20261003-33）：审批确认卡/提问卡出现时短提示音——绕过
         视觉通道的注意机制；免打扰时段与锁定期间静默（门控在合成器内串联） -->
    <div
      class="form-group"
      data-testid="settings-notification-sound"
    >
      <label class="setting-row">
        <n-checkbox
          :checked="localSound"
          size="small"
          @update:checked="(v: boolean) => localSound = v"
        />
        <div class="setting-meta">
          <div>{{ t('notification.sound.title') }}</div>
          <div class="form-hint">{{ t('notification.sound.desc') }}</div>
        </div>
        <SettingModifiedMark
          :modified="localSound !== NOTIF_DEFAULTS.sound"
          @restore="localSound = NOTIF_DEFAULTS.sound"
        />
      </label>
    </div>

    <!-- 分轨标注（P-20261007-1）：免打扰时段/等待音效/精简模式随账号漫游；
         下方滚动自动已读是浏览行为档位，保持设备本地不入漫游 -->
    <div
      class="form-group"
      data-testid="settings-notification-sync-track"
    >
      <div class="form-hint">
        {{ t('settings.syncTrackRoaming') }}
      </div>
    </div>

    <!-- 滚动自动已读（P-20261003-260）：浏览通知中心时滚入视野的条目自动
         标已读（Slack「滚过即读」惯例）；默认关——滚过可能只是粗略扫过，
         保守不替用户清未读。与 Shift+A 全部已读/已读分界线互不影响 -->
    <div
      class="form-group"
      data-testid="settings-scroll-read"
    >
      <label class="setting-row">
        <n-checkbox
          :checked="localScrollRead"
          size="small"
          data-testid="settings-scroll-read-enable"
          @update:checked="(v: boolean) => localScrollRead = v"
        />
        <div class="setting-meta">
          <div>{{ t('notification.scrollRead.title') }}</div>
          <div class="form-hint">{{ t('notification.scrollRead.desc') }}</div>
        </div>
        <SettingModifiedMark
          :modified="localScrollRead !== NOTIF_DEFAULTS.scrollRead"
          @restore="localScrollRead = NOTIF_DEFAULTS.scrollRead"
        />
      </label>
    </div>

    <!-- 外部推送（webhook：Bark / ntfy / 自定义接收端） -->
    <div
      class="form-group"
      data-testid="settings-notification-webhook"
    >
      <label class="setting-row">
        <n-checkbox
          :checked="localPrefs.webhook.enabled"
          size="small"
          @update:checked="(v: boolean) => localPrefs.webhook.enabled = v"
        />
        <div class="setting-meta">
          <div>{{ t('notify.webhook.title') }}</div>
          <div class="form-hint">{{ t('notify.webhook.desc') }}</div>
        </div>
        <SettingModifiedMark
          :modified="webhookModified"
          @restore="localPrefs.webhook = { ...NOTIF_WEBHOOK_DEFAULTS }"
        />
      </label>

      <div
        v-if="localPrefs.webhook.enabled"
        class="webhook-fields"
      >
        <div class="webhook-row">
          <n-select
            v-model:value="localPrefs.webhook.mode"
            size="small"
            class="webhook-select"
            :options="webhookModeOptions"
          />
          <n-select
            v-model:value="localPrefs.webhook.scope"
            size="small"
            class="webhook-select webhook-select-wide"
            :options="webhookScopeOptions"
          />
        </div>
        <n-input
          v-model:value="localPrefs.webhook.url"
          size="small"
          :placeholder="t('notify.webhook.urlPlaceholder')"
        />
        <div class="form-hint">
          {{ t('notify.webhook.urlHint') }}
        </div>
        <div class="webhook-row">
          <n-button
            size="tiny"
            :loading="webhookTesting"
            @click="sendTestWebhook"
          >
            {{ t('notify.webhook.test') }}
          </n-button>
          <span
            v-if="webhookTestResult"
            class="permission-status"
            :class="webhookTestResult.ok ? 'granted' : 'denied'"
          >{{ webhookTestResult.msg }}</span>
        </div>
        <!-- 独立取舍注记（P-20261003-90）：外发通道在服务端，不受桌面精简模式约束 -->
        <div class="form-hint">
          {{ t('notify.webhook.privacyNote') }}
        </div>
      </div>
    </div>

    <!-- 免打扰时段（P-20261002-40）：toast/桌面通知静默，通知中心照常入账 -->
    <div
      class="form-group"
      data-testid="settings-notification-dnd"
    >
      <label class="setting-row">
        <n-checkbox
          :checked="localDnd.enabled"
          size="small"
          @update:checked="(v: boolean) => localDnd.enabled = v"
        />
        <div class="setting-meta">
          <div>{{ t('notify.dnd.title') }}</div>
          <div class="form-hint">{{ t('notify.dnd.desc') }}</div>
        </div>
        <SettingModifiedMark
          :modified="dndModified"
          @restore="localDnd = { ...NOTIF_DND_DEFAULTS, except: [...NOTIF_DND_DEFAULTS.except ?? []] }"
        />
      </label>

      <div
        v-if="localDnd.enabled"
        class="dnd-fields"
      >
        <label class="dnd-time">
          <span>{{ t('notify.dnd.start') }}</span>
          <input
            v-model="localDnd.start"
            type="time"
            class="dnd-input"
          >
        </label>
        <span class="dnd-sep">→</span>
        <label class="dnd-time">
          <span>{{ t('notify.dnd.end') }}</span>
          <input
            v-model="localDnd.end"
            type="time"
            class="dnd-input"
          >
        </label>
      </div>

      <!-- 例外类别（P-20261003-115）：命中类别在时段内仍提醒——夜间挂机时
           审批等待不吞。随开关展开，与起止字段同缩进惯例 -->
      <div
        v-if="localDnd.enabled"
        class="dnd-except"
      >
        <div class="dnd-except-label">{{ t('notify.dnd.exceptLabel') }}</div>
        <n-select
          v-model:value="localDnd.except"
          multiple
          size="small"
          :options="dndExceptionOptions"
          :placeholder="t('notify.dnd.exceptPlaceholder')"
          :consistent-menu-width="false"
        />
        <div class="form-hint">
          {{ t('notify.dnd.exceptDesc') }}
        </div>
      </div>

      <!-- error 级穿透开关（P-20261004-117）：勿扰滤的是噪声不是警报——
           type 为 error 的通知（任务失败/哨兵命中/部署失败）时段内仍弹桌面
           通知；关=绝对静默（合法偏好）。随开关展开，行式对齐主开关惯例 -->
      <label
        v-if="localDnd.enabled"
        class="setting-row dnd-error-toggle"
      >
        <n-checkbox
          :checked="localDnd.exceptError !== false"
          size="small"
          @update:checked="(v: boolean) => localDnd.exceptError = v"
        />
        <div class="setting-meta">
          <div>{{ t('notify.dnd.exceptErrorLabel') }}</div>
          <div class="form-hint">{{ t('notify.dnd.exceptErrorDesc') }}</div>
        </div>
      </label>

      <div class="form-hint dnd-note">
        {{ t('notify.dnd.approvalNote') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.notif-settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.pane-title {
  font-size: 13px;
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
  margin-bottom: 14px;
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--border-subtle);
}

.form-group {
  margin-bottom: 18px;
}

.form-label {
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: var(--space-2);
}

/* 挂修改标记的组标题（P-20261006-49）：form-label 是块级，转 flex 让行尾标记
   靠右（mark 自带 margin-left:auto）；组标题文案包 span 保持原字号色 */
.form-label-with-mark {
  display: flex;
  align-items: center;
}

.form-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-2);
  font-size: 12px;
  color: var(--text-dim);
}

/* 滑条值 + 修改标记成组靠右（P-20261006-49）：form-label-row 是 space-between，
   标记若与值平级会被分到中轴把值挤离右缘 */
.form-label-row-end {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.form-hint {
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--text-muted);
  margin-top: var(--space-1);
}

.setting-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
  cursor: pointer;
  font-size: 12px;
}

.setting-meta {
  color: var(--text-body);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.font-slider {
  width: 100%;
  accent-color: var(--brand-accent);
  height: 4px;
}

.slider-value {
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--text-secondary);
  font-family: var(--font-mono);
}

.permission-row {
  margin-top: 6px;
  margin-left: 28px;
}

/* 权限被拒分支的重检按钮：与警示同行右对齐 */
.permission-recheck { margin-left: 6px; }
.permission-status {
  margin-top: 6px;
  margin-left: 28px;
  font-size: var(--fs-meta-min, 11.5px);
  font-family: var(--font-mono);
}

/* 桌面通知精简模式（P-20261003-90）：随总开关缩进与权限状态行同位 */
.simple-row {
  margin-left: 28px;
}

/* 外部推送段：字段随开关缩进与复选框对齐，两个下拉同行排布 */
.webhook-fields {
  margin-top: 6px;
  margin-left: 28px;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.webhook-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.webhook-select {
  width: 140px;
}

.webhook-select-wide {
  flex: 1;
  min-width: 0;
}

/* 测试结果内联在按钮右侧，不继承权限状态的独立行缩进 */
.webhook-row .permission-status {
  margin-left: 0;
  margin-top: 0;
}

.permission-status.granted {
  color: var(--accent-green);
}

.permission-status.denied {
  color: var(--accent-orange);
}

/* 权限被拒引导行（P-20261002-100）：黄色警示 + 指引链接内联跟随（窄面板自然换行） */
.permission-status.denied-guide {
  color: var(--accent-yellow);
}

.permission-guide {
  color: inherit;
  margin-left: 6px;
  text-decoration: underline;
}

/* 会话花费阈值（P-20261003-157）：数值输入随开关缩进与复选框对齐（同 dnd-fields 惯例） */
.spend-fields {
  margin-top: 6px;
  margin-left: 28px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.spend-input {
  width: 160px;
  font-family: var(--font-mono);
}

/* 免打扰时段：起止时间随开关缩进与复选框对齐（同 webhook-fields 惯例） */
.dnd-fields {
  margin-top: 6px;
  margin-left: 28px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.dnd-time {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-body);
}

.dnd-input {
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 2px 6px;
}

.dnd-sep {
  color: var(--text-muted);
  font-size: 12px;
}

/* 例外类别多选（P-20261003-115）：随开关展开，缩进与起止字段同惯例（对齐复选框） */
.dnd-except {
  margin-top: var(--space-2);
  margin-left: 28px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dnd-except-label {
  font-size: 12px;
  color: var(--text-body);
}

/* error 级穿透开关（P-20261004-117）：随开关展开，缩进对齐例外多选（28px） */
.dnd-error-toggle {
  margin-top: var(--space-2);
  margin-left: 28px;
}

/* 审批卡不静默的注明：独立于开关的固定提示行 */
.dnd-note {
  margin-left: 28px;
}

/* 项目静音管理行（P-20261003-168）：项目名 + 类别 + 解除按钮单行排布，
   颜色全走既有主题变量 */
.mute-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 2px 0;
}
.mute-project {
  color: var(--text-body);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mute-sep {
  color: var(--text-muted);
  flex-shrink: 0;
}
.mute-category {
  color: var(--text-secondary);
  flex-shrink: 0;
}
.mute-remove {
  margin-left: auto;
  flex-shrink: 0;
}
</style>
