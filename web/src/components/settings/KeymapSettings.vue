<script setup lang="ts">
// 快捷键设置分区（P-20261002-28，P-20261003-111 域分组，P-20261008-14 编辑器域
// 收口，P-20261107-5 笔记面板域）：
// 键位逐条改绑，按 keymap 注册表域分组（全局布局 / 终端 / 编辑器 / 笔记面板
// ——审批域入表后按序追加）。
// - 点击「改键」进入捕获态：下一个组合键经 normalizeLayoutCombo 规范化写入
//   keymap store（localStorage 持久化，即时生效无保存按钮）
// - Esc 取消捕获；浏览器保留键（Ctrl+N/T 等）拒绝并提示
// - 保存时冲突扫描（P-20261003-106）：撞键先弹警示（撞了谁、后果如何），
//   「仍要保存」可继续；取消不落盘保持捕获态
// - 撞键实时标红：同域同 combo 动作组内注册序靠后者不生效，跨域同键按域分层
//   提示（doc 级终端动作接管 / xterm 焦点域共存，P-20261003-111），锁定快捷键
//   优先级最高；用户改绑撞静态键清单（编辑器/全局硬编码域）的行同样标红
//   （与 SecuritySettings 锁定改键同款 document capture 相位监听模式）
import { h, ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import type { VNodeChild } from 'vue'
import { NButton, useMessage } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { confirmDialog } from '../../composables/useDialog'
import {
  useKeymapStore, keycapParts, isReservedCombo, normalizeLayoutCombo,
  KEYMAP_ACTION_ORDER, KEYMAP_ACTION_DOMAIN, KEYMAP_DOMAINS,
  type KeymapAction, type KeymapConflict,
} from '../../stores/keymap'
import { useLockStore } from '../../stores/lock'
import { findBindingConflicts, staticConflictsForCombo, type BindingConflict, type StaticKeyEntry } from '../../utils/keyInventory'

const props = defineProps<{ show: boolean }>()

const { t } = useI18n()
const message = useMessage()
const keymap = useKeymapStore()
const lockStore = useLockStore()

// 行模型：动作 id / 展示名 / 生效键帽数组 / 是否自定义 / 冲突提示行。
// 按域分组（keymap.group.*），组内保持注册表键序（同域冲突先到先得的展示序）
const groups = computed(() => KEYMAP_DOMAINS
  .map((domain) => {
    return {
      domain,
      label: t(`keymap.group.${domain}`),
      rows: KEYMAP_ACTION_ORDER
        .filter(id => KEYMAP_ACTION_DOMAIN[id] === domain)
        .map((id) => {
          const combo = keymap.combos[id]
          return {
            id,
            label: t(`keymap.actions.${id}`),
            caps: keycapParts(combo),
            isCustom: !!keymap.overrides[id],
            conflictLines: conflictLinesFor(id),
          }
        }),
    }
  })
  .filter(g => g.rows.length > 0))

function conflictText(conflict: KeymapConflict, selfId: KeymapAction): string {
  if (conflict.kind === 'lock') return t('keymap.conflictLock')
  const name = t(`keymap.actions.${conflict.other}`)
  if (conflict.cross === 'takeover') return t('keymap.conflictCrossTakeover', { name })
  if (conflict.cross === 'focus') {
    // 编辑器域入注册表（P-20261008-14）后焦点域共存从 terminal↔global 扩为三向；
    // 笔记面板域（P-20261107-5）同享焦点域语义（self/other 两向各取文案）
    const selfDomain = KEYMAP_ACTION_DOMAIN[selfId]
    const otherDomain = KEYMAP_ACTION_DOMAIN[conflict.other!]
    if (selfDomain === 'editor') return t('keymap.conflictCrossFocusEditorSelf', { name })
    if (selfDomain === 'terminal') return t('keymap.conflictCrossFocusTerm', { name })
    if (selfDomain === 'notes') return t('keymap.conflictCrossFocusNotesSelf', { name })
    if (otherDomain === 'notes') return t('keymap.conflictCrossFocusNotes', { name })
    return otherDomain === 'editor'
      ? t('keymap.conflictCrossFocusEditor', { name })
      : t('keymap.conflictCrossFocusGlobal', { name })
  }
  return t('keymap.conflictWith', { name })
}

function staticConflictText(entry: StaticKeyEntry): string {
  const scope = t(`keymap.invScope.${entry.scope}`)
  const name = t(entry.labelKey, entry.params ?? {})
  return entry.semantics === 'takeover'
    ? t('keymap.line.staticTakeover', { scope, name })
    : t('keymap.line.staticFocus', { scope, name })
}

/** 行冲突提示：注册表冲突（store conflicts，含跨域语义）优先；改绑后撞静态键
 *  清单的行标红（默认键位与既有域的同键白名单共存不标） */
function conflictLinesFor(id: KeymapAction): string[] {
  const storeConflict = keymap.conflicts[id]
  if (storeConflict) return [conflictText(storeConflict, id)]
  if (!keymap.overrides[id]) return []
  return staticConflictsForCombo(keymap.combos[id]).map(staticConflictText)
}

/** 警示弹窗逐条提示行（保存时冲突扫描结果 → 双语文案；跨域按域方向取文案） */
function conflictHintLines(action: KeymapAction, conflicts: BindingConflict[]): string[] {
  return conflicts.map((c) => {
    if (c.kind === 'lock') return t('keymap.line.lock')
    if (c.kind === 'action') {
      const name = t(`keymap.actions.${c.other}`)
      if (c.cross === 'takeover') {
        return c.takesOver
          ? t('keymap.line.actionTakeover', { name })
          : t('keymap.line.crossDocShadowed', { name })
      }
      if (c.cross === 'focus') {
        // 编辑器域入注册表（P-20261008-14）后焦点域共存三向化，按本方域 × 对方域
        // 取文案；笔记面板域（P-20261107-5）同享焦点域语义
        const selfDomain = KEYMAP_ACTION_DOMAIN[action]
        const otherDomain = KEYMAP_ACTION_DOMAIN[c.other!]
        if (selfDomain === 'editor') return t('keymap.line.actionCrossFocusEditorSelf', { name })
        if (selfDomain === 'terminal') return t('keymap.line.actionCrossFocusTerminal', { name })
        if (selfDomain === 'notes') return t('keymap.line.actionCrossFocusNotesSelf', { name })
        if (otherDomain === 'notes') return t('keymap.line.actionCrossFocusNotes', { name })
        return otherDomain === 'editor'
          ? t('keymap.line.actionCrossFocusEditor', { name })
          : t('keymap.line.actionCrossFocusGlobal', { name })
      }
      return c.takesOver
        ? t('keymap.line.actionTakeover', { name })
        : t('keymap.line.actionShadowed', { name })
    }
    return staticConflictText(c.entry!)
  })
}

// === 改键捕获（同 SecuritySettings 锁定改键模式） ===
const capturing = ref<KeymapAction | null>(null)
// 冲突确认弹窗打开期间挂起捕获监听（capture 相位 preventDefault 会吞掉弹窗的
// Esc/Enter 键盘操作），裁决落定后恢复
const confirmPending = ref(false)

function startCapture(id: KeymapAction) {
  capturing.value = id
}

// Esc 取消；浏览器保留键拒绝（保持捕获态可再按）；纯修饰键继续等待；
// 撞键先警示（P-20261003-106）：确认才落盘，取消不落盘保持捕获态
function onCaptureKeydown(e: KeyboardEvent) {
  const action = capturing.value
  if (!action || confirmPending.value) return
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') {
    capturing.value = null
    return
  }
  const combo = normalizeLayoutCombo(e)
  if (!combo) return
  if (isReservedCombo(combo)) {
    message.error(t('keymap.reservedBlocked'))
    return
  }
  // 改绑回当前生效值（含恢复默认）：没有新冲突产生，静默落盘
  if (combo === keymap.combos[action]) {
    keymap.setBinding(action, combo)
    capturing.value = null
    return
  }
  const conflicts = findBindingConflicts(action, combo, keymap.combos, lockStore.lockShortcut)
  if (conflicts.length === 0) {
    keymap.setBinding(action, combo)
    capturing.value = null
    return
  }
  confirmPending.value = true
  void confirmDialog({
    title: t('keymap.conflictTitle'),
    type: 'warning',
    confirmText: t('keymap.conflictSaveAnyway'),
    content: (): VNodeChild => h(
      'div',
      { style: 'display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:1.6;' },
      conflictHintLines(action, conflicts).map(line => h('div', line)),
    ),
  }).then((ok) => {
    confirmPending.value = false
    if (ok) {
      keymap.setBinding(action, combo)
      capturing.value = null
    }
    // 取消：不落盘，保持捕获态可继续按其他组合键（同保留键拒绝后的心智）
  })
}

function resetOne(id: KeymapAction) {
  keymap.resetBinding(id)
  capturing.value = null
}

function resetAllBindings() {
  keymap.resetAll()
  capturing.value = null
}

const hasAnyCustom = computed(() => KEYMAP_ACTION_ORDER.some(id => !!keymap.overrides[id]))

// 弹窗关闭时退出捕获态，避免隐藏实例继续吞按键
watch(() => props.show, (val) => {
  if (!val) capturing.value = null
})

onMounted(() => document.addEventListener('keydown', onCaptureKeydown, true))
onBeforeUnmount(() => document.removeEventListener('keydown', onCaptureKeydown, true))
</script>

<template>
  <div class="keymap-settings">
    <p class="keymap-desc">
      {{ t('keymap.desc') }}
    </p>
    <!-- 分轨标注（P-20261007-1）：键位覆盖随账号漫游（服务端 userPrefs 单键） -->
    <p
      class="keymap-desc sync-track-hint"
      data-testid="keymap-sync-track-hint"
    >
      {{ t('settings.syncTrackRoaming') }}
    </p>
    <div
      class="keymap-list"
      data-testid="keymap-list"
    >
      <template
        v-for="group in groups"
        :key="group.domain"
      >
        <div
          class="keymap-group-title"
          :data-testid="`keymap-group-${group.domain}`"
        >
          {{ group.label }}
        </div>
        <div
          v-for="row in group.rows"
          :key="row.id"
          class="keymap-row"
          :class="{ 'is-capturing': capturing === row.id, 'is-conflict': row.conflictLines.length > 0 }"
          :data-testid="`keymap-row-${row.id}`"
        >
        <span class="keymap-label">{{ row.label }}</span>
        <span
          class="keymap-keys"
          :data-testid="`keymap-combo-${row.id}`"
        >
          <template v-if="capturing === row.id">
            <span class="keymap-capture-hint">
              {{ t('keymap.capturePrompt') }} ({{ t('keymap.captureCancel') }})
            </span>
          </template>
          <template v-else>
            <kbd
              v-for="cap in row.caps"
              :key="cap"
            >{{ cap }}</kbd>
          </template>
        </span>
        <span
          class="keymap-badge"
          :data-testid="`keymap-custom-${row.id}`"
        >{{ row.isCustom ? t('keymap.customized') : '' }}</span>
        <div class="keymap-actions">
          <n-button
            size="tiny"
            type="primary"
            :data-testid="`keymap-change-${row.id}`"
            @click="startCapture(row.id)"
          >
            {{ t('keymap.edit') }}
          </n-button>
          <n-button
            size="tiny"
            quaternary
            :disabled="!row.isCustom"
            :data-testid="`keymap-reset-${row.id}`"
            @click="resetOne(row.id)"
          >
            {{ t('keymap.resetOne') }}
          </n-button>
        </div>
        <div
          v-if="row.conflictLines.length > 0"
          class="keymap-conflict"
          :data-testid="`keymap-conflict-${row.id}`"
        >
          <div
            v-for="line in row.conflictLines"
            :key="line"
          >
            {{ line }}
          </div>
        </div>
        </div>
      </template>
    </div>
    <div class="keymap-footer">
      <n-button
        size="small"
        :disabled="!hasAnyCustom"
        data-testid="keymap-reset-all"
        @click="resetAllBindings"
      >
        {{ t('keymap.resetAll') }}
      </n-button>
    </div>
  </div>
</template>

<style scoped>
.keymap-desc {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-dim);
}
.sync-track-hint {
  margin-top: -4px;
  opacity: 0.85;
}
.keymap-list {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.keymap-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px var(--space-3);
  font-size: 12px;
  border-bottom: 1px solid var(--border-subtle);
  position: relative;
  flex-wrap: wrap;
}
.keymap-row:last-child { border-bottom: none; }
.keymap-row:nth-child(odd) { background: var(--bg-canvas); }
/* 分组标题（P-20261003-111）：行间小节标题，置后覆盖 nth-child 斑马纹 */
.keymap-group-title {
  padding: 6px var(--space-3) var(--space-1);
  font-size: var(--fs-section-min, 12px);
  font-weight: var(--fw-semibold);
  letter-spacing: 0.05em;
  color: var(--text-tertiary);
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border-subtle);
}
.keymap-row.is-capturing {
  background: var(--brand-accent-soft);
}
.keymap-row.is-conflict .keymap-label { color: var(--accent-red); }
.keymap-label {
  flex: 1;
  min-width: 140px;
  color: var(--text-body);
}
.keymap-keys { display: inline-flex; gap: var(--space-1); align-items: center; }
.keymap-keys kbd {
  padding: 1px 6px;
  border: 1px solid var(--border-default);
  border-bottom-width: 2px;
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
  font-family: var(--font-mono);
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--text-secondary);
}
.keymap-capture-hint {
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--brand-accent);
}
.keymap-badge {
  width: 34px;
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--brand-accent);
  text-align: left;
}
.keymap-actions { display: inline-flex; gap: var(--space-1); }
.keymap-conflict {
  flex-basis: 100%;
  font-size: var(--fs-meta-min, 11.5px);
  color: var(--accent-red);
}
.keymap-footer {
  margin-top: 10px;
  display: flex;
  justify-content: flex-end;
}
</style>
