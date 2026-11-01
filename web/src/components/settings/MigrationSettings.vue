<script setup lang="ts">
/**
 * 设置·迁移分区（P-20261003-147）：换机/迁实例的一次性迁移向导，双卡片
 * 双向——导出（模式→选块→[全量:逐项目]→口令→确认下载）与导入（选文件+
 * 口令→预览勾选/策略→应用→结果报告→引导闭环）。三段式 preview/apply 分离
 * 由服务端承担（一次性票据 30min，包本体不重传）；口令纯人工输入，永不过
 * agent 通道（手册「迁移纯人工」纪律的 UI 侧落点：本分区无任何 agent 代操作
 * 入口）。即时操作分区：无暂存无保存按钮（SettingsModal SAVE_TABS 之外）。
 */
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { NAlert, NButton, NCheckbox, NInput, NSelect, NTag, useMessage } from 'naive-ui'
import { DownloadOutline, CloudDownloadOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { usePanelLayout } from '../../composables/usePanelLayout'
import { useProjectStore } from '../../stores/project'
import { syncApi, type SyncUnitEntry } from '../../api/domains/sync'
import {
  migrationApi,
  type MigrationApplyReport,
  type MigrationBlockPolicy,
  type MigrationBlocks,
  type MigrationPreview,
  type MigrationSettingsPolicy,
} from '../../api/domains/migration'
import {
  MIGRATION_BLOCK_KEYS, migrationBlockLabelKey, migrationDownloadName,
  migrationFormatBytes, passphraseStrength, passphraseStrengthKey, projectOversize,
} from '../../utils/migration'
import { createDownloadProgressTracker } from '../../utils/downloadProgress'

const props = defineProps<{ show: boolean }>()
const { t } = useI18n()
const message = useMessage()
const router = useRouter()
const panelLayout = usePanelLayout()
const projectStore = useProjectStore()

// ── 导出：选块（缺省全选）─────────────────────────────────────────────
const expMode = ref<'light' | 'full'>('light')
const expBlocks = ref<MigrationBlocks>({ credentials: true, tokens: true, settings: true, instances: true })
const anyBlock = computed(() => MIGRATION_BLOCK_KEYS.some(k => expBlocks.value[k]))

// ── 导出：全量包逐项目勾选（manifest 枚举既有复用——体积预估同源）─────
interface ExpProject {
  key: string
  projectId: string
  name: string
  size: number
  files: number
  checked: boolean
  includeGit: boolean
}
const expProjects = ref<ExpProject[]>([])
const projectsLoading = ref(false)
const expGlobalContexts = ref(false)
const expAcceptOversize = ref(false)
/** 全量模式至少要有一项内容（服务端对空单元包 400——前端同口径前置拦下） */
const expHasUnits = computed(() =>
  expGlobalContexts.value || expProjects.value.some(p => p.checked))

/** 超阈值勾选项目（黄条警示面） */
const oversizeChecked = computed(() => expProjects.value.filter(p => p.checked && projectOversize(p.size)))
const expTotalBytes = computed(() => expProjects.value.reduce((s, p) => s + (p.checked ? p.size : 0), 0))

async function loadProjects(): Promise<void> {
  if (projectsLoading.value) return
  projectsLoading.value = true
  try {
    const res = await syncApi.manifest()
    const units: SyncUnitEntry[] = res.data?.units ?? []
    // 项目 id 关联：manifest 单元键是基名——与项目注册表按 basename 匹配
    //（SyncCenterPanel 同款写法；找不到注册记录的项目不可勾选导出——服务端
    // 按 projectId 解析，缺 id 的单元无导出资格）
    const prev = new Map(expProjects.value.map(p => [p.projectId, p]))
    expProjects.value = units
      .filter(u => u.kind === 'project' && u.exists)
      .map(u => {
        const base = u.key.slice('project:'.length)
        const proj = projectStore.projects.find(p => basename(p.path) === base)
        const old = proj ? prev.get(proj.id) : undefined
        return {
          key: u.key,
          projectId: proj?.id ?? '',
          name: u.name || base,
          size: u.size,
          files: u.files,
          checked: old ? old.checked : !!proj,
          includeGit: old ? old.includeGit : false,
        }
      })
      .filter(p => p.projectId !== '')
  } catch {
    // manifest 失败：项目选择面保持空，下载按钮被全量模式校验拦下
    expProjects.value = []
  } finally {
    projectsLoading.value = false
  }
}

/** 路径基名（两种分隔符都剥、尾分隔符去除——跨平台，服务端 rootBasename 同语义） */
function basename(p: string): string {
  const n = p.replace(/\\/g, '/').replace(/\/+$/, '')
  const i = Math.max(n.lastIndexOf('/'), 0)
  return i > 0 ? n.slice(i + 1) : n
}

// ── 导出：口令与确认 ─────────────────────────────────────────────────
const expPass = ref('')
const expPass2 = ref('')
const expBusy = ref(false)
const strength = computed(() => passphraseStrength(expPass.value))
const passMismatch = computed(() => expPass.value.length > 0 && expPass.value !== expPass2.value)
const expReady = computed(() =>
  anyBlock.value
  && strength.value.ok
  && !passMismatch.value
  && (expMode.value === 'light' || (expHasUnits.value && (expAcceptOversize.value || oversizeChecked.value.length === 0))),
)

async function onExport(): Promise<void> {
  if (expBusy.value || !expReady.value) return
  expBusy.value = true
  // 下载进度驻留 toast（P-20261030-2）：.scpkg 信封须服务端加密封装后出流，
  // 不可直链——blob 保留但 onDownloadProgress 把全量包接收期可见化（百分比 +
  // 速率）。进度只覆盖「下载阶段」，加密/封装是服务端紧随其后的瞬时动作；
  // 终态提示归下方既有 exportDone/拦截器文案
  const tracker = createDownloadProgressTracker(message, t('settings.migration.exportProgress'))
  try {
    const blob = await migrationApi.export({
      mode: expMode.value,
      passphrase: expPass.value,
      blocks: { ...expBlocks.value },
      projects: expMode.value === 'full'
        ? expProjects.value.filter(p => p.checked).map(p => ({
            projectId: p.projectId, key: p.key, name: p.name,
            includeGit: p.includeGit, includeContexts: false,
          }))
        : undefined,
      globalContexts: expMode.value === 'full' ? expGlobalContexts.value : undefined,
    }, { onDownloadProgress: tracker.onProgress })
    // blob 保存（fetch 流式响应 → Blob 保存惯例；导出已服务端流式，不落盘）
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = migrationDownloadName()
    a.click()
    URL.revokeObjectURL(url)
    message.success(t('settings.migration.exportDone'), { duration: 6000 })
    message.warning(t('settings.migration.keepSafe'), { duration: 10000 })
    expPass.value = ''
    expPass2.value = ''
    expAcceptOversize.value = false
  } catch {
    // axios 拦截器已弹全局错误 toast；就地保持表单便于重试
  } finally {
    tracker.settle()
    expBusy.value = false
  }
}

// ── 导入：文件 + 口令 → 预览 ─────────────────────────────────────────
const impFile = ref<File | null>(null)
const impPass = ref('')
const impBusy = ref(false)
const preview = ref<MigrationPreview | null>(null)

function onFileChange(e: Event): void {
  const input = e.target as HTMLInputElement
  impFile.value = input.files?.[0] ?? null
  preview.value = null // 换文件旧预览作废（票据与包绑定）
  report.value = null
}

async function onPreview(): Promise<void> {
  if (impBusy.value || !impFile.value || !impPass.value) return
  impBusy.value = true
  try {
    const res = await migrationApi.preview(impFile.value, impPass.value)
    preview.value = res.data ?? null
    initPolicies()
  } catch {
    // 统一失败文案走全局拦截器（错口令/损坏文件同文案防 oracle）
  } finally {
    impBusy.value = false
  }
}

// ── 导入：逐块策略（预览页可再勾选——块级 + 项目级）─────────────────
const credPolicy = ref<MigrationBlockPolicy>('merge')
const instPolicy = ref<MigrationBlockPolicy>('merge')
const tokPolicy = ref<MigrationBlockPolicy>('merge')
const setPolicy = ref<MigrationSettingsPolicy>('package')
const impProjectKeys = ref<Set<string>>(new Set())
const impBusyApply = ref(false)
const report = ref<MigrationApplyReport | null>(null)

const policyOptions = computed(() => [
  { label: t('settings.migration.policy.merge'), value: 'merge' },
  { label: t('settings.migration.policy.overwrite'), value: 'overwrite' },
  { label: t('settings.migration.policy.skip'), value: 'skip' },
])
const settingsPolicyOptions = computed(() => [
  { label: t('settings.migration.policy.package'), value: 'package' },
  { label: t('settings.migration.policy.local'), value: 'local' },
])

function initPolicies(): void {
  report.value = null
  const b = preview.value?.blocks
  credPolicy.value = b?.credentials ? 'merge' : 'skip'
  instPolicy.value = b?.instances ? 'merge' : 'skip'
  tokPolicy.value = b?.tokens ? 'merge' : 'skip'
  setPolicy.value = b?.settings ? 'package' : 'local'
  impProjectKeys.value = new Set(
    (preview.value?.content?.units ?? []).filter(u => u.kind === 'project').map(u => u.key),
  )
}

const impReady = computed(() => !!preview.value && Object.values(policyMap.value).some(v => v !== 'skip' && v !== 'local'))

const policyMap = computed<Record<string, string>>(() => ({
  credentials: credPolicy.value,
  instances: instPolicy.value,
  tokens: tokPolicy.value,
  settings: setPolicy.value,
}))

async function onApply(): Promise<void> {
  if (impBusyApply.value || !preview.value || !impReady.value) return
  impBusyApply.value = true
  try {
    const res = await migrationApi.apply({
      ticket: preview.value.ticket,
      blocks: policyMap.value,
      projects: preview.value.mode === 'full' ? [...impProjectKeys.value] : undefined,
    })
    report.value = res.data ?? null
    if (report.value && !report.value.error && !report.value.rolledBack) {
      message.success(t('settings.migration.applyDone'))
    }
  } catch {
    // 全局拦截器已弹错（回滚失败语义在 report/error 双通道）
  } finally {
    impBusyApply.value = false
  }
}

// ── 引导闭环（方案⑤）：对端实例 → 一键首同步；锁密码首设；令牌轮换 ──
function openSyncCenter(): void {
  // 同步中心是项目页侧栏视图（HomeView openSyncCenter 同款三步）
  panelLayout.sideView.value = 'sync'
  panelLayout.showSidePanel.value = true
  if (router.currentRoute.value.name !== 'project') router.push({ name: 'project' })
}

const showPeerGuide = computed(() => (report.value?.peerCount ?? 0) > 0)
const showLockGuide = computed(() => policyMap.value.settings === 'package' && (report.value?.blocks?.settings?.imported ?? 0) > 0)
const showTokenGuide = computed(() => policyMap.value.tokens === 'merge' || policyMap.value.tokens === 'overwrite')

// 打开分区即预取项目清单（全量档选择面数据源）；关闭清敏感输入
watch(() => props.show, (v) => {
  if (v && expMode.value === 'full') void loadProjects()
})
watch(expMode, (m) => {
  if (m === 'full') void loadProjects()
})

</script>

<template>
  <div
    class="migration-settings"
    data-testid="settings-migration"
  >
    <!-- ══ 导出卡片 ══ -->
    <section
      class="mig-card"
      data-testid="settings-migration-export"
    >
      <h4 class="mig-title">
        <span>{{ t('settings.migration.exportTitle') }}</span>
        <span class="mig-sub">{{ t('settings.migration.exportSub') }}</span>
      </h4>

      <!-- 模式 -->
      <div class="mig-row">
        <label class="mig-label">{{ t('settings.migration.modeLabel') }}</label>
        <div class="mig-mode-group">
          <button
            type="button"
            class="mig-mode"
            :class="{ active: expMode === 'light' }"
            data-testid="settings-migration-mode-light"
            @click="expMode = 'light'"
          >
            <b>{{ t('settings.migration.modeLight') }}</b>
            <span>{{ t('settings.migration.modeLightDesc') }}</span>
          </button>
          <button
            type="button"
            class="mig-mode"
            :class="{ active: expMode === 'full' }"
            data-testid="settings-migration-mode-full"
            @click="expMode = 'full'"
          >
            <b>{{ t('settings.migration.modeFull') }}</b>
            <span>{{ t('settings.migration.modeFullDesc') }}</span>
          </button>
        </div>
      </div>

      <!-- 配置四块 -->
      <div class="mig-row">
        <label class="mig-label">{{ t('settings.migration.blocksTitle') }}</label>
        <div class="mig-blocks">
          <NCheckbox
            v-for="k in MIGRATION_BLOCK_KEYS"
            :key="k"
            v-model:checked="expBlocks[k]"
            size="small"
            :data-test="'settings-migration-block-' + k"
          >
            {{ t(migrationBlockLabelKey(k)) }}
          </NCheckbox>
        </div>
      </div>

      <!-- 全量包：逐项目勾选 -->
      <div
        v-if="expMode === 'full'"
        class="mig-row"
        data-testid="settings-migration-projects"
      >
        <label class="mig-label">
          {{ t('settings.migration.projectsTitle') }}
          <span
            v-if="expTotalBytes > 0"
            class="mig-meta"
          >{{ migrationFormatBytes(expTotalBytes) }}</span>
        </label>
        <div
          v-if="projectsLoading"
          class="mig-meta"
        >
          {{ t('settings.migration.loading') }}
        </div>
        <div
          v-else-if="expProjects.length === 0"
          class="mig-meta"
        >
          {{ t('settings.migration.noProjects') }}
        </div>
        <ul
          v-else
          class="mig-proj-list"
        >
          <li
            v-for="p in expProjects"
            :key="p.key"
            class="mig-proj"
          >
            <NCheckbox
              v-model:checked="p.checked"
              size="small"
              :data-test="'settings-migration-proj-' + p.name"
            >
              <span class="mig-proj-name">{{ p.name }}</span>
            </NCheckbox>
            <span class="mig-meta">{{ migrationFormatBytes(p.size) }} · {{ t('settings.migration.filesCount', { n: p.files }) }}</span>
            <NCheckbox
              v-model:checked="p.includeGit"
              size="small"
              class="mig-proj-git"
              :data-test="'settings-migration-git-' + p.name"
            >
              {{ t('settings.migration.includeGit') }}
            </NCheckbox>
          </li>
        </ul>
        <NCheckbox
          v-model:checked="expGlobalContexts"
          size="small"
          class="mig-global"
          data-test="settings-migration-global-contexts"
        >
          {{ t('settings.migration.globalContexts') }}
        </NCheckbox>
        <NAlert
          v-if="oversizeChecked.length > 0"
          type="warning"
          class="mig-alert"
          :show-icon="false"
        >
          <div>{{ t('settings.migration.oversizeWarn', { names: oversizeChecked.map(p => p.name).join(', ') }) }}</div>
          <NCheckbox
            v-model:checked="expAcceptOversize"
            size="small"
            class="mig-oversize-accept"
            data-test="settings-migration-oversize-accept"
          >
            {{ t('settings.migration.oversizeAccept') }}
          </NCheckbox>
        </NAlert>
      </div>

      <!-- 口令 -->
      <div class="mig-row">
        <label class="mig-label">{{ t('settings.migration.passphrase') }}</label>
        <div class="mig-pass">
          <NInput
            v-model:value="expPass"
            type="password"
            show-password-on="click"
            size="small"
            :placeholder="t('settings.migration.passPlaceholder')"
            :data-test="'settings-migration-pass'"
          />
          <NInput
            v-model:value="expPass2"
            type="password"
            show-password-on="click"
            size="small"
            :placeholder="t('settings.migration.passPlaceholder2')"
            :status="passMismatch ? 'error' : undefined"
            data-test="settings-migration-pass2"
          />
          <div class="mig-strength">
            <span
              v-for="i in 3"
              :key="i"
              class="mig-strength-bar"
              :class="{ on: strength.score >= i }"
            />
            <span class="mig-meta">{{ t(passphraseStrengthKey(strength.score)) }}</span>
          </div>
        </div>
      </div>

      <div class="mig-actions">
        <NButton
          size="small"
          type="primary"
          :loading="expBusy"
          :disabled="!expReady"
          data-test="settings-migration-export-btn"
          @click="onExport"
        >
          <template #icon>
            <DownloadOutline />
          </template>
          {{ t('settings.migration.exportBtn') }}
        </NButton>
        <span class="mig-meta">{{ t('settings.migration.exportHint') }}</span>
      </div>
    </section>

    <!-- ══ 导入卡片 ══ -->
    <section
      class="mig-card"
      data-testid="settings-migration-import"
    >
      <h4 class="mig-title">
        <span>{{ t('settings.migration.importTitle') }}</span>
        <span class="mig-sub">{{ t('settings.migration.importSub') }}</span>
      </h4>

      <!-- 第一步：文件 + 口令 -->
      <div class="mig-row">
        <label class="mig-label">{{ t('settings.migration.pickPackage') }}</label>
        <div class="mig-pass">
          <input
            type="file"
            class="mig-file"
            data-test="settings-migration-file"
            @change="onFileChange"
          >
          <NInput
            v-model:value="impPass"
            type="password"
            show-password-on="click"
            size="small"
            :placeholder="t('settings.migration.passPlaceholder')"
            data-test="settings-migration-import-pass"
            @keydown.enter="onPreview"
          />
          <NButton
            size="small"
            :loading="impBusy"
            :disabled="!impFile || !impPass"
            data-test="settings-migration-preview-btn"
            @click="onPreview"
          >
            <template #icon>
              <CloudDownloadOutline />
            </template>
            {{ t('settings.migration.previewBtn') }}
          </NButton>
        </div>
      </div>

      <!-- 第二步：预览（逐块计数 + diff + 内容清单 + 策略） -->
      <template v-if="preview">
        <div
          class="mig-pkg-meta"
          data-test="settings-migration-pkg-meta"
        >
          <NTag
            size="small"
            :type="preview.mode === 'full' ? 'info' : 'default'"
          >
            {{ t('settings.migration.mode.' + preview.mode) }}
          </NTag>
          <span class="mig-meta">{{ t('settings.migration.fromHost', { host: preview.host }) }}</span>
          <span class="mig-meta">{{ new Date(preview.createdAt).toLocaleString() }}</span>
        </div>

        <!-- 配置块预览 + 策略 -->
        <div
          v-if="preview.credentials?.length"
          class="mig-block-preview"
        >
          <div class="mig-prev-head">
            <b>{{ t('settings.migration.blocks.credentials') }}</b>
            <NSelect
              v-model:value="credPolicy"
              size="tiny"
              :options="policyOptions"
              class="mig-policy"
              data-test="settings-migration-policy-credentials"
            />
          </div>
          <div
            v-for="row in preview.credentials"
            :key="row.kind + row.label"
            class="mig-prev-row"
          >
            <NTag size="tiny">
              {{ t('settings.migration.credKind.' + row.kind) }}
            </NTag>
            <span class="mig-prev-label">{{ row.label }}</span>
            <span class="mig-meta">{{ row.detail }}</span>
            <NTag
              v-if="row.exists"
              size="tiny"
              type="warning"
            >
              {{ t('settings.migration.existsLocal') }}
            </NTag>
          </div>
        </div>

        <div
          v-if="preview.hasAgentToken"
          class="mig-block-preview"
        >
          <div class="mig-prev-head">
            <b>{{ t('settings.migration.blocks.tokens') }}</b>
            <NSelect
              v-model:value="tokPolicy"
              size="tiny"
              :options="policyOptions"
              class="mig-policy"
              data-test="settings-migration-policy-tokens"
            />
          </div>
          <div class="mig-prev-row">
            <span class="mig-prev-label">{{ t('settings.migration.agentToken') }}</span>
          </div>
          <p class="mig-note">
            {{ t('settings.migration.tokenNote') }}
          </p>
        </div>

        <div
          v-if="preview.settingsDiff"
          class="mig-block-preview"
        >
          <div class="mig-prev-head">
            <b>{{ t('settings.migration.blocks.settings') }}</b>
            <NSelect
              v-model:value="setPolicy"
              size="tiny"
              :options="settingsPolicyOptions"
              class="mig-policy"
              data-test="settings-migration-policy-settings"
            />
          </div>
          <div
            v-if="preview.settingsDiff.length === 0"
            class="mig-meta mig-pad"
          >
            {{ t('settings.migration.settingsSame') }}
          </div>
          <div
            v-for="d in preview.settingsDiff.slice(0, 50)"
            :key="d.field"
            class="mig-prev-row"
          >
            <span class="mig-prev-label">{{ d.field }}</span>
            <span class="mig-diff-old">{{ d.local || '∅' }}</span>
            <span class="mig-diff-arrow">→</span>
            <span class="mig-diff-new">{{ d.incoming || '∅' }}</span>
          </div>
          <div
            v-if="preview.settingsDiff.length > 50"
            class="mig-meta mig-pad"
          >
            {{ t('settings.migration.diffTruncated', { n: preview.settingsDiff.length - 50 }) }}
          </div>
        </div>

        <div
          v-if="preview.instances?.length"
          class="mig-block-preview"
        >
          <div class="mig-prev-head">
            <b>{{ t('settings.migration.blocks.instances') }}</b>
            <NSelect
              v-model:value="instPolicy"
              size="tiny"
              :options="policyOptions"
              class="mig-policy"
              data-test="settings-migration-policy-instances"
            />
          </div>
          <div
            v-for="inRow in preview.instances"
            :key="inRow.id"
            class="mig-prev-row"
          >
            <span class="mig-prev-label">{{ inRow.name }}</span>
            <span class="mig-meta">{{ inRow.url }}</span>
            <NTag
              v-if="inRow.exists"
              size="tiny"
              type="warning"
            >
              {{ t('settings.migration.existsLocal') }}
            </NTag>
          </div>
        </div>

        <!-- 全量包内容档：项目级再勾选 -->
        <div
          v-if="preview.content"
          class="mig-block-preview"
        >
          <div class="mig-prev-head">
            <b>{{ t('settings.migration.contentTitle') }}</b>
            <span class="mig-meta">{{ migrationFormatBytes(preview.content.totalBytes) }}</span>
          </div>
          <p class="mig-note">
            {{ t('settings.migration.destHint', { root: preview.content.destRoot }) }}
          </p>
          <label
            v-for="u in preview.content.units.filter(u => u.kind === 'project')"
            :key="u.key"
            class="mig-prev-row mig-proj-pick"
          >
            <input
              v-model="impProjectKeys"
              type="checkbox"
              :value="u.key"
              :data-test="'settings-migration-imp-' + u.name"
            >
            <span class="mig-prev-label">{{ u.name }}</span>
            <span class="mig-meta">{{ migrationFormatBytes(u.size) }} → {{ u.destPath }}</span>
            <NTag
              v-if="u.includeGit"
              size="tiny"
            >.git</NTag>
          </label>
        </div>

        <div class="mig-actions">
          <NButton
            size="small"
            type="warning"
            :loading="impBusyApply"
            :disabled="!impReady"
            data-test="settings-migration-apply-btn"
            @click="onApply"
          >
            {{ t('settings.migration.applyBtn') }}
          </NButton>
          <span class="mig-meta">{{ t('settings.migration.applyHint') }}</span>
        </div>
      </template>

      <!-- 第三步：结果报告 + 引导闭环 -->
      <div
        v-if="report"
        class="mig-report"
        data-test="settings-migration-report"
      >
        <NAlert
          v-if="report.error"
          type="error"
          class="mig-alert"
          :show-icon="false"
        >
          {{ t('settings.migration.applyFailed') }}{{ report.error }}
          <template v-if="report.rolledBack">
            <div>{{ t('settings.migration.rolledBack') }}</div>
          </template>
        </NAlert>
        <NAlert
          v-else
          type="success"
          class="mig-alert"
          :show-icon="false"
        >
          {{ t('settings.migration.applyDone') }}
        </NAlert>
        <div
          v-for="(rep, blk) in report.blocks"
          :key="blk"
          class="mig-prev-row"
        >
          <span class="mig-prev-label">{{ t('settings.migration.blocks.' + blk) }}</span>
          <span class="mig-meta">
            {{ t('settings.migration.reportCounts', { ok: rep.imported, skip: rep.skipped, fail: rep.failed }) }}
          </span>
        </div>
        <template v-if="!report.error && !report.rolledBack">
          <div
            v-if="showPeerGuide"
            class="mig-guide"
          >
            <span>{{ t('settings.migration.peerGuide', { n: report.peerCount }) }}</span>
            <NButton
              size="tiny"
              data-test="settings-migration-open-sync"
              @click="openSyncCenter"
            >
              {{ t('settings.migration.openSync') }}
            </NButton>
          </div>
          <p
            v-if="showLockGuide"
            class="mig-note"
          >
            {{ t('settings.migration.lockGuide') }}
          </p>
          <p
            v-if="showTokenGuide"
            class="mig-note"
          >
            {{ t('settings.migration.rotateGuide') }}
          </p>
        </template>
      </div>
    </section>

    <p class="mig-footnote">
      {{ t('settings.migration.manualNote') }}
    </p>
  </div>
</template>

<style scoped>
.migration-settings {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.mig-card {
  border: 1px solid var(--bg-border);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
}

.mig-title {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin: 0 0 var(--space-2);
  font-size: 13px;
  font-weight: var(--fw-semibold);
}

.mig-sub {
  font-size: 12px;
  font-weight: var(--fw-normal);
  color: var(--text-color-3);
}

.mig-row {
  margin-bottom: var(--space-2);
}

.mig-label {
  display: block;
  font-size: 12px;
  color: var(--text-color-2);
  margin-bottom: 4px;
}

.mig-mode-group {
  display: flex;
  gap: var(--space-2);
}

.mig-mode {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 6px 10px;
  border: 1px solid var(--bg-border);
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.mig-mode.active {
  border-color: var(--primary-color, var(--text-color));
}

.mig-mode span {
  font-size: 11px;
  color: var(--text-color-3);
}

.mig-blocks {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.mig-proj-list {
  list-style: none;
  margin: 0 0 4px;
  padding: 0;
  max-height: 200px;
  overflow: auto;
}

.mig-proj {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 2px 0;
}

.mig-proj-name {
  font-size: 13px;
}

.mig-proj-git {
  margin-left: auto;
}

.mig-global {
  margin-top: 2px;
}

.mig-pass {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 360px;
}

.mig-file {
  font-size: 12px;
  max-width: 360px;
}

.mig-strength {
  display: flex;
  align-items: center;
  gap: 4px;
}

.mig-strength-bar {
  width: 40px;
  height: 4px;
  border-radius: 2px;
  background: var(--bg-border);
}

.mig-strength-bar.on {
  background: var(--primary-color, var(--text-color));
}

.mig-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.mig-meta {
  font-size: 12px;
  color: var(--text-color-3);
}

.mig-alert {
  margin-top: 6px;
}

.mig-oversize-accept {
  margin-top: 4px;
}

.mig-pkg-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.mig-block-preview {
  border: 1px solid var(--bg-border);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  margin-bottom: var(--space-2);
}

.mig-prev-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 12px;
  margin-bottom: 4px;
}

.mig-policy {
  margin-left: auto;
  width: 150px;
}

.mig-prev-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 2px 0;
  font-size: 12px;
}

.mig-prev-label {
  font-weight: var(--fw-semibold);
  min-width: 90px;
  word-break: break-all;
}

.mig-pad {
  padding: 2px 0;
}

.mig-diff-old {
  color: var(--text-color-3);
  word-break: break-all;
}

.mig-diff-arrow {
  color: var(--text-color-3);
}

.mig-diff-new {
  color: var(--text-color-2);
  word-break: break-all;
}

.mig-note {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--text-color-3);
}

.mig-proj-pick {
  cursor: pointer;
}

.mig-report {
  border-top: 1px dashed var(--bg-border);
  padding-top: var(--space-2);
}

.mig-guide {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
  font-size: 12px;
}

.mig-footnote {
  margin: 0;
  font-size: 11px;
  color: var(--text-color-3);
}
</style>
