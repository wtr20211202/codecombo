<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import {
  NButton, NInput, NInputNumber, NSelect, NCheckbox, NRadioGroup, NRadioButton,
} from 'naive-ui'
import {
  useFontStore, AUTOSAVE_DELAY_MIN, AUTOSAVE_DELAY_MAX, AUTOSAVE_DELAY_DEFAULT,
  MONO_FONT_NAME_MAX_LENGTH, sanitizeMonoFontName, composeMonoFontFamily,
  LINE_HEIGHT_MULTIPLIERS,
  type DiffPalette,
} from '../../stores/font'
import { useUiZoomStore, UI_ZOOM_LEVELS, UI_ZOOM_DEFAULT, type UiZoomLevel } from '../../stores/ui-zoom'
import { useUiDensityStore, UI_DENSITY_DEFAULT, type UiDensity } from '../../stores/ui-density'
import { useGraphLanesStore, GRAPH_LANE_LIMITS, GRAPH_LANE_LIMIT_DEFAULT, type GraphLaneLimit } from '../../stores/graph-lanes'
import { useFileNestingStore } from '../../stores/file-nesting'
import { useThemeStore } from '../../stores/theme'
import { useLocaleStore, LOCALE_DEFAULT } from '../../stores/locale'
import { useTerminalThemeStore, TERMINAL_THEME_FOLLOW_DEFAULT, TERMINAL_FONT_DEFAULT } from '../../stores/terminal-theme'
import { useI18n } from '../../composables/useI18n'
import { useLayoutReset } from '../../composables/useLayoutReset'
import { useUIStateStore } from '../../stores/uiState'
import { themeRegistry, type ThemeKey } from '../../themes'
import { terminalThemeRegistry, FALLBACK_TERMINAL_THEME } from '../../terminal-themes'
import type { TerminalFontFamily } from '../../terminal-themes/types'
import { locales } from '../../locales'
import SettingModifiedMark from './SettingModifiedMark.vue'

const props = defineProps<{ show: boolean }>()

const fontStore = useFontStore()
const uiZoomStore = useUiZoomStore()
const uiDensityStore = useUiDensityStore()
const graphLanesStore = useGraphLanesStore()
// 文件树同名族嵌套（P-20261006-21）：直写行（minimap 同款），即时生效不参与脏护栏
const fileNestingStore = useFileNestingStore()
const uiStateStore = useUIStateStore()
const themeStore = useThemeStore()
const localeStore = useLocaleStore()
const terminalThemeStore = useTerminalThemeStore()
const { t } = useI18n()
// 一键重置当前项目布局（P-20261002-74）：confirm + 服务端写默认 + 就地重应用
// 都在 useLayoutReset 内闭环（面板状态是模块级单例，首页挂载同样生效）
const { resetLayoutWithConfirm } = useLayoutReset()

const pendingTheme = ref<ThemeKey>(themeStore.currentTheme)
const pendingLocale = ref(localeStore.currentLocale)
const themeOptions = Object.entries(themeRegistry).map(([key, def]) => ({ label: def.label, value: key as ThemeKey, preview: def.preview }))
const localeOptions = Object.entries(locales).map(([key, entry]) => ({ label: entry.label, value: key }))

// 终端主题选项（按 registry 顺序）—— 预览需要的特征色 + 效果标识
const terminalThemeOptions = Object.entries(terminalThemeRegistry).map(([key, def]) => {
  const fx = def.effects ?? {}
  return {
    value: key,
    label: def.label,
    isDark: def.isDark,
    bg: def.colors.background,
    fg: def.colors.foreground,
    accent: def.colors.blue,
    green: def.colors.green,
    yellow: def.colors.yellow,
    red: def.colors.red,
    magenta: def.colors.magenta,
    // 主题特征效果标识（驱动预览卡片的伪元素样式）
    scanline: fx.scanline ?? 'none',
    cornerBrackets: !!fx.cornerBrackets,
    vignette: !!fx.vignette,
    starfield: !!fx.starfield,
  }
})

// 终端字体选项（用实际字体显示其名）
const terminalFontOptions: { value: TerminalFontFamily; label: string; className: string }[] = [
  { value: 'jetbrains', label: 'JetBrains Mono', className: 'terminal-font-jetbrains' },
  { value: 'cascadia', label: 'Cascadia Code', className: 'terminal-font-cascadia' },
  { value: 'ibmplex', label: 'IBM Plex Mono', className: 'terminal-font-ibmplex' },
  { value: 'fira', label: 'Fira Code', className: 'terminal-font-fira' },
]

// 界面字体族选项（brand = 打包的 Geist/Inter；system = 系统栈）
const uiFontOptions = [
  { value: 'brand' as const, label: () => t('settings.uiFontBrand') },
  { value: 'system' as const, label: () => t('settings.uiFontSystem') },
]

// 本地 pending 状态（应用/取消时同步）
const pendingZoom = ref<UiZoomLevel>(uiZoomStore.level)
// 缩放档位选项：比例值 → 90%/100%/110%/125% 分段选择（对标 VS Code window.zoomLevel）
const zoomOptions = UI_ZOOM_LEVELS.map(l => ({ value: l, label: `${Math.round(l * 100)}%` }))
// 界面密度档（P-20261003-322）：紧凑/舒适（默认=历史现状），落服务端 settings
const pendingUiDensity = ref<UiDensity>(uiDensityStore.density)
const densityOptions: { value: UiDensity; label: () => string }[] = [
  { value: 'comfortable', label: () => t('appearance.density.comfortable') },
  { value: 'compact', label: () => t('appearance.density.compact') },
]
// 提交拓扑泳道上限（P-20261006-29）：BranchGraph 渲染封顶档位，超限泳道并入
// 末道绘制（图区出诚实注记）；每设备视觉偏好（宽屏放宽/小屏收紧），落 localStorage
const pendingGraphLanes = ref<GraphLaneLimit>(graphLanesStore.limit)
const graphLaneOptions = GRAPH_LANE_LIMITS.map(n => ({ value: n, label: String(n) }))
// diff 色板档（P-20261006-5）：标准红绿 / 色弱友好蓝橙（deuteranopia-safe）。
// 直写 store 即时生效（localStorage 视觉偏好，gitStatusTabs 同族，不参与脏护栏），
// DiffViewer 文本路径与 Monaco diff 编辑器经 theme store / applyMonacoTheme 同源换装
const diffPaletteOptions: { value: DiffPalette; label: () => string }[] = [
  { value: 'standard', label: () => t('appearance.diffPalette.standard') },
  { value: 'colorblind', label: () => t('appearance.diffPalette.colorblind') },
]
// 项目仪表盘默认落点（P-20261005-224）：editor = 历史现状（进项目落编辑器），
// dashboard = 显式进入项目（首页点击/实例切换）主区先落仪表盘；刷新恢复/页内
// 跳转不落。落 uiState dashboard 命名空间（实例级，多端跟随）
const pendingDashboardLanding = ref(false)
// load 基线（isDirty/save 的比较基准，避免 save 期再发一次 GET 对账）
const loadedDashboardLanding = ref(false)
const dashboardLandingOptions: { value: boolean; label: () => string }[] = [
  { value: false, label: () => t('appearance.dashboardLanding.editor') },
  { value: true, label: () => t('appearance.dashboardLanding.dashboard') },
]
const pendingUiFont = ref<'brand' | 'system'>(fontStore.uiFont)
const pendingTerminalLigatures = ref<'on' | 'off'>(fontStore.terminalLigatures)
const pendingTerminalLigaturesBool = computed({
  get: () => pendingTerminalLigatures.value === 'on',
  set: (v: boolean) => { pendingTerminalLigatures.value = v ? 'on' : 'off' },
})
// 自定义等宽字体名（P-20261005-227）：空 = 内置 --font-mono 栈；输入经消毒后落
// font store（localStorage），apply 写 --font-mono-lead 前插段全局生效
const pendingMonoFontName = ref(fontStore.monoFontName)
// 预览行随 pending 实时渲染（所见即所得）——幻觉字体名（本地未安装）在这里直接
// 可见回退效果，是「装了没生效」的第一反馈面；走 .mono 类吃连字开关的真实消费路径
const monoFontPreviewFamily = computed(() =>
  composeMonoFontFamily(sanitizeMonoFontName(pendingMonoFontName.value)))
const pendingTerminalTheme = ref<string>(terminalThemeStore.savedThemeName)
const pendingTerminalFont = ref<TerminalFontFamily>(terminalThemeStore.currentFont)
// 跟随应用明暗开关（P-20261002-144）：开启时终端主题按应用深浅档位映射生效，
// 下方主题卡选择的是「解绑后生效的手工选择」
const pendingTerminalFollow = ref(terminalThemeStore.followAppTheme)

async function loadTerminalSettings() {
  pendingTerminalFollow.value = terminalThemeStore.followAppTheme
  pendingTerminalTheme.value = terminalThemeStore.savedThemeName
  pendingTerminalFont.value = terminalThemeStore.currentFont
}

async function saveTerminalSettings() {
  if (pendingTerminalFollow.value !== terminalThemeStore.followAppTheme) {
    terminalThemeStore.setFollowAppTheme(pendingTerminalFollow.value)
  }
  if (pendingTerminalTheme.value !== terminalThemeStore.savedThemeName) {
    await terminalThemeStore.setTheme(pendingTerminalTheme.value)
  }
  if (pendingTerminalFont.value !== terminalThemeStore.currentFont) {
    await terminalThemeStore.setFont(pendingTerminalFont.value)
  }
}

/** 主题卡点选：跟随开启时点选具体主题 = 手工接管手势，自动解绑（否则点选被
 *  跟随映射盖住、无可见效果）；跟随关闭时纯改手工选择 */
function pickTerminalTheme(value: string) {
  pendingTerminalTheme.value = value
  if (pendingTerminalFollow.value) pendingTerminalFollow.value = false
}

const fontItems = [
  { key: 'base', label: () => t('layout.globalBase'), val: () => fontStore.sizes.base },
  { key: 'editor', label: () => t('layout.editorFont'), val: () => fontStore.sizes.editor },
  { key: 'diff', label: () => t('layout.diffFont'), val: () => fontStore.sizes.diff },
  { key: 'sidebar', label: () => t('layout.sidebarFont'), val: () => fontStore.sizes.sidebar },
  { key: 'bottom', label: () => t('layout.bottomFont'), val: () => fontStore.sizes.bottom },
] as const

// 自动保存档位选项（P-20261002-129，对标 files.autoSave）：与 wordWrap 等
// 编辑器行为类选项同款直写 store 即时生效
const autoSaveOptions = [
  { value: 'off' as const, label: () => t('editor.autoSave.off') },
  { value: 'afterDelay' as const, label: () => t('editor.autoSave.afterDelay') },
]

/** 停手延时输入（毫秒）：钳制取整在 setAutoSaveDelay 内；null（清空瞬态）忽略 */
function onAutoSaveDelayInput(v: number | null) {
  if (typeof v === 'number' && Number.isFinite(v)) fontStore.setAutoSaveDelay(v)
}

async function load() {
  pendingTheme.value = themeStore.currentTheme
  pendingLocale.value = localeStore.currentLocale
  pendingZoom.value = uiZoomStore.level
  pendingUiDensity.value = uiDensityStore.density
  pendingGraphLanes.value = graphLanesStore.limit
  pendingUiFont.value = fontStore.uiFont
  pendingTerminalLigatures.value = fontStore.terminalLigatures
  pendingMonoFontName.value = fontStore.monoFontName
  pendingDashboardLanding.value = await uiStateStore.getDashboardLanding()
  loadedDashboardLanding.value = pendingDashboardLanding.value
  await loadTerminalSettings()
}

async function save() {
  if (pendingTheme.value !== themeStore.currentTheme) {
    themeStore.setTheme(pendingTheme.value)
    // 终端主题跟随开启时（P-20261002-144）随应用明暗档位自动切换；
    // 跟随关闭则终端主题保持手工选择不受影响
  }
  if (pendingLocale.value !== localeStore.currentLocale) {
    localeStore.setLocale(pendingLocale.value)
  }
  if (pendingZoom.value !== uiZoomStore.level) {
    uiZoomStore.setLevel(pendingZoom.value)
  }
  if (pendingUiDensity.value !== uiDensityStore.density) {
    await uiDensityStore.setDensity(pendingUiDensity.value)
  }
  if (pendingGraphLanes.value !== graphLanesStore.limit) {
    graphLanesStore.setLimit(pendingGraphLanes.value)
  }
  if (pendingDashboardLanding.value !== loadedDashboardLanding.value) {
    await uiStateStore.saveDashboardLanding(pendingDashboardLanding.value)
    loadedDashboardLanding.value = pendingDashboardLanding.value
  }
  if (pendingUiFont.value !== fontStore.uiFont) {
    fontStore.setUiFont(pendingUiFont.value)
  }
  if (pendingTerminalLigatures.value !== fontStore.terminalLigatures) {
    fontStore.setTerminalLigatures(pendingTerminalLigatures.value)
  }
  // setMonoFontName 内消毒——比较侧同口径消毒，纯格式差异（如多余引号）不算变更
  if (sanitizeMonoFontName(pendingMonoFontName.value) !== fontStore.monoFontName) {
    fontStore.setMonoFontName(pendingMonoFontName.value)
  }
  await saveTerminalSettings()
}

onMounted(() => {
  if (props.show) load()
})
watch(() => props.show, (val) => {
  if (val) load()
})

// 关闭护栏：与 save() 的变更检测条件一一对应——任一 pending 偏离
// store 当前值即视为有未保存修改（编辑器行为类选项直接写 store，即时生效不参与）
function isDirty(): boolean {
  return pendingTheme.value !== themeStore.currentTheme
    || pendingLocale.value !== localeStore.currentLocale
    || pendingZoom.value !== uiZoomStore.level
    || pendingUiDensity.value !== uiDensityStore.density
    || pendingGraphLanes.value !== graphLanesStore.limit
    || pendingDashboardLanding.value !== loadedDashboardLanding.value
    || pendingUiFont.value !== fontStore.uiFont
    || pendingTerminalLigatures.value !== fontStore.terminalLigatures
    || sanitizeMonoFontName(pendingMonoFontName.value) !== fontStore.monoFontName
    || pendingTerminalFollow.value !== terminalThemeStore.followAppTheme
    || pendingTerminalTheme.value !== terminalThemeStore.savedThemeName
    || pendingTerminalFont.value !== terminalThemeStore.currentFont
}

defineExpose({ load, save, isDirty })
</script>

<template>
  <div class="appearance-settings">
    <!-- 主题选择 -->
    <div class="form-group">
      <div class="form-label">
        {{ t('layout.theme') }}
      </div>
      <div class="theme-grid">
        <button
          v-for="opt in themeOptions"
          :key="opt.value"
          class="theme-card"
          :class="{ active: pendingTheme === opt.value }"
          @click="pendingTheme = opt.value"
        >
          <div class="theme-preview">
            <div
              class="tp-bar"
              :style="{ background: opt.preview.canvas, width: '50%' }"
            />
            <div
              class="tp-bar"
              :style="{ background: opt.preview.surface, width: '30%' }"
            />
            <div
              class="tp-bar"
              :style="{ background: `linear-gradient(135deg, ${opt.preview.accentFrom}, ${opt.preview.accentTo})`, width: '20%' }"
            />
          </div>
          <div class="theme-name">
            {{ opt.label }}
          </div>
        </button>
      </div>
    </div>

    <!-- 界面缩放：应用内 zoom 档位（对标 VS Code window.zoomLevel），浏览器整页缩放不动、各设备各自记忆 -->
    <div class="form-group">
      <div class="form-label">
        {{ t('appearance.zoom.label') }}
      </div>
      <div class="ctrl-row">
        <n-radio-group
          v-model:value="pendingZoom"
          size="small"
        >
          <n-radio-button
            v-for="opt in zoomOptions"
            :key="opt.value"
            :value="opt.value"
            :label="opt.label"
          />
        </n-radio-group>
        <SettingModifiedMark
          :modified="pendingZoom !== UI_ZOOM_DEFAULT"
          @restore="pendingZoom = UI_ZOOM_DEFAULT"
        />
      </div>
      <!-- 分轨标注（P-20261007-1）：缩放/字号/光标等视觉偏好是设备本地轨，
           刻意不随账号漫游（P-87 per-device 立场收编为显式分轨约定） -->
      <div class="follow-hint">
        {{ t('settings.syncTrackDeviceLocal') }}
      </div>
    </div>

    <!-- 界面密度（P-20261003-322）：紧凑/舒适两档，树/变更树/会话列表/通知中心
         行高 token 联动；落服务端 settings，settings.changed 广播多端跟随 -->
    <div
      class="form-group"
      data-testid="settings-ui-density"
    >
      <div class="form-label">
        {{ t('appearance.density.label') }}
      </div>
      <div class="ctrl-row">
        <n-radio-group
          v-model:value="pendingUiDensity"
          size="small"
        >
          <n-radio-button
            v-for="opt in densityOptions"
            :key="opt.value"
            :value="opt.value"
            :label="opt.label()"
          />
        </n-radio-group>
        <SettingModifiedMark
          :modified="pendingUiDensity !== UI_DENSITY_DEFAULT"
          @restore="pendingUiDensity = UI_DENSITY_DEFAULT"
        />
      </div>
    </div>

    <!-- 文件树同名族嵌套（P-20261006-21）：测试/样式/声明等同名族折叠进主文件行
         （+N 角标）。默认关——树形态变化影响既有习惯；每设备偏好落 localStorage
         （graphLanes 同哲学），直写行即时生效不参与脏护栏 -->
    <label
      class="setting-row"
      data-testid="settings-file-nesting"
    >
      <n-checkbox
        :checked="fileNestingStore.enabled"
        size="small"
        @update:checked="fileNestingStore.setEnabled($event)"
      />
      <span class="setting-meta">{{ t('appearance.fileNesting.label') }}</span>
      <SettingModifiedMark
        :modified="fileNestingStore.enabled"
        @restore="fileNestingStore.setEnabled(false)"
      />
    </label>
    <div class="follow-hint">
      {{ t('appearance.fileNesting.hint') }}
    </div>

    <!-- 提交拓扑泳道上限（P-20261006-29）：BranchGraph 渲染封顶档位，活跃泳道
         超上限并入末道绘制（图区出诚实注记+末道虚线区分）；每设备视觉偏好
         （宽屏放宽/小屏收紧），落 localStorage 不入设置迁移包（ui-zoom 同哲学） -->
    <div
      class="form-group"
      data-testid="settings-graph-lanes"
    >
      <div class="form-label">
        {{ t('appearance.graphLanes.label') }}
      </div>
      <div class="ctrl-row">
        <n-radio-group
          v-model:value="pendingGraphLanes"
          size="small"
        >
          <n-radio-button
            v-for="opt in graphLaneOptions"
            :key="opt.value"
            :value="opt.value"
            :label="opt.label"
          />
        </n-radio-group>
        <SettingModifiedMark
          :modified="pendingGraphLanes !== GRAPH_LANE_LIMIT_DEFAULT"
          @restore="pendingGraphLanes = GRAPH_LANE_LIMIT_DEFAULT"
        />
      </div>
      <div class="follow-hint">
        {{ t('appearance.graphLanes.hint') }}
      </div>
    </div>

    <!-- diff 色板（P-20261006-5）：标准红绿 / 色弱友好蓝橙。直写 store 即时生效
         （localStorage 视觉偏好不参与脏护栏）；预览条走 --diff-added/--diff-removed
         真实消费变量，切档即时换色即所见即所得 -->
    <div
      class="form-group"
      data-testid="settings-diff-palette"
    >
      <div class="form-label">
        {{ t('appearance.diffPalette.label') }}
      </div>
      <div class="ctrl-row">
        <n-radio-group
          :value="fontStore.diffPalette"
          size="small"
          @update:value="(v: string) => fontStore.setDiffPalette(v as DiffPalette)"
        >
          <n-radio-button
            v-for="opt in diffPaletteOptions"
            :key="opt.value"
            :value="opt.value"
            :label="opt.label()"
          />
        </n-radio-group>
        <SettingModifiedMark
          :modified="fontStore.diffPalette !== fontStore.DIFF_PALETTE_DEFAULT"
          @restore="fontStore.setDiffPalette(fontStore.DIFF_PALETTE_DEFAULT)"
        />
      </div>
      <div
        class="diff-palette-preview"
        data-testid="settings-diff-palette-preview"
      >
        <span class="dpp-chip dpp-add">{{ t('appearance.diffPalette.previewAdd') }}</span>
        <span class="dpp-chip dpp-del">{{ t('appearance.diffPalette.previewRemove') }}</span>
      </div>
      <div class="follow-hint">
        {{ t('appearance.diffPalette.hint') }}
      </div>
    </div>

    <!-- 项目仪表盘默认落点（P-20261005-224）：进项目的首个主区视图。
         editor = 历史现状；dashboard = 显式进入项目先看状态一屏（刷新恢复/
         页内跳转不落，文件深链/其他主区视图让位） -->
    <div
      class="form-group"
      data-testid="settings-dashboard-landing"
    >
      <div class="form-label">
        {{ t('appearance.dashboardLanding.label') }}
      </div>
      <div class="ctrl-row">
        <n-radio-group
          v-model:value="pendingDashboardLanding"
          size="small"
        >
          <n-radio-button
            v-for="opt in dashboardLandingOptions"
            :key="String(opt.value)"
            :value="opt.value"
            :label="opt.label()"
          />
        </n-radio-group>
        <SettingModifiedMark
          :modified="pendingDashboardLanding"
          @restore="pendingDashboardLanding = false"
        />
      </div>
      <div class="follow-hint">
        {{ t('appearance.dashboardLanding.hint') }}
      </div>
    </div>

    <!-- 界面字体族：brand = 打包的 Geist/Inter（跨机器一致）；system = 系统栈 -->
    <div class="form-group">
      <div class="form-label">
        {{ t('settings.uiFont') }}
      </div>
      <div class="ctrl-row">
        <n-select
          v-model:value="pendingUiFont"
          :options="uiFontOptions.map(o => ({ label: o.label(), value: o.value }))"
        />
        <SettingModifiedMark
          :modified="pendingUiFont !== fontStore.UI_FONT_DEFAULT"
          @restore="pendingUiFont = fontStore.UI_FONT_DEFAULT"
        />
      </div>
    </div>

    <!-- 终端主题 -->
    <div class="form-group">
      <div class="form-label">
        {{ t('settings.terminalTheme.sectionTitle') }}
      </div>
      <!-- 跟随应用明暗开关（P-20261002-144）：开启时下方卡片为「解绑后生效的手工选择」 -->
      <label
        class="setting-row terminal-follow-row"
        data-testid="terminal-theme-follow"
      >
        <n-checkbox
          v-model:checked="pendingTerminalFollow"
          size="small"
        />
        <span class="setting-meta">{{ t('terminal.themeFollow.label') }}</span>
        <SettingModifiedMark
          :modified="pendingTerminalFollow !== TERMINAL_THEME_FOLLOW_DEFAULT"
          @restore="pendingTerminalFollow = TERMINAL_THEME_FOLLOW_DEFAULT"
        />
      </label>
      <div class="follow-hint">
        {{ t('terminal.themeFollow.tip') }}
      </div>
      <div class="terminal-theme-grid">
        <button
          v-for="opt in terminalThemeOptions"
          :key="opt.value"
          class="terminal-theme-card"
          :class="{ active: pendingTerminalTheme === opt.value }"
          :data-effects-scanline="opt.scanline"
          :data-effects-corner="opt.cornerBrackets ? 'true' : 'false'"
          :data-effects-vignette="opt.vignette ? 'true' : 'false'"
          :data-effects-starfield="opt.starfield ? 'true' : 'false'"
          :style="{ background: opt.bg, color: opt.fg, borderColor: opt.accent + '55', '--term-accent': opt.accent }"
          @click="pickTerminalTheme(opt.value)"
        >
          <div class="ttc-preview">
            <div class="ttc-line">
              <span :style="{ color: opt.green }">user@host</span> <span :style="{ color: opt.accent }">~/codecombo</span>
            </div>
            <div class="ttc-line">
              $ npm run dev
            </div>
            <div
              class="ttc-line"
              :style="{ color: opt.fg, opacity: 0.7 }"
            >
              VITE ready in 312 ms
            </div>
            <div
              class="ttc-line"
              :style="{ color: opt.yellow }"
            >
              ➜  http://localhost:5173
            </div>
            <div class="ttc-line">
              <span :style="{ color: opt.green }">user@host</span> <span :style="{ color: opt.accent }">~/codecombo</span> ❯<span
                class="ttc-cursor"
                :style="{ background: opt.fg }"
              />
            </div>
          </div>
          <div class="ttc-name">
            {{ t(opt.label) }}
          </div>
        </button>
      </div>
    </div>

    <!-- 终端字体 -->
    <div
      class="form-group"
      data-testid="settings-terminal-font-family"
    >
      <div class="form-label">
        {{ t('settings.terminalFont.sectionTitle') }}
      </div>
      <div class="terminal-font-grid">
        <button
          v-for="opt in terminalFontOptions"
          :key="opt.value"
          class="terminal-font-card"
          :class="[opt.className, { active: pendingTerminalFont === opt.value }]"
          @click="pendingTerminalFont = opt.value"
        >
          <div class="tfc-sample">
            AaBb01 → { } !=
          </div>
          <div class="tfc-name">
            {{ opt.label }}
          </div>
        </button>
      </div>
      <!-- 自定义等宽字体名（P-20261005-227）：空 = 内置栈缺省；应用写
           --font-mono-lead 前插段，全局等宽消费面（code/pre/Monaco/xterm）一处生效 -->
      <div class="slider-row" data-testid="settings-mono-font-name">
        <span class="slider-label">{{ t('settings.monoFontName.label') }}</span>
        <n-input
          v-model:value="pendingMonoFontName"
          class="mono-font-input"
          size="small"
          :placeholder="t('settings.monoFontName.placeholder')"
          :maxlength="MONO_FONT_NAME_MAX_LENGTH"
        />
        <SettingModifiedMark
          :modified="pendingMonoFontName !== fontStore.MONO_FONT_NAME_DEFAULT"
          @restore="pendingMonoFontName = fontStore.MONO_FONT_NAME_DEFAULT"
        />
      </div>
      <!-- 预览行：随输入实时渲染（未保存也所见即所得）；.mono 类走连字开关的
           真实消费路径（terminal-effects.css data-ligatures='off' 覆盖 .mono），
           两个设置项的效果在此同框可验 -->
      <div
        class="mono-font-preview mono"
        data-testid="settings-mono-font-preview"
        :style="{ '--mono-preview-family': monoFontPreviewFamily }"
      >
        const lig = (a: int) => a !== 0; // 0O 1lI -> => !==
      </div>
      <div class="ctrl-row">
        <n-checkbox
          v-model:checked="pendingTerminalLigaturesBool"
          class="ligature-toggle"
        >
          {{ t('settings.terminalLigatures') }}
        </n-checkbox>
        <SettingModifiedMark
          :modified="pendingTerminalLigatures !== fontStore.TERMINAL_LIGATURES_DEFAULT"
          @restore="pendingTerminalLigatures = fontStore.TERMINAL_LIGATURES_DEFAULT"
        />
      </div>
      <!-- 连字联动说明（④）：开关只切 calt/liga 特性不补偿字形——自定义字体
           需自带连字字形，没有就只是不显示合字，不报错不降级 -->
      <div class="follow-hint" data-testid="settings-mono-font-ligature-tip">
        {{ t('settings.monoFontName.ligatureTip') }}
      </div>
    </div>

    <!-- 语言 -->
    <div class="form-group">
      <div class="form-label">
        {{ t('layout.language') }}
      </div>
      <div class="ctrl-row">
        <n-select
          v-model:value="pendingLocale"
          :options="localeOptions"
          size="small"
        />
        <SettingModifiedMark
          :modified="pendingLocale !== LOCALE_DEFAULT"
          @restore="pendingLocale = LOCALE_DEFAULT"
        />
      </div>
    </div>

    <!-- 字体大小 -->
    <div class="form-group">
      <div class="form-label-row">
        <span>{{ t('layout.fontSize') }}</span>
        <n-button
          size="tiny"
          quaternary
          @click="fontStore.reset()"
        >
          {{ t('layout.resetDefault') }}
        </n-button>
      </div>
      <div class="font-sliders">
        <div
          v-for="item in fontItems"
          :key="item.key"
          class="slider-row"
        >
          <span class="slider-label">{{ item.label() }}</span>
          <input
            type="range"
            :value="item.val()"
            min="10"
            max="32"
            step="1"
            class="font-slider"
            @input="fontStore.setSize(item.key, parseInt(($event.target as HTMLInputElement).value))"
          >
          <span class="slider-value">{{ item.val() }}px</span>
          <SettingModifiedMark
            :modified="item.val() !== fontStore.FONT_DEFAULTS[item.key]"
            @restore="fontStore.setSize(item.key, fontStore.FONT_DEFAULTS[item.key])"
          />
        </div>
      </div>
    </div>

    <!-- 编辑器设置 -->
    <div class="form-group">
      <div class="form-label">
        {{ t('settings.editorSettings') }}
      </div>
      <!-- 行高倍率（P-20261006-7，对标 VS Code editor.lineHeight）：排版密度的独立
           维度——字号旁邻位；倍率制随字号联动（生效行高 = 生效字号 × 倍率），
           renderWhitespace 同款 select 控件形态，直写行即时生效不参与脏护栏 -->
      <div class="slider-row" data-testid="settings-editor-line-height">
        <span class="slider-label">{{ t('settings.lineHeight') }}</span>
        <n-select
          :value="fontStore.editor.lineHeightMultiplier"
          size="small"
          style="width: 100px"
          :options="LINE_HEIGHT_MULTIPLIERS.map((m) => ({ label: m.toFixed(1), value: m }))"
          @update:value="fontStore.updateEditor('lineHeightMultiplier', $event)"
        />
        <SettingModifiedMark
          :modified="fontStore.editor.lineHeightMultiplier !== fontStore.EDITOR_DEFAULTS.lineHeightMultiplier"
          @restore="fontStore.updateEditor('lineHeightMultiplier', fontStore.EDITOR_DEFAULTS.lineHeightMultiplier)"
        />
      </div>
      <div class="slider-row">
        <span class="slider-label">{{ t('settings.tabSize') }}</span>
        <n-select
          :value="fontStore.editor.tabSize"
          size="small"
          style="width: 100px"
          :options="[{ label: '2', value: 2 }, { label: '4', value: 4 }, { label: '8', value: 8 }]"
          @update:value="fontStore.updateEditor('tabSize', $event)"
        />
        <SettingModifiedMark
          :modified="fontStore.editor.tabSize !== fontStore.EDITOR_DEFAULTS.tabSize"
          @restore="fontStore.updateEditor('tabSize', fontStore.EDITOR_DEFAULTS.tabSize)"
        />
      </div>
      <!-- 缩进来源优先级注记（P-20261003-95）：项目根 .editorconfig 覆盖此处的
           全局缩进设置——全局值是缺省底座，约定先行是跨编辑器格式惯例 -->
      <div class="follow-hint" data-testid="settings-editorconfig-note">
        {{ t('settings.editorconfigNote') }}
      </div>
      <div class="slider-row">
        <span class="slider-label">{{ t('settings.wordWrap') }}</span>
        <n-select
          :value="fontStore.editor.wordWrap"
          size="small"
          style="width: 100px"
          :options="[{ label: t('settings.off'), value: 'off' }, { label: t('settings.on'), value: 'on' }]"
          @update:value="fontStore.updateEditor('wordWrap', $event)"
        />
        <SettingModifiedMark
          :modified="fontStore.editor.wordWrap !== fontStore.EDITOR_DEFAULTS.wordWrap"
          @restore="fontStore.updateEditor('wordWrap', fontStore.EDITOR_DEFAULTS.wordWrap)"
        />
      </div>
      <div class="slider-row">
        <span class="slider-label">{{ t('settings.renderWhitespace') }}</span>
        <n-select
          :value="fontStore.editor.renderWhitespace"
          size="small"
          style="width: 100px"
          :options="[{ label: t('settings.none'), value: 'none' }, { label: t('settings.selection'), value: 'selection' }, { label: t('settings.all'), value: 'all' }]"
          @update:value="fontStore.updateEditor('renderWhitespace', $event)"
        />
        <SettingModifiedMark
          :modified="fontStore.editor.renderWhitespace !== fontStore.EDITOR_DEFAULTS.renderWhitespace"
          @restore="fontStore.updateEditor('renderWhitespace', fontStore.EDITOR_DEFAULTS.renderWhitespace)"
        />
      </div>
      <!-- 括号对彩色化（P-20261006-9）：whitespace 控件邻位；markdown 域恒关
           （语言差异与开关正交），文案如实说明 -->
      <label
        class="setting-row"
        data-testid="settings-bracket-color"
      >
        <n-checkbox
          :checked="fontStore.editor.bracketColor"
          size="small"
          @update:checked="fontStore.updateEditor('bracketColor', $event)"
        />
        <span class="setting-meta">{{ t('settings.bracketColor') }}</span>
        <SettingModifiedMark
          :modified="fontStore.editor.bracketColor !== fontStore.EDITOR_DEFAULTS.bracketColor"
          @restore="fontStore.updateEditor('bracketColor', fontStore.EDITOR_DEFAULTS.bracketColor)"
        />
      </label>
      <!-- 小地图行（P-20261003-171）：修改标记 + 单行恢复默认的锚点用例行；
           直写行——恢复即写 store 即时生效，不参与 isDirty 脏护栏 -->
      <label
        class="setting-row"
        data-testid="settings-minimap"
      >
        <n-checkbox
          :checked="fontStore.editor.minimap"
          size="small"
          @update:checked="fontStore.updateEditor('minimap', $event)"
        />
        <span class="setting-meta">{{ t('settings.minimapShow') }}</span>
        <SettingModifiedMark
          :modified="fontStore.editor.minimap !== fontStore.EDITOR_DEFAULTS.minimap"
          @restore="fontStore.updateEditor('minimap', fontStore.EDITOR_DEFAULTS.minimap)"
        />
      </label>
      <label class="setting-row">
        <n-checkbox
          :checked="fontStore.editor.stickyScroll"
          size="small"
          @update:checked="fontStore.updateEditor('stickyScroll', $event)"
        />
        <span class="setting-meta">{{ t('settings.stickyScroll') }}</span>
        <SettingModifiedMark
          :modified="fontStore.editor.stickyScroll !== fontStore.EDITOR_DEFAULTS.stickyScroll"
          @restore="fontStore.updateEditor('stickyScroll', fontStore.EDITOR_DEFAULTS.stickyScroll)"
        />
      </label>
      <div class="slider-row">
        <span class="slider-label">{{ t('editor.autoSave.label') }}</span>
        <n-select
          :value="fontStore.editor.autoSave"
          size="small"
          style="width: 140px"
          :options="autoSaveOptions.map(o => ({ label: o.label(), value: o.value }))"
          @update:value="fontStore.updateEditor('autoSave', $event)"
        />
        <SettingModifiedMark
          :modified="fontStore.editor.autoSave !== fontStore.EDITOR_DEFAULTS.autoSave"
          @restore="fontStore.updateEditor('autoSave', fontStore.EDITOR_DEFAULTS.autoSave)"
        />
      </div>
      <div
        v-if="fontStore.editor.autoSave === 'afterDelay'"
        class="slider-row"
      >
        <span class="slider-label">{{ t('editor.autoSave.delayLabel') }}</span>
        <n-input-number
          :value="fontStore.editor.autoSaveDelayMs"
          size="small"
          style="width: 140px"
          :min="AUTOSAVE_DELAY_MIN"
          :max="AUTOSAVE_DELAY_MAX"
          :step="500"
          @update:value="onAutoSaveDelayInput"
        />
        <SettingModifiedMark
          :modified="fontStore.editor.autoSaveDelayMs !== AUTOSAVE_DELAY_DEFAULT"
          @restore="fontStore.setAutoSaveDelay(AUTOSAVE_DELAY_DEFAULT)"
        />
      </div>
      <!-- 保存时格式化（P-20261003-83）：与自动保存同区（保存行为族邻位），
           直写 store 即时生效；无 formatter 的语言静默跳过直接保存 -->
      <label
        class="setting-row"
        data-testid="settings-format-on-save"
        :title="t('editor.formatOnSave.tip')"
      >
        <n-checkbox
          :checked="fontStore.editor.formatOnSave"
          size="small"
          @update:checked="fontStore.updateEditor('formatOnSave', $event)"
        />
        <span class="setting-meta">{{ t('editor.formatOnSave.label') }}</span>
        <SettingModifiedMark
          :modified="fontStore.editor.formatOnSave !== fontStore.EDITOR_DEFAULTS.formatOnSave"
          @restore="fontStore.updateEditor('formatOnSave', fontStore.EDITOR_DEFAULTS.formatOnSave)"
        />
      </label>
      <!-- tab 按 git 状态着色（P-20261003-242）：直写 store 即时生效（tab 渲染
           响应式随动）；默认关——视觉克制，存量 tab 形态不变 -->
      <label
        class="setting-row"
        data-testid="settings-git-status-tabs"
        :title="t('editor.gitStatusTabs.tip')"
      >
        <n-checkbox
          :checked="fontStore.editor.gitStatusTabs"
          size="small"
          @update:checked="fontStore.updateEditor('gitStatusTabs', $event)"
        />
        <span class="setting-meta">{{ t('editor.gitStatusTabs.label') }}</span>
        <SettingModifiedMark
          :modified="fontStore.editor.gitStatusTabs !== fontStore.EDITOR_DEFAULTS.gitStatusTabs"
          @restore="fontStore.updateEditor('gitStatusTabs', fontStore.EDITOR_DEFAULTS.gitStatusTabs)"
        />
      </label>
    </div>

    <!-- 一键重置布局（P-20261002-74）：面板/宽度/树展开调乱后的自救出口，
         与命令面板「重置当前项目布局」同走 useLayoutReset -->
    <div class="layout-reset-section">
      <div class="lrs-title">
        {{ t('layout.reset.title') }}
      </div>
      <div class="lrs-desc">
        {{ t('layout.reset.desc') }}
      </div>
      <div class="lrs-actions">
        <n-button
          size="tiny"
          @click="resetLayoutWithConfirm"
        >
          {{ t('layout.reset.action') }}
        </n-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.appearance-settings {
  /* container */
}
/* 一键重置布局分区（P-20261002-74）：标题/说明/动作行，版式同 WorkspaceBackup 分区 */
.layout-reset-section {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--border-default);
}
.lrs-title {
  font-size: 13px;
  font-weight: var(--fw-medium);
  color: var(--text-body);
  margin-bottom: var(--space-1);
}
.lrs-desc {
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 10px;
}
.lrs-actions { display: flex; gap: var(--space-2); }
.form-group { margin-bottom: 18px; }
/* 缩放/密度/字体族/连字等控制行：flex 容器让行尾「已修改」标记推到右缘
 * （slider-row/setting-row 自带 flex 无需此壳，P-20261003-171） */
.ctrl-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.form-label {
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: var(--space-2);
}
.form-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-2);
  font-size: 12px;
  color: var(--text-dim);
}
.theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: var(--space-2);
}
.theme-card {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  background: var(--bg-elevated);
  cursor: pointer;
  padding: var(--space-2);
  transition: all var(--motion-base);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.theme-card:hover { border-color: var(--border-strong); }
.theme-card.active {
  border-color: var(--brand-accent);
  box-shadow: 0 0 0 1px var(--brand-accent);
}
.theme-preview {
  height: 36px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  display: flex;
  position: relative;
}
.tp-bar { height: 100%; }
.theme-name {
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--text-secondary);
  text-align: center;
}
.theme-card.active .theme-name { color: var(--brand-accent); font-weight: var(--fw-medium); }
.font-sliders { display: flex; flex-direction: column; gap: var(--space-2); }
.slider-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: 6px;
}
.slider-label {
  font-size: 12px;
  color: var(--text-dim);
  min-width: 80px;
}
.font-slider {
  flex: 1;
  accent-color: var(--brand-accent);
  height: 4px;
}
.slider-value {
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--text-secondary);
  min-width: 36px;
  text-align: center;
  font-family: var(--font-mono);
}
.setting-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: 10px;
  cursor: pointer;
  font-size: 12px;
}
.setting-meta { color: var(--text-body); }

/* 跟随应用明暗开关行 + 行为提示（与 setting-row 既有节奏对齐） */
.terminal-follow-row { margin-bottom: var(--space-1); }
.follow-hint {
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--text-dim);
  margin-bottom: 10px;
}

/* diff 色板预览条（P-20261006-5）：两片色 chip 走 --diff-added/--diff-removed
 * 真实消费变量（与 DiffViewer 行底/边条同源），切档即时换色即操作反馈 */
.diff-palette-preview {
  display: flex;
  gap: 6px;
  margin: var(--space-2) 0 var(--space-1);
}
.dpp-chip {
  font-family: var(--font-mono);
  font-size: var(--fs-meta-min, 11.5px);
  padding: 3px 10px;
  border-radius: var(--radius-sm);
  white-space: pre;
}
.dpp-add {
  color: var(--diff-added);
  background: color-mix(in srgb, var(--diff-added) 15%, transparent);
  border-left: 3px solid var(--diff-added);
}
.dpp-del {
  color: var(--diff-removed);
  background: color-mix(in srgb, var(--diff-removed) 15%, transparent);
  border-left: 3px solid var(--diff-removed);
}

/* 终端主题卡片 */
.terminal-theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: var(--space-2);
}
.terminal-theme-card {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: var(--space-2);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: border-color var(--motion-base), transform var(--motion-fast);
  /* 让 [data-effects-*] 伪元素正确定位 */
  position: relative;
  overflow: hidden;
}
.terminal-theme-card:hover {
  border-color: var(--border-strong);
}
/* 主题/字体卡片键盘焦点反馈 */
.terminal-theme-card:focus-visible,
.terminal-font-card:focus-visible {
  outline: 2px solid var(--accent-blue);
  outline-offset: 2px;
}
.terminal-theme-card.active {
  border-color: var(--brand-accent) !important;
  box-shadow: 0 0 0 1px var(--brand-accent);
}
.ttc-preview {
  font-family: var(--font-mono, monospace);
  font-size: var(--fs-meta-min, 11.5px);
  line-height: 1.4;
  padding: 6px;
  border-radius: var(--radius-sm);
  background: rgba(0, 0, 0, 0.2);
  /* 预览行为装饰性内容：行宽超出窄卡片时右缘淡出，替代硬切字形 */
  overflow: hidden;
  -webkit-mask-image: linear-gradient(90deg, #000 82%, transparent 98%);
  mask-image: linear-gradient(90deg, #000 82%, transparent 98%);
}
.terminal-theme-card:not([class*="active"]) .ttc-preview {
  background: rgba(128, 128, 128, 0.1);
}
.ttc-line { white-space: pre; }
.ttc-cursor {
  display: inline-block;
  width: 6px;
  height: 11px;
  vertical-align: middle;
}
.ttc-name {
  font-size: 12px;
  text-align: center;
  color: var(--text-body);
}

/* 终端字体卡片 */
.terminal-font-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: var(--space-2);
}
.terminal-font-card {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: var(--space-3) 10px;
  cursor: pointer;
  background: var(--bg-canvas);
  transition: border-color var(--motion-base), transform var(--motion-fast);
}
.terminal-font-card:hover { border-color: var(--border-strong); }
.terminal-font-card.active {
  border-color: var(--brand-accent);
  box-shadow: 0 0 0 1px var(--brand-accent);
}
.tfc-sample {
  font-size: 14px;
  margin-bottom: 6px;
  color: var(--text-body);
  font-family: var(--font-mono, monospace);
}
.terminal-font-jetbrains .tfc-sample { font-family: 'JetBrains Mono', monospace; }
.terminal-font-cascadia .tfc-sample { font-family: 'Cascadia Code', monospace; }
.terminal-font-ibmplex .tfc-sample { font-family: 'IBM Plex Mono', monospace; }
.tfc-name {
  font-size: var(--fs-meta-min, 11.5px);
  text-align: center;
  color: var(--text-dim);
}

/* 自定义等宽字体名输入行 + 预览行（P-20261005-227）：输入行沿用 slider-row
 * 版式；预览 font-family 走 --mono-preview-family（模板按 pending 实时绑定，
 * 缺省回 var(--font-mono) 内置栈） */
.mono-font-input { flex: 1; }
.mono-font-preview {
  font-family: var(--mono-preview-family, var(--font-mono));
  font-size: 13px;
  color: var(--text-secondary);
  background: var(--bg-canvas);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  margin-bottom: var(--space-2);
  white-space: pre;
  overflow: hidden;
}
</style>
