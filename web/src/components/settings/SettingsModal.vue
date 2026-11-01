<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { NModal, NButton, NIcon, NInput, useMessage, useDialog } from 'naive-ui'
import { SettingsOutline, SearchOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { safeStorage } from '../../utils/storage'
import {
  SETTINGS_TAB_KEYS, SETTINGS_TAB_LABEL_KEYS, SETTINGS_TAB_ICONS,
  type SettingsTabKey,
} from '../../utils/settingsSearch'
// 分区搜索过滤 + 行级锚定逻辑（P-20261003-301 自本组件抽出，含 P-20261003-220
// 拼音首字母分支）：宿主只持搜索框与内容滚动容器
import { useSettingsSearch } from '../../composables/useSettingsSearch'
import NotificationSettings from './NotificationSettings.vue'
import AppearanceSettings from './AppearanceSettings.vue'
import TerminalSettings from './TerminalSettings.vue'
import GitSettings from './GitSettings.vue'
import RemoteSettings from './RemoteSettings.vue'
import SecuritySettings from './SecuritySettings.vue'
// 换机迁移（P-20261003-147）：.scpkg 导出/导入双向向导，即时操作分区
import MigrationSettings from './MigrationSettings.vue'
// 通用/关于分区子组件（P-20261003-265 拆分第四批收尾）：容器只保留分区编排 +
// 关闭护栏 + 保存链，分区内部状态与数据加载随组件迁移
import GeneralSettings from './GeneralSettings.vue'
import AboutSettings from './AboutSettings.vue'
// 即时生效五分区（P-20261003-301 按域拆出）：定时任务/输出哨兵/远程部署/系统监控/
// 快捷键，无暂存无保存按钮，合并渲染减少弹窗装配面
import SettingsInstantPanes from './SettingsInstantPanes.vue'
import { OPEN_SETTINGS_EVENT } from '../../utils/openSettings'

// 分区键与标题/关键词词条统一收敛在 settingsSearch.ts（命令面板直达命令共用同一张表）。
// 分区承载自 P-20261003-301 起按域拆分：通用/关于 → GeneralSettings/AboutSettings，
// 即时生效五分区 → SettingsInstantPanes；带保存/脏护栏契约（save/isDirty）的分区
// 留在本组件直接持有引用。
type Tab = SettingsTabKey

const props = defineProps<{
  show: boolean
  /** 初始展示的 tab，每次 modal 打开时若指定则切到该 tab */
  initialTab?: Tab
}>()
const emit = defineEmits<{
  (e: 'update:show', val: boolean): void
  (e: 'saved'): void
}>()

const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()

// === 记住上次分区（P-20261002-35）：重开设置回到离开时的分区（VS Code/JetBrains 惯例）。
// 挂载时经 safeStorage 恢复为初始值（隐私模式降级为会话内生效，绝不抛错），存储值
// 对分区表校验——分区改名/删除后的残留值回落 general；打开时的外部直达（initialTab
// prop、OPEN_SETTINGS_EVENT 直达命令）另行覆盖，优先级始终高于记忆 ===
const LAST_TAB_KEY = 'sc.settings.lastTab'

function recallLastTab(): Tab {
  const v = safeStorage.getItem(LAST_TAB_KEY)
  return SETTINGS_TAB_KEYS.includes(v as SettingsTabKey) ? (v as Tab) : 'general'
}

const activeTab = ref<Tab>(recallLastTab())
watch(activeTab, (v) => { safeStorage.setItem(LAST_TAB_KEY, v) })

// 分区表（键序/标题/图标）从 settingsSearch.ts 单一来源派生：新增分区只改共享表
// 与 locale 词条，左栏、搜索关键词、命令面板直达命令自动同步
const tabs = computed(() =>
  SETTINGS_TAB_KEYS.map(key => ({
    key,
    label: t(SETTINGS_TAB_LABEL_KEYS[key]),
    icon: SETTINGS_TAB_ICONS[key],
  })),
)

// 需要点底部"保存"才提交的 tab；security/remote/deploy/about 为即时操作或纯展示，不显示保存按钮
const SAVE_TABS: Tab[] = ['general', 'git', 'appearance', 'terminal', 'notifications']
const needsSave = computed(() => SAVE_TABS.includes(activeTab.value))

// === 分区搜索过滤（P-20261001-9）+ 行级锚定（P-20261003-39）+ 拼音首字母
// （P-20261003-220）：逻辑在 useSettingsSearch，此处只接线 ===
const contentRef = ref<HTMLElement>()
const { searchQuery, searchActive, visibleTabs, clearAnchorFlash, revealAnchor } = useSettingsSearch({
  tabs,
  activeTab,
  contentRef,
})

// === 子组件引用 ===
const generalRef = ref<InstanceType<typeof GeneralSettings> | null>(null)
const appearanceRef = ref<InstanceType<typeof AppearanceSettings> | null>(null)
const terminalRef = ref<InstanceType<typeof TerminalSettings> | null>(null)
const gitRef = ref<InstanceType<typeof GitSettings> | null>(null)
const remoteRef = ref<InstanceType<typeof RemoteSettings> | null>(null)
const securityRef = ref<InstanceType<typeof SecuritySettings> | null>(null)
const notificationRef = ref<InstanceType<typeof NotificationSettings> | null>(null)

// 各分区均为 v-show 常驻挂载，模板引用可直接读；isDirty 用可选调用兼容时序
function anyDirty(): boolean {
  return !!generalRef.value?.isDirty?.()
    || !!appearanceRef.value?.isDirty?.()
    || !!terminalRef.value?.isDirty?.()
    || !!gitRef.value?.isDirty?.()
    || !!notificationRef.value?.isDirty?.()
}

function requestClose() {
  if (!anyDirty()) {
    emit('update:show', false)
    return
  }
  dialog.warning({
    title: t('settings.unsavedTitle'),
    content: t('settings.unsavedContent'),
    positiveText: t('settings.unsavedDiscard'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => { emit('update:show', false) },
  })
}

// n-modal 的 Esc 关闭与 × / 底部关闭同走护栏：脏时拦下不外传，确认丢弃才放行
function onShowChange(v: boolean) {
  if (v || !anyDirty()) {
    emit('update:show', v)
    return
  }
  requestClose()
}

const saving = ref(false)

async function handleSave() {
  if (saving.value) return
  saving.value = true
  try {
    // 通用分区先行（基础设置失败则不打扰各子分区保存，错误信息带明细）
    await generalRef.value?.save()
    await gitRef.value?.save()
    // 各 tab 的 save 必须全部等完成再关弹窗：主题/外观保存是后台 PUT，
    // 曾因 fire-and-forget 出现「弹窗已关、保存未落地/失败无感知」的竞态
    const results = await Promise.allSettled([
      appearanceRef.value?.save(),
      terminalRef.value?.save(),
      notificationRef.value ? notificationRef.value.save() : Promise.resolve(),
    ])
    const failed = results.filter(r => r.status === 'rejected').length
    if (failed > 0) {
      // 保存失败必须可见：静默吞掉会让用户误以为已保存
      message.error(t('layout.settingsSaveFailed', { n: failed }))
      return
    }
    message.success(t('layout.settingsSaved'))
    emit('saved')
    emit('update:show', false)
  } catch (e: any) {
    // 基础设置或 Git 设置保存失败：不再静默，明确反馈并保持弹窗打开
    const detail = e?.userMessage || e?.message
    message.error(`${t('layout.settingsSaveFailed', { n: 1 })}${detail ? ': ' + detail : ''}`)
  } finally {
    saving.value = false
  }
}

// 关闭后焦点归还触发按钮：打开瞬间记录 document.activeElement（多为顶栏齿轮/
// 命令面板项），关闭时若仍在文档中则还焦——键盘用户不再被丢回 body 重新 Tab
let opener: HTMLElement | null = null
watch(() => props.show, (val) => {
  if (val) {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // 每次打开重置搜索过滤：上次会话的词条不应决定本次能看到哪些分区
    searchQuery.value = ''
    // 指定初始 tab 时切换到目标 tab；否则保留当前分区（挂载时已恢复上次分区，
    // 外部直达 OPEN_SETTINGS_EVENT 先于/伴随 show 置位时也已直接切好）
    if (props.initialTab) {
      activeTab.value = props.initialTab
    }
    // 各分区数据由子组件按 :show 自加载（SecuritySettings 同款约定），容器不再代拉
  } else if (opener) {
    clearAnchorFlash()
    if (opener.isConnected) opener.focus()
    opener = null
  }
})

// Ctrl/Cmd+S 在设置弹窗内触发保存：编辑器 Ctrl+S 肌肉记忆的自然延伸——
// 保存型页签且有改动时执行 handleSave，浏览器「保存网页」默认行为始终阻止
function onCardKeydown(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault()
    if (needsSave.value && !saving.value) void handleSave()
  }
}

// 左侧导航 ↑↓ 直接切换分区（环绕，仅在可见分区间），焦点跟随到对应项——与命令面板/通知中心
// 的键盘导航惯例一致；Enter/Space 走按钮原生 click，不在此处理
const navRef = ref<HTMLElement>()
function onNavKeydown(e: KeyboardEvent): void {
  // 顶部搜索框内 ↑↓ 是移动光标，不是切分区
  if (e.target instanceof HTMLInputElement) return
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  e.preventDefault()
  const list = visibleTabs.value
  if (list.length === 0) return
  const idx = list.findIndex(tb => tb.key === activeTab.value)
  const delta = e.key === 'ArrowDown' ? 1 : -1
  const next = list[(idx + delta + list.length) % list.length]
  if (!next) return
  activeTab.value = next.key
  void nextTick(() => {
    const btns = navRef.value?.querySelectorAll<HTMLButtonElement>('.nav-item')
    const i = list.findIndex(tb => tb.key === next.key)
    btns?.[i]?.focus()
  })
}

// 深层组件经 window 事件请求定位分区（如 AI 结果面板「去设置」）：
// 本组件只负责切 tab（show 由宿主 Layout/HomeView 监听同一事件置位），
// 隐藏实例切内部态无副作用；直达跳转的同时清掉搜索过滤，避免目标分区被词条过滤藏住。
// detail 双形态（P-20261006-43）：裸 string = 纯分区直达（既有生产方不变）；
// {tab, anchor} = 命令面板「项目规则管理」等携区块锚点直达——切分区后滚动定位
// + 闪烁（revealAnchor 内部短轮询覆盖「事件先于 show 置位、弹窗内容尚未挂载」
// 的首开时序：两个 window 监听器同一次派发内先后执行，nextTick 回调时 show
// 已同步置位、渲染 flush 已完成）
function onOpenSettingsRequest(e: Event) {
  const raw: unknown = (e as CustomEvent).detail
  const tab = typeof raw === 'string'
    ? raw
    : (raw !== null && typeof raw === 'object' && typeof (raw as { tab?: unknown }).tab === 'string'
        ? (raw as { tab: string }).tab
        : '')
  if (!tabs.value.some(tb => tb.key === tab)) return
  searchQuery.value = ''
  activeTab.value = tab as Tab
  const anchor = raw !== null && typeof raw === 'object' && typeof (raw as { anchor?: unknown }).anchor === 'string'
    ? (raw as { anchor: string }).anchor
    : ''
  if (anchor) revealAnchor(tab as Tab, anchor)
}

// 项目规则「编辑」发起文件深链后收起弹窗（P-20261003-181）：编辑器在弹窗
// 之下，不收起则打开的文件被遮住，用户会误以为点击无效
function closeForEditor() {
  emit('update:show', false)
}
onMounted(() => window.addEventListener(OPEN_SETTINGS_EVENT, onOpenSettingsRequest))
onBeforeUnmount(() => {
  window.removeEventListener(OPEN_SETTINGS_EVENT, onOpenSettingsRequest)
  clearAnchorFlash()
})
</script>

<template>
  <n-modal
    :show="props.show"
    :mask-closable="false"
    class="settings-modal"
    @update:show="onShowChange"
  >
    <div
      class="settings-card"
      @keydown="onCardKeydown"
    >
      <!-- 头部 -->
      <div class="settings-header">
        <div class="settings-title">
          <n-icon size="16">
            <SettingsOutline />
          </n-icon>
          <span>{{ t('settings.title') }}</span>
        </div>
        <button
          class="settings-close"
          @click="requestClose"
        >
          &times;
        </button>
      </div>

      <!-- 主体：左侧导航 + 右侧内容 -->
      <div class="settings-body">
        <nav
          ref="navRef"
          class="settings-nav"
          @keydown="onNavKeydown"
        >
          <!-- 分区搜索（P-20261001-9）：标题+关键词表命中才保留分区，空输入恢复全部 -->
          <div class="nav-search">
            <n-input
              v-model:value="searchQuery"
              size="small"
              clearable
              :placeholder="t('settingsSearch.placeholder')"
              data-testid="settings-search"
            >
              <template #prefix>
                <n-icon size="12">
                  <SearchOutline />
                </n-icon>
              </template>
            </n-input>
          </div>
          <!-- 页签容器：桌面纵向列表，≤700px 转为顶部横向可滚动条（P-20261019-6）；
               键盘 ↑↓ 逻辑仍按 .nav-item 顺序工作 -->
          <div class="nav-items">
            <button
              v-for="tab in visibleTabs"
              :key="tab.key"
              class="nav-item"
              :data-testid="'settings-nav-' + tab.key"
              :class="{ active: activeTab === tab.key, hit: searchActive && activeTab !== tab.key }"
              @click="activeTab = tab.key"
            >
              <n-icon size="14">
                <component :is="tab.icon" />
              </n-icon>
              <span>{{ tab.label }}</span>
            </button>
            <div
              v-if="visibleTabs.length === 0"
              class="nav-empty"
            >
              {{ t('settingsSearch.noMatch') }}
            </div>
          </div>
        </nav>

        <div
          ref="contentRef"
          class="settings-content"
        >
          <!-- 通用 -->
          <div
            v-show="activeTab === 'general'"
            class="content-pane"
            data-testid="settings-pane-general"
          >
            <h3 class="pane-title">
              {{ t('settingsTabs.general') }}
            </h3>
            <GeneralSettings
              ref="generalRef"
              :show="props.show"
              @open-file="closeForEditor"
            />
          </div>

          <!-- 外观（主题 + 语言 + 字体 + 编辑器） -->
          <div
            v-show="activeTab === 'appearance'"
            class="content-pane"
            data-testid="settings-pane-appearance"
          >
            <h3 class="pane-title">
              {{ t('settingsTabs.appearance') }}
            </h3>
            <AppearanceSettings
              ref="appearanceRef"
              :show="props.show"
            />
          </div>

          <!-- 终端 -->
          <div
            v-show="activeTab === 'terminal'"
            class="content-pane"
            data-testid="settings-pane-terminal"
          >
            <h3 class="pane-title">
              {{ t('settingsTabs.terminal') }}
            </h3>
            <TerminalSettings
              ref="terminalRef"
              :show="props.show"
            />
          </div>

          <!-- Git -->
          <div
            v-show="activeTab === 'git'"
            class="content-pane"
            data-testid="settings-pane-git"
          >
            <h3 class="pane-title">
              {{ t('settings.gitConfig') }}
            </h3>
            <GitSettings
              ref="gitRef"
              :show="props.show"
            />
          </div>

          <!-- 远程仓库 -->
          <div
            v-show="activeTab === 'remote'"
            class="content-pane"
            data-testid="settings-pane-remote"
          >
            <h3 class="pane-title">
              {{ t('layout.remoteTitle') }}
            </h3>
            <RemoteSettings
              ref="remoteRef"
              :show="props.show"
            />
          </div>

          <!-- 安全（凭据 + SSH + Token） -->
          <div
            v-show="activeTab === 'security'"
            class="content-pane"
            data-testid="settings-pane-security"
          >
            <h3 class="pane-title">
              {{ t('settings.securityTitle') }}
            </h3>
            <SecuritySettings
              ref="securityRef"
              :show="props.show"
              @exit="emit('update:show', false)"
            />
          </div>

          <!-- 迁移（换机配置包导出/导入向导，即时操作） -->
          <div
            v-show="activeTab === 'migration'"
            class="content-pane"
            data-testid="settings-pane-migration"
          >
            <h3 class="pane-title">
              {{ t('settingsTabs.migration') }}
            </h3>
            <MigrationSettings :show="props.show" />
          </div>

          <!-- 通知 -->
          <div
            v-show="activeTab === 'notifications'"
            class="content-pane"
            data-testid="settings-pane-notifications"
          >
            <NotificationSettings ref="notificationRef" />
          </div>

          <!-- 关于 -->
          <div
            v-show="activeTab === 'about'"
            class="content-pane"
            data-testid="settings-pane-about"
          >
            <h3 class="pane-title">
              {{ t('settingsTabs.about') }}
            </h3>
            <AboutSettings :show="props.show" />
          </div>

          <!-- 即时生效五分区（定时任务/输出哨兵/远程部署/系统监控/快捷键）：
               无暂存无保存按钮，装配面在 SettingsInstantPanes -->
          <SettingsInstantPanes
            :active-tab="activeTab"
            :show="props.show"
          />
        </div>
      </div>

      <!-- 底部按钮：需保存 tab 显示关闭+保存；即时操作 tab（security/remote/deploy/about/monitor）
           头部 × 已承担关闭，footer 仅渲染孤零零的关闭钮会与 deploy 等内容区自身操作行堆叠混淆，直接不渲染 -->
      <div
        v-if="needsSave"
        class="settings-footer"
      >
        <n-button
          size="small"
          @click="requestClose"
        >
          {{ t('common.close') }}
        </n-button>
        <n-button
          size="small"
          type="primary"
          :title="t('settings.saveHint')"
          @click="handleSave"
        >
          {{ t('common.save') }}
        </n-button>
      </div>
    </div>
  </n-modal>
</template>

<style scoped src="./settings-modal.css"></style>
<!-- 搜索行级锚定的全局样式：锚点控件在分区子组件内部，必须非 scoped 才能命中 -->
<style src="./settings-anchor-flash.css"></style>
