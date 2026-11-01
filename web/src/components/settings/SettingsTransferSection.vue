<script setup lang="ts">
/**
 * 设置导出/导入（P-20261005-4，设置 → 通用）：多设备访问同一实例时把浏览器
 * 本地设置族（字号/编辑器外观/键位覆盖/语言/主题/通知本机偏好）打包迁移——
 * 导出聚合 utils/settingsTransfer 白名单键（零令牌/凭据/主机信息），下载 blob
 * JSON（CustomAgentsManager 同款链 + exportFileName 命名）；导入经文件选择 →
 * 解析（格式/版本门禁）→ 预览弹层（分节条数 + 与本机差异摘要，分节可勾选做
 * 部分导入——只迁键位不迁字号）→ 确认后逐节走各 store 既有 setter 应用
 * （消毒与响应性都经正门，不裸写 localStorage）。
 */
import { ref } from 'vue'
import { NButton, NCheckbox, NModal, NTag, useMessage } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { exportFileName } from '../../utils/exportFileName'
import { safeStorage } from '../../utils/storage'
import {
  SETTINGS_SECTION_KEYS, buildSettingsExportPayload, parseSettingsImport,
  sectionItems, countSectionDiffs, sanitizeFontPayload,
  type SettingsSectionKey, type SettingsImportParseResult,
} from '../../utils/settingsTransfer'
import { useFontStore, type FontSection } from '../../stores/font'
import { useKeymapStore, KEYMAP_ACTION_ORDER } from '../../stores/keymap'
import { useLocaleStore } from '../../stores/locale'
import type { LocaleKey } from '../../locales'
import { useThemeStore, THEME_SETTINGS_KEY } from '../../stores/theme'
import type { ThemeKey } from '../../themes'
import { useDndStore } from '../../stores/dnd'
import { useSoundStore } from '../../stores/sound'
import { useNotifySimpleStore } from '../../stores/notifySimple'
import { useNotifyScrollReadStore } from '../../stores/notifyScrollRead'
import type { DndWindow } from '../../utils/dndSchedule'

const { t } = useI18n()
const message = useMessage()

// ---- 导出 ---------------------------------------------------------------

function onExport() {
  // 与导出源同口径：读白名单存储键（缺失键 = 默认值不入包，theme 缺失 = OS 跟随）
  const payload = buildSettingsExportPayload(k => safeStorage.getItem(k))
  if (Object.keys(payload.sections).length === 0) {
    message.warning(t('settings.transfer.exportEmpty'))
    return
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = exportFileName('settings', new Date(), 'json', 'codecombo')
  a.click()
  URL.revokeObjectURL(url)
  message.success(t('settings.transfer.exportDone'))
}

// ---- 导入 ----------------------------------------------------------------

/** 预览条目：分节载荷 + 条数/差异摘要（摘要由 sectionItems 双侧投影算出） */
interface PreviewEntry {
  key: SettingsSectionKey
  value: unknown
  count: number
  diffCount: number
}

const fileRef = ref<HTMLInputElement | null>(null)
const showPreview = ref(false)
const previewEntries = ref<PreviewEntry[]>([])
/** 分节勾选（部分导入粒度；每次打开预览全选） */
const checked = ref<Record<SettingsSectionKey, boolean>>({ font: true, keymap: true, locale: true, theme: true, notify: true })
const applying = ref(false)

const SECTION_LABEL_KEYS: Record<SettingsSectionKey, string> = {
  font: 'settings.transfer.sectionFont',
  keymap: 'settings.transfer.sectionKeymap',
  locale: 'settings.transfer.sectionLocale',
  theme: 'settings.transfer.sectionTheme',
  notify: 'settings.transfer.sectionNotify',
}

/** 本机现值装配（与导出同构的形状，喂同一个 sectionItems 投影）：
 *  theme 读存储而非 store——OS 跟随态（未手动选择）不冒充用户选择 */
function currentSectionValue(key: SettingsSectionKey): unknown {
  switch (key) {
    case 'font': {
      const f = useFontStore()
      return { sizes: f.sizes, editor: f.editor, uiFont: f.uiFont, terminalLigatures: f.terminalLigatures, monoFontName: f.monoFontName, cursorStyle: f.cursorStyle, cursorBlink: f.cursorBlink }
    }
    case 'keymap':
      return useKeymapStore().overrides
    case 'locale':
      return useLocaleStore().currentLocale
    case 'theme':
      return safeStorage.getItem(THEME_SETTINGS_KEY)
    case 'notify':
      return {
        dnd: useDndStore().prefs,
        sound: useSoundStore().enabled,
        simple: useNotifySimpleStore().enabled,
        scrollRead: useNotifyScrollReadStore().enabled,
      }
  }
}

async function onImportFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // 允许重复选择同一文件
  if (!file) return
  let parsed: unknown
  try {
    parsed = JSON.parse(await file.text())
  } catch {
    message.error(t('settings.transfer.importInvalid'))
    return
  }
  const result: SettingsImportParseResult = parseSettingsImport(parsed)
  if (!result.ok) {
    message.error(result.reason === 'version'
      ? t('settings.transfer.importVersion')
      : t('settings.transfer.importInvalid'))
    return
  }
  const keys = SETTINGS_SECTION_KEYS.filter(k => result.sections[k] !== undefined)
  if (keys.length === 0) {
    message.warning(t('settings.transfer.importNone'))
    return
  }
  previewEntries.value = keys.map((key) => {
    const incoming = sectionItems(key, result.sections[key])
    const current = sectionItems(key, currentSectionValue(key))
    return {
      key,
      value: result.sections[key],
      count: Object.keys(incoming).length,
      diffCount: countSectionDiffs(incoming, current),
    }
  })
  checked.value = { font: true, keymap: true, locale: true, theme: true, notify: true }
  showPreview.value = true
}

// ---- 逐节应用（各 store setter 正门） -------------------------------------

function applyFont(value: unknown): void {
  const s = sanitizeFontPayload(value)
  const font = useFontStore()
  for (const [section, size] of Object.entries(s.sizes)) {
    font.setSize(section as FontSection, size)
  }
  if (s.editor.tabSize !== undefined) font.updateEditor('tabSize', s.editor.tabSize)
  for (const k of ['insertSpaces', 'minimap', 'stickyScroll', 'formatOnSave', 'gitStatusTabs', 'bracketColor'] as const) {
    const v = s.editor[k]
    if (typeof v === 'boolean') font.updateEditor(k, v)
  }
  if (s.editor.wordWrap) font.updateEditor('wordWrap', s.editor.wordWrap)
  if (s.editor.renderWhitespace) font.updateEditor('renderWhitespace', s.editor.renderWhitespace)
  if (s.editor.lineHeightMultiplier !== undefined) font.updateEditor('lineHeightMultiplier', s.editor.lineHeightMultiplier)
  if (s.editor.autoSave) font.updateEditor('autoSave', s.editor.autoSave)
  // setAutoSaveDelay 自带 [MIN, MAX] 钳制（与设置页输入同一入口）
  if (s.editor.autoSaveDelayMs !== undefined) font.setAutoSaveDelay(s.editor.autoSaveDelayMs)
  if (s.uiFont) font.setUiFont(s.uiFont)
  if (s.terminalLigatures) font.setTerminalLigatures(s.terminalLigatures)
  // setMonoFontName 内再消毒一次（与设置页输入同一入口，双保险同 autoSaveDelay）
  if (s.monoFontName) font.setMonoFontName(s.monoFontName)
  // 光标偏好（P-20261005-212）：setter 落盘后运行中会话 watch 即时生效
  if (s.cursorStyle) font.setCursorStyle(s.cursorStyle)
  if (s.cursorBlink !== undefined) font.setCursorBlink(s.cursorBlink)
  // diff 色板档（P-20261006-5）：theme store 的档位 watch 随 setDiffPalette 重写变量
  if (s.diffPalette) font.setDiffPalette(s.diffPalette)
}

function applyKeymap(value: unknown): void {
  if (!value || typeof value !== 'object') return
  const o = value as Record<string, unknown>
  const keymap = useKeymapStore()
  for (const id of KEYMAP_ACTION_ORDER) {
    const combo = o[id]
    if (typeof combo !== 'string' || !combo) continue
    // setBinding 内做规范化 + 保留键拒绝 + 等于默认值删覆盖（键位校验的现成正门）
    keymap.setBinding(id, combo)
  }
}

function applyLocale(value: unknown): void {
  // setLocale 内做语言包存在性校验（未知语言 no-op）与跨标签同步
  if (typeof value === 'string' && value) void useLocaleStore().setLocale(value as LocaleKey)
}

function applyTheme(value: unknown): void {
  // setTheme 内做注册表校验（未知主题 no-op），落盘收敛在用户主动选择路径
  if (typeof value === 'string' && value) useThemeStore().setTheme(value as ThemeKey)
}

function applyNotify(value: unknown): void {
  if (!value || typeof value !== 'object') return
  const o = value as Record<string, unknown>
  // dnd set 内逐字段归一（enabled === true、start/end 字符串、例外表过滤、
  // exceptError !== false）——部分/脏载荷直接进也不会污染偏好
  if (o.dnd && typeof o.dnd === 'object' && !Array.isArray(o.dnd)) {
    useDndStore().set(o.dnd as DndWindow)
  }
  // 三开关 set 内是 === true 语义（损坏值归默认），但入参已由投影面确认布尔
  if (typeof o.sound === 'boolean') useSoundStore().set(o.sound)
  if (typeof o.simple === 'boolean') useNotifySimpleStore().set(o.simple)
  if (typeof o.scrollRead === 'boolean') useNotifyScrollReadStore().set(o.scrollRead)
}

function applySection(key: SettingsSectionKey, value: unknown): void {
  if (key === 'font') applyFont(value)
  else if (key === 'keymap') applyKeymap(value)
  else if (key === 'locale') applyLocale(value)
  else if (key === 'theme') applyTheme(value)
  else applyNotify(value)
}

function onImportConfirm() {
  const chosen = previewEntries.value.filter(e => checked.value[e.key])
  if (chosen.length === 0) {
    message.warning(t('settings.transfer.importNothing'))
    return
  }
  applying.value = true
  try {
    for (const e of chosen) applySection(e.key, e.value)
    message.success(t('settings.transfer.importDone', { n: chosen.length }))
    showPreview.value = false
  } finally {
    applying.value = false
  }
}
</script>

<template>
  <div
    class="settings-transfer"
    data-testid="settings-transfer"
  >
    <div class="transfer-header">
      <h4>{{ t('settings.transfer.title') }}</h4>
      <span class="transfer-actions">
        <NButton
          size="tiny"
          data-test="settings-import-config"
          @click="fileRef?.click()"
        >
          {{ t('settings.transfer.import') }}
        </NButton>
        <NButton
          size="tiny"
          data-test="settings-export-config"
          @click="onExport"
        >
          {{ t('settings.transfer.export') }}
        </NButton>
        <input
          ref="fileRef"
          type="file"
          accept="application/json,.json"
          hidden
          @change="onImportFile"
        >
      </span>
    </div>
    <p class="transfer-hint">
      {{ t('settings.transfer.hint') }}
    </p>
  </div>

  <!-- 导入预览弹层：分节清单（条数 + 差异摘要）+ 勾选部分导入 -->
  <NModal
    :show="showPreview"
    preset="card"
    style="width: var(--modal-w-sm); max-width: 94vw"
    @update:show="showPreview = $event"
  >
    <template #header>
      {{ t('settings.transfer.previewTitle') }}
    </template>
    <p class="preview-hint">
      {{ t('settings.transfer.previewHint') }}
    </p>
    <ul class="section-list">
      <li
        v-for="e in previewEntries"
        :key="e.key"
        class="section-item"
        :data-test="'settings-transfer-section-' + e.key"
      >
        <NCheckbox
          v-model:checked="checked[e.key]"
          size="small"
          :data-test="'settings-transfer-check-' + e.key"
        />
        <span class="section-name">{{ t(SECTION_LABEL_KEYS[e.key]) }}</span>
        <span class="section-meta">
          <span class="section-count">{{ t('settings.transfer.itemCount', { n: e.count }) }}</span>
          <NTag
            v-if="e.diffCount > 0"
            size="tiny"
            type="warning"
            class="section-diff"
          >{{ t('settings.transfer.diffCount', { n: e.diffCount }) }}</NTag>
          <NTag
            v-else
            size="tiny"
            class="section-diff"
          >{{ t('settings.transfer.sameAsLocal') }}</NTag>
        </span>
      </li>
    </ul>
    <template #action>
      <div class="modal-actions">
        <NButton
          size="small"
          quaternary
          @click="showPreview = false"
        >
          {{ t('common.cancel') }}
        </NButton>
        <NButton
          size="small"
          type="primary"
          :loading="applying"
          data-test="settings-transfer-import-confirm"
          @click="onImportConfirm"
        >
          {{ t('settings.transfer.confirmImport', { n: previewEntries.filter(e => checked[e.key]).length }) }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.settings-transfer {
  margin-top: var(--space-3);
}

.transfer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-1);
}

.transfer-header h4 {
  margin: 0;
  font-size: 13px;
  font-weight: var(--fw-semibold);
}

.transfer-actions {
  display: inline-flex;
  gap: var(--space-1);
  align-items: center;
}

.transfer-hint {
  color: var(--text-color-3);
  font-size: 12px;
  margin: 0 0 var(--space-2);
}

.preview-hint {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--text-color-3);
}

.section-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.section-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) 10px;
  border: 1px solid var(--bg-border);
  border-radius: var(--radius-sm);
  margin-bottom: 6px;
}

.section-name {
  font-size: 13px;
  font-weight: var(--fw-semibold);
}

.section-meta {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.section-count {
  font-size: 12px;
  color: var(--text-color-3);
}

.section-diff {
  flex-shrink: 0;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
