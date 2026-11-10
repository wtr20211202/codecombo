<script setup lang="ts">
import { onMounted, ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NCheckbox, NDropdown, NIcon, NEmpty, NModal, NSkeleton } from 'naive-ui'
import {
  AddOutline,
  NotificationsOutline, SettingsOutline, ColorPaletteOutline,
  LockClosedOutline, ChatbubblesOutline, GlobeOutline, HelpCircleOutline, CloudCircleOutline,
  TimeOutline, FolderOpenOutline, TvOutline, FlashOutline, DocumentTextOutline,
  SnowOutline, ChevronDownOutline, ChevronForwardOutline, WarningOutline,
} from '@vicons/ionicons5'
import { useProjectStore, type Project } from '../../stores/project'
import { useNotificationStore } from '../../stores/notification'
import { useThemeStore } from '../../stores/theme'
import { useLockStore } from '../../stores/lock'
import { themeRegistry } from '../../themes'
import { fetchAheadBehindMap } from '../../utils/aheadBehind'
import { useI18n } from '../../composables/useI18n'
import { useProjectActions } from '../../composables/useProjectActions'
import { useFetchAll } from '../../composables/useFetchAll'
import { useHomeProjects } from '../../composables/useHomeProjects'
import { useHomeBuildInfo } from '../../composables/useHomeBuildInfo'
import { useHomeGlobalListeners } from '../../composables/useHomeGlobalListeners'
import { formatBadgeCount } from '../../utils/badge'
import { useAgentTerminal } from '../../composables/useAgentTerminal'
import { restoreDshConsoleOnce } from '../../composables/usePanelLayout'
import { usePanelLayout } from '../../composables/usePanelLayout'
import InstanceSwitcher from '../../components/instance/InstanceSwitcher.vue'
import AppLogo from '../../components/common/AppLogo.vue'
import SettingsModal from '../../components/settings/SettingsModal.vue'
import AddProjectDialog from '../../components/home/AddProjectDialog.vue'
import CloneModal from '../../components/layout/CloneModal.vue'
import PathInput from '../../components/common/PathInput.vue'
import RemoteConsoleOverlay from '../../components/remote/RemoteConsoleOverlay.vue'
import AgentTerminal from '../../components/agent/AgentTerminal.vue'
import NotesView from '../notes/NotesView.vue'
import DshConsoleView from '../../components/tools/DshConsoleView.vue'
import DshIcon from '../../components/common/DshIcon.vue'
import HomeProjectCard from '../../components/home/HomeProjectCard.vue'
import HomeToolbar from '../../components/home/HomeToolbar.vue'
import CloneStatusBar from '../../components/home/CloneStatusBar.vue'
import LocaleSuggestBar from '../../components/home/LocaleSuggestBar.vue'
import MorningBriefCard from '../../components/home/MorningBriefCard.vue'
import HomeVersionModal from '../../components/home/HomeVersionModal.vue'
import HelpCenter from '../../components/help/HelpCenter.vue'
import ShortcutsHelp from '../../components/common/ShortcutsHelp.vue'

const router = useRouter()
const projectStore = useProjectStore()
const notificationStore = useNotificationStore()
const showShortcutsHelp = ref(false)
const showHelpCenter = ref(false)
const themeStore = useThemeStore()
const lockStore = useLockStore()
const { t } = useI18n()
// showCloneModal：空态「从 URL 克隆项目」次级入口的开关（复用项目页 CloneModal，只持开关）
const { showSettingsModal, showCloneModal } = useProjectActions(() => [])

// 克隆状态条点击重开（P-20261003-58）：携带 taskId 重开 CloneModal 附加进度
// 视图（CloneProgressWS 按 taskId 幂等重连）；常规克隆入口必须先清附加目标，
// 防残留 taskId 误触发重连
const attachCloneTaskId = ref('')
function openCloneTask(taskId: string) {
  attachCloneTaskId.value = taskId
  showCloneModal.value = true
}
function openCloneModal() {
  attachCloneTaskId.value = ''
  showCloneModal.value = true
}

// 循环切换主题（与项目页 Layout 保持一致）
function cycleTheme() {
  const keys = Object.keys(themeRegistry) as Array<keyof typeof themeRegistry>
  if (keys.length === 0) return
  const idx = keys.indexOf(themeStore.currentTheme)
  themeStore.setTheme(keys[(idx + 1) % keys.length]!)
}

const showAddModal = ref(false)
// 实例详情侧边栏（「管理实例」入口打开，面板为 fixed 定位不依赖父布局）
const showInstanceDetail = ref(false)
// 首页远程控制台全屏 overlay：不进项目直接使用远程终端
const showRemoteConsole = ref(false)

// 智能体终端（悬浮窗）：经 useAgentTerminal 单例驱动，此处仅挂载组件
const agentTerminal = useAgentTerminal()

// dsh 控制台（首页浮层）：与项目页共用 usePanelLayout 单例状态——
// 视图内部关闭（Esc/×）直接写 layout.showDshConsole；开状态 watch 懒挂载保活
const panelLayout = usePanelLayout()
// immediate（P-20261106-4）：showDshConsole 是 usePanelLayout 模块级状态，项目页
// 打开后回首页重挂组件时已为 true——无「变化」可触发 watch，首页浮层空壳
const dshEverOpened = ref(false)
watch(() => panelLayout.showDshConsole.value, (v) => { if (v) dshEverOpened.value = true }, { immediate: true })

// 笔记独立视图（P-20261108-2）：首页=纯首页（P-20261107-3 同口径）——开态是
// usePanelLayout 模块级单例，项目页开着笔记返回首页时不得以 overlay 自动展开，
// 到达首页即路过收起（setup 期同步收：早于 NotesView 宿主挂载判定，免一帧闪现）
panelLayout.closeNotesView()

/** 首页笔记入口：近全屏 overlay，与远程控制台/agent docked overlay 交叉关闭
 *  （同为 z 900 全屏层；dsh 由 openNotesView 互斥收起）。笔记是项目无关的单库
 *  （P-20261108-3），首页与项目页两宿主同库同数据，无数据源可选 */
function openNotes() {
  showRemoteConsole.value = false
  agentTerminal.hideDocked()
  panelLayout.openNotesView()
}

const loading = ref(true)
const aheadBehindMap = ref<Record<string, { ahead: number; behind: number }>>({})

// 搜索 / 排序 / 最近打开 / 分组（useHomeProjects）
const { searchQuery, sortMode, filteredProjects, groupedProjects, rememberOpened } = useHomeProjects()

const sortOptions = computed(() => [
  { label: t('home.sortRecent'), value: 'recent' },
  { label: t('home.sortName'), value: 'name' },
  { label: t('home.sortBranch'), value: 'branch' },
])

// 版本信息（useHomeBuildInfo：拉取 + 弹窗开关 + 复制）
const { buildInfo, showVersionModal, fetchBuildInfo, copyCommitId } = useHomeBuildInfo()

// 版本弹窗入口 = 左上 logo（P-20261107-1）：原工具条最左版本徽章与目的地图标族
// 视觉不同类，收敛后版本信息只在状态栏右下与设置→关于两路常驻。handler 写在
// .home-logo 调用点外层——AppLogo 是纯 SVG 零交互组件（全仓多处复用，含本弹窗
// 头部/远程控制台/设置关于页），交互进组件内会连带漂移
function openVersionFromLogo() {
  // buildInfo 未载（静默请求失败/竞态）时顺手重拉，防「点了没反应」死点击——
  // 弹窗 :show 是 showVersionModal && !!buildInfo 双条件，拉到即现
  if (!buildInfo.value) void fetchBuildInfo()
  showVersionModal.value = true
}

async function fetchAllAheadBehind() {
  // 批量接口一次拉全项目（旧实现 N 个请求扇出；旧版本对端 404 时自动退回扇出）；
  // 冻结项目在 fetchAheadBehindMap 内跳过（服务端批量端点同样跳过，双保险）
  aheadBehindMap.value = await fetchAheadBehindMap(projectStore.projects)
}

// 一键全部拉取（P-20261002-41）：批量链路在 useFetchAll 共享封装（P-20261003-309
// 自此抽出，命令面板「Fetch 全部项目」同源复用）；此处只挂首页侧的 ahead/behind
// 刷新回调（fetch 后项目卡徽章随项目清单刷新联动更新）
const { fetchingAll, fetchAllProjects } = useFetchAll({ refreshAheadBehind: fetchAllAheadBehind })

// 克隆完成（首页 CloneModal）后刷新项目列表 + ahead/behind（与 onMounted/解锁同款联动）
function refreshAfterClone() {
  projectStore.fetchProjects()
    .then(() => fetchAllAheadBehind())
    .catch(() => { /* silent */ })
}

function enterProject(projectId: string) {
  // 记录最近打开
  rememberOpened(projectId)
  // 显式选择打标：Layout 挂载时 uiState 恢复流程不得覆盖（Bug：进 A 跳 B）
  projectStore.selectProjectExplicit(projectId)
  router.push({ name: 'project' })
}

// 同步中心快捷钮（P-20261023-1 入口三路之首页工具条）：同步中心是项目页侧栏
// 视图——首页先落项目页再置 sideView（panelLayout 是模块级单例，状态跨页保持）
function openSyncCenter() {
  panelLayout.sideView.value = 'sync'
  panelLayout.showSidePanel.value = true
  if (router.currentRoute.value.name !== 'project') router.push({ name: 'project' })
}

// 删除确认流与重新定位流都在 useHomeProjects 内；完成后联动 ahead/behind 刷新
const {
  showRemoveConfirm, removeProjectName,
  removeSessionTotal, removeSessionRunning,
  removeResidentAgents, closeResidentAgents,
  openRemoveConfirm, confirmRemoveProject,
  showRelocateModal, relocateProjectName, relocateNewPath, relocating,
  openRelocateModal, confirmRelocateProject,
  setProjectFrozen, setProjectLocked,
} = useHomeProjects()

// 项目卡右键菜单：重新定位（P-12）+ 冻结/解冻（P-20261003-9）+
// 硬锁锁定/解锁（P-20261004-3），按目标状态动态出键
const cardContextShow = ref(false)
const cardContextX = ref(0)
const cardContextY = ref(0)
const cardContextTarget = ref<Project | null>(null)
const cardContextOptions = computed(() => [
  { key: 'relocate', label: t('home.relocate') },
  {
    key: 'freeze',
    label: cardContextTarget.value?.frozen === true
      ? t('project.frozen.menuUnfreeze')
      : t('project.frozen.menuFreeze'),
  },
  {
    key: 'lock',
    label: cardContextTarget.value?.locked === true
      ? t('project.locked.menuUnlock')
      : t('project.locked.menuLock'),
  },
])

function openCardContext(project: Project, ev: MouseEvent) {
  cardContextTarget.value = project
  cardContextX.value = ev.clientX
  cardContextY.value = ev.clientY
  cardContextShow.value = true
}

function handleCardContextSelect(key: string | number) {
  cardContextShow.value = false
  if (key === 'relocate' && cardContextTarget.value) {
    const p = cardContextTarget.value
    openRelocateModal(p.id, p.name, p.path)
  } else if (key === 'freeze' && cardContextTarget.value) {
    const p = cardContextTarget.value
    // 冻结/解冻立即生效（可逆）：完成后联动 ahead/behind 刷新（探测范围随冻结态变化）
    void setProjectFrozen(p.id, p.name, p.frozen !== true, fetchAllAheadBehind)
  } else if (key === 'lock' && cardContextTarget.value) {
    const p = cardContextTarget.value
    // 硬锁锁定（confirm 影响面清单）/解锁（二次确认）：写面开合即改即生效
    void setProjectLocked(p.id, p.name, p.locked !== true)
  }
}

// 已冻结尾部分区展开态：默认折叠为一行计数；搜索激活时自动展开（穿透命中照常可见）
const frozenOpen = ref(false)
const frozenExpanded = computed(() => frozenOpen.value || searchQuery.value.trim() !== '')

onMounted(() => {
  loading.value = true
  projectStore.fetchProjects()
    .then(() => fetchAllAheadBehind())
    .finally(() => { loading.value = false })
  fetchBuildInfo() // 不依赖项目数据，并行获取
  // 更新检查不在此处做（P-20261109-6）：首页挂载即查的旁路曾绕过「自动检查更新」
  // 开关（关了照查），且与 App 层 updateCheck store 的启动首查重复请求、每浏览器
  // 会话重复入账「发现新版本」通知——自动检查统一收口 store（开关门控 + 按版本去重）
  void restoreDshConsoleOnce() // 刷新后恢复上次的 dsh 控制台浮层开关
})

// 监听解锁：isLocked 从 true → false 时，刷新项目列表 + ahead/behind
// HomeView 始终挂载（LockScreenOverlay 只是覆盖层），解锁不会重新触发 onMounted
watch(() => lockStore.isLocked, (newVal, oldVal) => {
  if (newVal && !oldVal) {
    // 锁定时关闭设置弹窗，避免 Naive UI NModal 的 focus trap 阻止
    // LockScreenOverlay 的密码框获焦，导致用户无法输入密码
    showSettingsModal.value = false
  } else if (oldVal && !newVal) {
    // 仅处理 true → false 的解锁转换，避免首次 checkStatus 通过时与 onMounted 重复
    projectStore.fetchProjects().then(() => fetchAllAheadBehind())
    // 锁定态挂载时 settings 请求被 423 拒（silent），buildInfo 一直是 null——
    // 版本弹窗（logo 入口 + :show="showVersionModal && !!buildInfo" 双条件）开不出来，解锁后需补拉
    fetchBuildInfo()
  }
})

// 全局监听（锁定快捷键 / 设置与帮助事件 / 项目变化联动）抽至组合式
useHomeGlobalListeners({
  showSettingsModal,
  showHelpCenter,
  onShortcutsHelp: () => { showShortcutsHelp.value = true },
  onProjectsChanged: () => projectStore.fetchProjects().then(() => fetchAllAheadBehind()).catch(() => { /* silent */ }),
})

</script>

<template>
  <div class="home-root">
    <!-- 顶部标题栏 -->
    <div class="home-header">
      <div class="home-header-left">
        <InstanceSwitcher
          :show-detail="showInstanceDetail"
          @expand="showInstanceDetail = true"
          @collapse="showInstanceDetail = false"
        />
        <!-- 版本弹窗入口（P-20261107-1）：logo 即「关于与版本」位，title + pointer
             保可发现性；点击区随内容不随 flex 拉伸，空白头部不做意外热区 -->
        <div
          class="home-logo"
          :title="t('home.aboutVersion')"
          data-testid="home-logo"
          @click="openVersionFromLogo"
        >
          <AppLogo
            :size="28"
            :animated="true"
          />
          <span class="home-title">Codecombo</span>
          <span class="home-subtitle">{{ t('home.subtitle') }}</span>
        </div>
      </div>
      <!-- 首页工具条是目的地图标同屏面（P-20261022-2）：data-nav-surface 声明门禁
           完整性面——容器内 icon-only 按钮必须带 data-icon-nav 且与 NAV_ICONS 一致 -->
      <div
        class="home-header-actions"
        data-nav-surface="home-toolbar"
      >
        <!-- 值班大屏：独立全屏监控路由（第二块显示器/平板盯机群）。
             图标 TvOutline（盯屏/大屏）：原 SpeedometerOutline 与活动栏「仪表盘」
             面板一图两目的地（P-20261022-2 首批），仪表盘归还 Speedometer 专用 -->
        <button
          class="home-action-btn"
          :title="t('monitorBoard.title')"
          @click="router.push({ name: 'monitor' })"
        >
          <n-icon
            size="16"
            data-icon-nav="monitor"
          >
            <TvOutline />
          </n-icon>
        </button>
        <button
          class="home-action-btn"
          :title="t('agentTerminal.title')"
          @click="agentTerminal.open()"
        >
          <n-icon
            size="16"
            data-icon-nav="agent-terminal"
          >
            <!-- 与项目页活动栏注册表（panels/registry.ts）同源：终端会话管理=双对话气泡 -->
            <ChatbubblesOutline />
          </n-icon>
        </button>
        <button
          class="home-action-btn"
          :title="t('dshConsole.title')"
          @click="showRemoteConsole = false; agentTerminal.hideDocked(); panelLayout.toggleDshConsole()"
        >
          <n-icon size="16">
            <DshIcon />
          </n-icon>
        </button>
        <button
          class="home-action-btn"
          :title="t('remoteConsole.title')"
          @click="panelLayout.showDshConsole.value = false; panelLayout.closeNotesView(); showRemoteConsole = true"
        >
          <n-icon
            size="16"
            data-icon-nav="remote-console"
          >
            <!-- 与项目页活动栏注册表（panels/registry.ts）同源：远程控制台=地球 -->
            <GlobeOutline />
          </n-icon>
        </button>
        <!-- 笔记独立视图（P-20261108-2）：notepad 式近全屏 overlay，可达性对齐远程控制台 -->
        <button
          class="home-action-btn"
          :title="t('notes.panel.title')"
          :aria-label="t('notes.panel.title')"
          data-testid="home-notes"
          @click="openNotes()"
        >
          <n-icon
            size="16"
            data-icon-nav="notes"
          >
            <!-- 与项目页活动栏注册表（panels/registry.ts）同源：笔记=文档 -->
            <DocumentTextOutline />
          </n-icon>
        </button>
        <button
          class="home-action-btn"
          :title="t('sync.title')"
          data-testid="home-sync-center"
          @click="openSyncCenter()"
        >
          <n-icon
            size="16"
            data-icon-nav="sync"
          >
            <!-- 与项目页活动栏注册表（panels/registry.ts）同源：多实例同步=云环 -->
            <CloudCircleOutline />
          </n-icon>
        </button>
        <button
          class="home-action-btn"
          :title="t('layout.settings')"
          @click="showSettingsModal = true"
        >
          <n-icon
            size="16"
            data-icon-nav="settings"
          >
            <SettingsOutline />
          </n-icon>
        </button>
        <button
          class="home-action-btn"
          :title="t('commandPalette.cmdToggleTheme')"
          @click="cycleTheme"
        >
          <n-icon
            size="16"
            data-icon-nav="theme"
          >
            <ColorPaletteOutline />
          </n-icon>
        </button>
        <button
          class="home-action-btn"
          :title="t('notification.title')"
          @click="notificationStore.toggle()"
        >
          <n-icon
            size="16"
            data-icon-nav="notification-center"
          >
            <NotificationsOutline />
          </n-icon>
          <span
            v-if="notificationStore.unreadCount > 0"
            class="home-action-badge"
          >{{ formatBadgeCount(notificationStore.unreadCount) }}</span>
        </button>
        <button
          class="home-action-btn"
          :title="t('help.title')"
          @click="showHelpCenter = true"
        >
          <n-icon
            size="16"
            data-icon-nav="help-center"
          >
            <HelpCircleOutline />
          </n-icon>
        </button>
        <button
          class="home-action-btn"
          :title="t('shortcuts.groupGlobal')"
          @click="showShortcutsHelp = true"
        >
          <n-icon
            size="16"
            data-icon-nav="shortcuts"
          >
            <!-- 图标 FlashOutline（闪电=快捷）：原与帮助中心共用 HelpCircle——两个
                 相邻按钮同图零区分（P-20261022-2 首批） -->
            <FlashOutline />
          </n-icon>
        </button>
        <button
          class="home-action-btn"
          :title="t('layout.lock')"
          @click="lockStore.lock()"
        >
          <n-icon
            size="16"
            data-icon-nav="lock"
          >
            <LockClosedOutline />
          </n-icon>
        </button>
        <n-button
          size="small"
          type="primary"
          @click="showAddModal = true"
        >
          <template #icon>
            <n-icon data-icon-action="common.new"><AddOutline /></n-icon>
          </template>
          {{ t('home.addProject') }}
        </n-button>
      </div>
    </div>

    <!-- 进行中克隆任务常驻指示条（P-20261003-58）：有任务才出现，点击重开
         CloneModal 进度视图（关弹窗后「还在跑吗」的常驻可见面） -->
    <CloneStatusBar @open="openCloneTask" />

    <!-- 首跑浏览器语言建议条（P-20261002-113）：仅首跑（无 locale 存储）且浏览器
         主语言非 zh 时出现一次，切换/保持后永不再现；中文用户零打扰 -->
    <LocaleSuggestBar />

    <!-- 开工检查单横幅卡（P-20261005-219）：跨天连续性信号一屏聚合（未推送提交/
         运行中会话/未读与待审批），任一项非零且当日未已阅才显示，全零零打扰；
         enter 事件复用首页既有进项目链（记录最近打开 + 显式选择打标） -->
    <MorningBriefCard @enter="enterProject" />

    <!-- 项目列表 -->
    <div class="home-content">
      <div
        v-if="loading"
        class="home-skeleton"
      >
        <div
          v-for="i in 4"
          :key="i"
          class="home-skeleton-card"
        >
          <n-skeleton
            text
            width="55%"
            size="medium"
          />
          <n-skeleton
            text
            width="80%"
            size="small"
          />
          <n-skeleton
            text
            width="40%"
            size="small"
          />
          <div class="home-skeleton-row">
            <n-skeleton
              circle
              width="18px"
              height="18px"
            />
            <n-skeleton
              text
              width="90px"
              size="small"
            />
          </div>
        </div>
      </div>

      <div
        v-else-if="projectStore.projects.length === 0"
        class="home-empty"
      >
        <n-empty>
          <template #default>
            <div class="home-empty-desc">
              <div>{{ t('home.noProjects') }}</div>
              <div class="home-empty-tagline">
                {{ t('home.empty.tagline') }}
              </div>
            </div>
          </template>
          <template #extra>
            <div class="home-empty-extra">
              <n-button
                type="primary"
                @click="showAddModal = true"
              >
                <template #icon>
                  <n-icon data-icon-action="common.new"><AddOutline /></n-icon>
                </template>
                {{ t('home.addFirst') }}
              </n-button>
              <div class="home-empty-links">
                <n-button
                  text
                  type="primary"
                  @click="openCloneModal"
                >
                  {{ t('home.empty.cloneFromUrl') }}
                </n-button>
                <n-button
                  text
                  type="primary"
                  @click="showHelpCenter = true"
                >
                  {{ t('home.empty.quickStart') }}
                </n-button>
              </div>
            </div>
          </template>
        </n-empty>
      </div>

      <template v-else>
        <!-- 搜索 & 排序 & 一键全部拉取工具栏 -->
        <HomeToolbar
          v-model:search="searchQuery"
          v-model:sort="sortMode"
          :shown="filteredProjects.length"
          :total="projectStore.projects.length"
          :sort-options="sortOptions"
          :fetching-all="fetchingAll"
          @fetch-all="fetchAllProjects"
        />

        <!-- 最近打开分组 -->
        <div
          v-if="groupedProjects.hasRecent && groupedProjects.recent.items.length > 0"
          class="project-section"
        >
          <div class="section-label">
            <n-icon size="12">
              <TimeOutline />
            </n-icon>
            <span>{{ groupedProjects.recent.label }}</span>
          </div>
          <div class="home-grid">
            <HomeProjectCard
              v-for="(project, idx) in groupedProjects.recent.items"
              :key="project.id"
              :project="project"
              :ahead="aheadBehindMap[project.id]?.ahead ?? 0"
              :behind="aheadBehindMap[project.id]?.behind ?? 0"
              :is-recent="true"
              :index="idx"
              @enter="enterProject(project.id)"
              @remove="(ev: MouseEvent) => openRemoveConfirm(project.id, project.name, project.path, ev)"
              @relocate="(ev: MouseEvent) => openRelocateModal(project.id, project.name, project.path, ev)"
              @context="openCardContext(project, $event)"
            />
          </div>
        </div>

        <!-- 全部分组 -->
        <div
          v-if="groupedProjects.others.items.length > 0"
          class="project-section"
        >
          <div
            v-if="groupedProjects.hasRecent"
            class="section-label"
          >
            <n-icon size="12">
              <FolderOpenOutline />
            </n-icon>
            <span>{{ groupedProjects.others.label }}</span>
          </div>
          <div class="home-grid">
            <HomeProjectCard
              v-for="(project, idx) in groupedProjects.others.items"
              :key="project.id"
              :project="project"
              :ahead="aheadBehindMap[project.id]?.ahead ?? 0"
              :behind="aheadBehindMap[project.id]?.behind ?? 0"
              :index="idx"
              @enter="enterProject(project.id)"
              @remove="(ev: MouseEvent) => openRemoveConfirm(project.id, project.name, project.path, ev)"
              @relocate="(ev: MouseEvent) => openRelocateModal(project.id, project.name, project.path, ev)"
              @context="openCardContext(project, $event)"
            />
          </div>
        </div>

        <!-- 已冻结尾部分区（P-20261003-9）：默认折叠为一行计数、可展开看卡（弱化样式），
             任何排序下沉底；搜索穿透冻结区——命中时自动展开照常显示 -->
        <div
          v-if="groupedProjects.frozen.items.length > 0"
          class="project-section frozen-section"
        >
          <button
            class="section-label frozen-toggle"
            type="button"
            @click="frozenOpen = !frozenOpen"
          >
            <n-icon size="12">
              <SnowOutline />
            </n-icon>
            <span>{{ t('project.frozen.sectionLabel') }}</span>
            <span class="frozen-count">{{ groupedProjects.frozen.items.length }}</span>
            <n-icon
              size="12"
              class="frozen-chevron"
            >
              <ChevronDownOutline v-if="frozenExpanded" />
              <ChevronForwardOutline v-else />
            </n-icon>
          </button>
          <div
            v-if="frozenExpanded"
            class="home-grid"
          >
            <HomeProjectCard
              v-for="(project, idx) in groupedProjects.frozen.items"
              :key="project.id"
              :project="project"
              :ahead="aheadBehindMap[project.id]?.ahead ?? 0"
              :behind="aheadBehindMap[project.id]?.behind ?? 0"
              :frozen="true"
              :index="idx"
              @enter="enterProject(project.id)"
              @remove="(ev: MouseEvent) => openRemoveConfirm(project.id, project.name, project.path, ev)"
              @relocate="(ev: MouseEvent) => openRelocateModal(project.id, project.name, project.path, ev)"
              @context="openCardContext(project, $event)"
            />
          </div>
        </div>

        <!-- 无搜索结果 -->
        <div
          v-if="filteredProjects.length === 0"
          class="home-empty"
        >
          <n-empty :description="t('commandPalette.noResults')" />
        </div>
      </template>
    </div>

    <!-- 添加项目弹窗（与 Layout 左侧工具栏共享同一组件，保证功能一致） -->
    <AddProjectDialog
      v-model:show="showAddModal"
      @added="fetchAllAheadBehind"
    />

    <!-- 从 URL 克隆（空态次级入口复用项目页 CloneModal；成功后刷新卡片列表；
         attach-task-id 供状态条点击重开时附加进度视图） -->
    <CloneModal
      v-model:show="showCloneModal"
      :attach-task-id="attachCloneTaskId"
      @cloned="refreshAfterClone"
    />

    <!-- 远程控制台全屏 overlay（不进项目直接使用） -->
    <RemoteConsoleOverlay v-model:show="showRemoteConsole" />

    <!-- dsh 控制台（首页浮层，与项目页主区视图同一组件：懒挂载保活，
         iframe 经回环反代嵌入 dsh Web UI；自带头部含关闭/Esc） -->
    <DshConsoleView
      v-if="dshEverOpened"
      v-show="panelLayout.showDshConsole.value"
      :maximizable="false"
      class="dsh-console-home"
    />

    <!-- 智能体（系统级多会话终端；home 以全屏 overlay 呈现 docked 管理页，
         悬浮窗/悬浮条 Teleport 常驻；组件全局唯一，路由间互斥挂载） -->
    <AgentTerminal context="home" />

    <!-- 笔记独立视图（P-20261108-2，首页近全屏 overlay 形态；Esc/头部 × 关闭，
         与项目页主区形态共用 usePanelLayout 开态与 NotesPanel 主体） -->
    <NotesView context="home" />

    <!-- 删除项目确认弹窗 -->
    <n-modal
      v-model:show="showRemoveConfirm"
      preset="dialog"
      :title="t('home.removeTitle')"
      type="warning"
      :mask-closable="false"
      :positive-text="t('home.confirmRemove')"
      :negative-text="t('common.cancel')"
      @positive-click="confirmRemoveProject"
    >
      <div class="remove-confirm-body">
        {{ t('home.removeConfirmPrefix') }}
        <span class="remove-confirm-name">{{ removeProjectName }}</span>
        {{ t('home.removeConfirmSuffix') }}
      </div>
      <!-- 级联会话知会（P-20261003-145）：有会话才追加；有运行中的升级红色警示 -->
      <div
        v-if="removeSessionTotal > 0"
        data-testid="remove-session-impact"
        class="remove-session-impact"
        :class="{ 'remove-session-impact-running': removeSessionRunning > 0 }"
      >
        <NIcon
          v-if="removeSessionRunning > 0"
          class="remove-session-impact-icon"
          :size="14"
        >
          <WarningOutline />
        </NIcon>
        <span>{{ t('home.removeSessionsTotal', { count: removeSessionTotal }) }}</span>
        <span v-if="removeSessionRunning > 0">{{ t('home.removeSessionsRunning', { count: removeSessionRunning }) }}</span>
      </div>
      <!-- 驻留智能体会话知会（P-20261006-36）：免项目绑定但工作目录在项目内的
           agent 会话，默认随删除保留；文案与终端会话区分、不带运行态（agent
           会话几乎恒运行，报运行态是噪音） -->
      <div
        v-if="removeResidentAgents > 0"
        data-testid="remove-resident-agents"
        class="remove-session-impact"
      >
        <span>{{ t('home.removeResidentAgents', { count: removeResidentAgents }) }}</span>
      </div>
      <!-- 级联处置选项（P-20261006-36）：默认不勾（保守保留，agent 可能正收尾） -->
      <n-checkbox
        v-if="removeResidentAgents > 0"
        v-model:checked="closeResidentAgents"
        data-testid="remove-close-resident-agents"
        class="remove-close-resident"
      >
        {{ t('home.removeCloseResidentAgents') }}
      </n-checkbox>
    </n-modal>

    <!-- 项目卡右键菜单 -->
    <NDropdown
      placement="bottom-start"
      trigger="manual"
      :x="cardContextX"
      :y="cardContextY"
      :options="cardContextOptions"
      :show="cardContextShow"
      @select="handleCardContextSelect"
      @clickoutside="cardContextShow = false"
    />

    <!-- 重新定位项目弹窗（失效恢复：ID/名称不变仅换路径，uiState/终端历史全保留；
         路径浏览与添加项目同款 PathInput） -->
    <n-modal
      v-model:show="showRelocateModal"
      preset="dialog"
      :title="t('home.relocateTitle')"
      :positive-text="t('common.confirm')"
      :negative-text="t('common.cancel')"
      :positive-button-props="{ loading: relocating }"
      :mask-closable="false"
      style="width: var(--modal-w-md); max-width: 94vw"
      @positive-click="confirmRelocateProject(fetchAllAheadBehind)"
    >
      <div class="relocate-body">
        <div class="relocate-hint">
          {{ t('home.relocateHint') }}
        </div>
        <div class="relocate-project-name">
          {{ relocateProjectName }}
        </div>
        <div class="relocate-field-label">
          {{ t('home.relocateNewPath') }}
        </div>
        <PathInput
          v-model:value="relocateNewPath"
          :placeholder="t('home.pathPlaceholder')"
        />
      </div>
    </n-modal>

    <!-- 版本信息弹窗 -->
    <HomeVersionModal
      :show="showVersionModal && !!buildInfo"
      :build-info="buildInfo"
      @close="showVersionModal = false"
      @copy-commit="copyCommitId"
    />

    <!-- 设置弹窗（与项目页共享） -->
    <SettingsModal v-model:show="showSettingsModal" />

    <HelpCenter v-model:show="showHelpCenter" />
    <ShortcutsHelp v-model:show="showShortcutsHelp" />
  </div>
</template>

<style scoped>
.home-root {
  height: 100vh;
  background: var(--bg-primary);
  display: flex;
  flex-direction: column;
}

/* 首页 dsh 控制台浮层：全屏覆盖（与远程控制台 overlay 同层级；
   自带工具条含刷新/新标签/关闭，Esc 亦可关） */
.dsh-console-home {
  position: fixed;
  inset: 0;
  z-index: 900;
}

.home-header {
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border-default);
  padding: 14px 28px;
  display: flex;
  align-items: center;
  gap: 16px;
  flex-shrink: 0;
}

.home-header-left {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}

/* logo 即版本弹窗入口（P-20261107-1）：pointer 提示可点；不再 flex:1 撑满——
   点击命中区收敛到 logo+标题+副标题内容本身，header 剩余空白不做意外热区
   （header-left 自身 flex:1 继续把工具条推到右侧，布局不变） */
.home-logo {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
}

.home-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.3px;
}

.home-subtitle {
  font-size: 12px;
  color: var(--text-muted);
}

.home-content {
  flex: 1;
  overflow-y: auto;
  padding: 24px 28px 40px;
}

.home-skeleton {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}
.home-skeleton-card {
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.home-skeleton-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

.home-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: 300px;
}
.home-loading-text {
  color: var(--text-muted);
  font-size: 12px;
}

.home-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 400px;
}

/* 空态上手引导：描述区两行（空态文案 + 产品定位一句话），extra 区主按钮 + 两行次级入口 */
.home-empty-desc {
  text-align: center;
}
.home-empty-tagline {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-muted);
}
.home-empty-extra {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}
.home-empty-links {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.project-section {
  margin-bottom: 28px;
}

.section-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
  margin-bottom: 12px;
  padding: 0 4px;
}

.home-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}

/* 已冻结尾部分区（P-20261003-9）：折叠行 = 雪花图标 + 标签 + 计数徽标 + 箭头。
   button 复位浏览器默认样式后复用 .section-label 排版 */
.frozen-toggle {
  width: 100%;
  background: none;
  border: none;
  padding: 0 4px;
  cursor: pointer;
  font: inherit;
  color: var(--text-dim);
  text-align: left;
  transition: color var(--motion-base);
}
.frozen-toggle:hover {
  color: var(--text-secondary);
}
.frozen-count {
  font-size: 10px;
  font-family: var(--font-mono);
  line-height: 14px;
  padding: 0 7px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
}
.frozen-chevron {
  margin-left: 2px;
}

/* 顶部功能按钮（AI 助手/远程控制台/设置 / 主题 / 通知）通用样式 */
.home-action-btn {
  position: relative;
  width: 30px;
  height: 30px;
  border-radius: 6px;
  border: 1px solid var(--border-default);
  background: var(--bg-panel);
  color: var(--text-secondary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all var(--motion-base);
}
.home-action-btn:hover {
  color: var(--accent-blue);
  border-color: var(--accent-blue);
  background: color-mix(in srgb, var(--accent-blue) 8%, transparent);
}
.home-action-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--accent-red);
  color: var(--text-on-accent);
  font-size: 10px;
  font-family: var(--font-mono);
  font-weight: 700;
  line-height: 16px;
  text-align: center;
  border: 1.5px solid var(--bg-panel);
}

.remove-confirm-body { color: var(--text-body); font-size: 13px; }
.remove-confirm-name { color: var(--accent-red); font-weight: 500; }

/* 级联会话知会行（P-20261003-145）：默认中性提示；有运行中的升级红色警示 */
.remove-session-impact {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 8px;
  padding: 6px 10px;
  border-radius: 4px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 12px;
}
.remove-session-impact-running {
  background: color-mix(in srgb, var(--accent-red) 12%, transparent);
  color: var(--accent-red);
  font-weight: 500;
}
.remove-session-impact-icon { flex-shrink: 0; }

/* 驻留智能体会话处置选项（P-20261006-36）：知会行下的独立勾选行 */
.remove-close-resident {
  margin-top: 8px;
  font-size: 12px;
}

/* 重新定位弹窗 */
.relocate-body { display: flex; flex-direction: column; gap: 6px; }
.relocate-hint {
  font-size: 12px;
  color: var(--text-secondary);
  padding: 6px 10px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  margin-bottom: 6px;
}
.relocate-field-label { font-size: 13px; color: var(--text-secondary); }
.relocate-project-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}
</style>
