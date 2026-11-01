<script setup lang="ts">
// 工作区状态备份（roadmap #9 收口）：uiState 已结构化（布局/文件树/会话分组/
// 远程控制台 tab 等），此处补导出 UI（JSON 下载）与导入校验（命名空间白名单
// + 基础形状检查后按实例写回，覆盖同名命名空间）。
import { ref } from 'vue'
import { NButton } from 'naive-ui'
import { uiStateApi } from '../../api/client'
import { useI18n } from '../../composables/useI18n'
import { useMessage } from 'naive-ui'
import { confirmDialog } from '../../composables/useDialog'

const { t } = useI18n()
const message = useMessage()

const exporting = ref(false)
const importing = ref(false)
const fileRef = ref<HTMLInputElement | null>(null)

// uiState 已知命名空间白名单：导入时丢弃未知键，防止脏数据长驱直入
const KNOWN_NS = ['editor', 'fileTree', 'layout', 'terminal', 'gitPanel', 'remoteConsole', 'agentTerminal'] as const

function downloadStates(states: Record<string, Record<string, unknown>>) {
  const payload = {
    scUiState: 1,
    exportedAt: new Date().toISOString(),
    states,
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const day = new Date().toISOString().slice(0, 10)
  a.href = url
  a.download = `codecombo-ui-state-${day}.json`
  a.click()
  URL.revokeObjectURL(url)
}

async function handleExport() {
  if (exporting.value) return
  exporting.value = true
  try {
    // 独立导出端点：载荷同 /ui-state，服务端为显式导出记一条审计（P-20261002-13）
    const res: any = await uiStateApi.exportBackup()
    const states = (res?.data || {}) as Record<string, Record<string, unknown>>
    if (Object.keys(states).length === 0) {
      message.warning(t('settings.workspaceBackup.empty'))
      return
    }
    downloadStates(states)
    message.success(t('settings.workspaceBackup.exportDone'))
  } catch {
    message.error(t('settings.workspaceBackup.exportFailed'))
  } finally {
    exporting.value = false
  }
}

/** 命名空间白名单 + 对象形状过滤：返回按实例收敛后的合法状态（无合法项返回 null） */
function sanitizeStates(raw: unknown): Record<string, Record<string, unknown>> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Record<string, Record<string, unknown>> = {}
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || !v || typeof v !== 'object' || Array.isArray(v)) continue
    const ns: Record<string, unknown> = {}
    for (const k of KNOWN_NS) {
      const val = (v as Record<string, unknown>)[k]
      if (val !== undefined && val !== null && typeof val === 'object' && !Array.isArray(val)) ns[k] = val
    }
    if (Object.keys(ns).length > 0) out[id] = ns
  }
  return Object.keys(out).length > 0 ? out : null
}

async function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // 允许重复选择同一文件
  if (!file || importing.value) return
  importing.value = true
  try {
    let parsed: unknown
    try {
      parsed = JSON.parse(await file.text())
    } catch {
      message.error(t('settings.workspaceBackup.importInvalid'))
      return
    }
    // 兼容两种来源：本组件导出的带标记包裹格式 / 原生 uiState 全量对象
    const raw = (parsed as { scUiState?: number; states?: unknown })?.scUiState
      ? (parsed as { states: unknown }).states
      : parsed
    const states = sanitizeStates(raw)
    if (!states) {
      message.error(t('settings.workspaceBackup.importInvalid'))
      return
    }
    const count = Object.keys(states).length
    const ok = await confirmDialog({
      title: t('settings.workspaceBackup.importConfirmTitle'),
      content: t('settings.workspaceBackup.importConfirm', { n: count }),
      confirmText: t('settings.workspaceBackup.importGo'),
      cancelText: t('common.cancel'),
    })
    if (!ok) return
    for (const [id, ns] of Object.entries(states)) {
      await uiStateApi.update({ [id]: ns })
    }
    // 布局恢复发生在页面引导链：刷新后新状态才完整生效
    const reload = await confirmDialog({
      title: t('settings.workspaceBackup.importDoneTitle'),
      content: t('settings.workspaceBackup.importDone'),
      confirmText: t('settings.workspaceBackup.refreshNow'),
      cancelText: t('common.later'),
    })
    if (reload) location.reload()
  } catch {
    message.error(t('settings.workspaceBackup.importFailed'))
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <div class="wb-section">
    <div class="wb-title">
      {{ t('settings.workspaceBackup.title') }}
    </div>
    <div class="wb-desc">
      {{ t('settings.workspaceBackup.desc') }}
    </div>
    <div class="wb-actions">
      <n-button
        size="tiny"
        :loading="exporting"
        @click="handleExport"
      >
        {{ t('settings.workspaceBackup.export') }}
      </n-button>
      <n-button
        size="tiny"
        :loading="importing"
        @click="fileRef?.click()"
      >
        {{ t('settings.workspaceBackup.import') }}
      </n-button>
      <input
        ref="fileRef"
        type="file"
        accept="application/json,.json"
        hidden
        @change="onFileChange"
      >
    </div>
  </div>
</template>

<style scoped>
.wb-section {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--bg-border);
}
.wb-title {
  font-size: 13px;
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
}
.wb-desc {
  margin: var(--space-1) 0 var(--space-2);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.wb-actions {
  display: flex;
  gap: var(--space-2);
}
</style>
