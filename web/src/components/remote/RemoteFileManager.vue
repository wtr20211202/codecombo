<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { NModal, NButton, NIcon, NSelect, NEmpty, useMessage } from 'naive-ui'
import { FolderOpenOutline, GridOutline, ServerOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { remoteHostApi, type RemoteHost } from '../../api/client'
import { confirmDialog } from '../../composables/useDialog'
import { OPS_REMOTE_OPEN_IN_EDITOR } from '../../utils/opsEvents'
import RemoteFilePane from './RemoteFilePane.vue'

/**
 * 远程主机文件管理器弹窗（壳）：单栏 = 原有单主机浏览；
 * 双栏 = 左右两主机并排，从一栏拖文件到另一栏直接互传（服务端中转不落盘）。
 */
const show = defineModel<boolean>('show', { required: true })
const props = defineProps<{ host: RemoteHost | null }>()

const message = useMessage()
const { t } = useI18n()

// 「在编辑器打开」（P-20261003-15）：动作源自本弹窗内的右键菜单，主区随之
// 切回编辑器——但本弹窗 n-modal teleport 到 body，不随 .remote-root 的
// v-show 收起，会继续遮住编辑器（实测踩坑）；随动作自动收起，编辑器即视前方
function onRemoteOpenInEditor() {
  show.value = false
}
onMounted(() => window.addEventListener(OPS_REMOTE_OPEN_IN_EDITOR, onRemoteOpenInEditor))
onBeforeUnmount(() => window.removeEventListener(OPS_REMOTE_OPEN_IN_EDITOR, onRemoteOpenInEditor))

// ============== 双栏模式 ==============

const dualMode = ref(false)
const allHosts = ref<RemoteHost[] | null>(null)
const otherId = ref<string>('')
const relaying = ref(false)

const otherOptions = computed(() =>
  (allHosts.value || [])
    .filter(h => h.id !== props.host?.id)
    .map(h => ({ label: `${h.name}（${h.user}@${h.host}）`, value: h.id })))

const otherHost = computed(() =>
  (allHosts.value || []).find(h => h.id === otherId.value) || null)

function toggleDual() {
  dualMode.value = !dualMode.value
  if (dualMode.value) void ensureHosts()
}

async function ensureHosts() {
  if (allHosts.value) return
  try {
    const res = await remoteHostApi.list() as unknown as { data?: RemoteHost[] }
    allHosts.value = res.data || []
    if (!otherId.value) {
      otherId.value = allHosts.value.find(h => h.id !== props.host?.id)?.id || ''
    }
  } catch {
    allHosts.value = []
  }
}

watch(show, (v) => {
  if (!v) return
  dualMode.value = false
  allHosts.value = null
  otherId.value = ''
})

// ============== 跨面板拖拽互传 ==============

const leftPane = ref<InstanceType<typeof RemoteFilePane> | null>(null)
const rightPane = ref<InstanceType<typeof RemoteFilePane> | null>(null)

function joinPath(dir: string, name: string): string {
  if (dir === '/') return `/${name}`
  return `${dir}/${name}`
}

async function onDropRemote(
  side: 'left' | 'right',
  p: { fromHostId: string; fromCwd: string; names: string[]; toCwd: string },
) {
  const target = side === 'left' ? props.host : otherHost.value
  const src = side === 'left' ? otherHost.value : props.host
  if (!target || !src) return
  if (src.protocol === 'ftp' || target.protocol === 'ftp') {
    message.warning(t('remoteFiles.ftpNoTransfer'))
    return
  }
  const ok = await confirmDialog({
    title: t('remoteFiles.transferTitle'),
    content: t('remoteFiles.dropConfirm', {
      n: p.names.length, src: src.name, dst: target.name, dir: p.toCwd,
    }),
    type: 'warning',
  })
  if (!ok) return
  relaying.value = true
  try {
    const paths = p.names.map(n => joinPath(p.fromCwd, n))
    const res = await remoteHostApi.files.transfer(
      p.fromHostId, paths, [target.id], p.toCwd,
    ) as unknown as { data?: { results?: { hostId: string; ok: boolean; files?: number; error?: string }[] } }
    for (const r of res.data?.results || []) {
      if (r.ok) message.success(t('remoteFiles.transferred', { host: target.name, n: r.files || 0 }))
      else message.error(t('remoteFiles.transferFailed', { host: target.name, msg: r.error || '?' }))
    }
    // 目标面板刷新可见
    ;(side === 'left' ? leftPane : rightPane).value?.reload()
  } catch (e: unknown) {
    const err = e as { rawMessage?: string; userMessage?: string }
    // 友好文案为主；原文截断 120 字符作摘要（批量传输详情在错误面板可查）
    const raw = err?.rawMessage || ''
    const summary = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw
    message.error(summary
      ? `${t('remoteFiles.transferFailed', { host: target.name, msg: '' })}: ${summary}`
      : err?.userMessage || t('remoteFiles.transferFailed', { host: target.name, msg: '' }))
  } finally {
    relaying.value = false
  }
}
</script>

<template>
  <n-modal
    v-model:show="show"
    preset="card"
    class="rfm-modal"
    :class="{ 'rfm-modal-wide': dualMode }"
    :bordered="false"
  >
    <template #header>
      <div class="rfm-header">
        <n-icon size="16">
          <FolderOpenOutline />
        </n-icon>
        <span>{{ t('remoteFiles.title', { host: host?.name || '' }) }}</span>
      </div>
    </template>
    <template #header-extra>
      <n-button
        size="tiny"
        :type="dualMode ? 'primary' : 'default'"
        ghost
        @click="toggleDual"
      >
        <template #icon>
          <n-icon><GridOutline /></n-icon>
        </template>
        {{ t('remoteFiles.dualMode') }}
      </n-button>
    </template>

    <!-- 单栏：原有单主机浏览 -->
    <RemoteFilePane
      v-if="!dualMode"
      :host="host"
      :busy="relaying"
    />

    <!-- 双栏：左右两主机并排，拖拽互传 -->
    <template v-else>
      <div class="rfm-dual-head">
        <span
          class="rfm-pane-label"
          :title="host ? `${host.user}@${host.host}` : ''"
        >
          <n-icon size="12"><ServerOutline /></n-icon>
          {{ host?.name || '—' }}
        </span>
        <span class="rfm-pane-label rfm-pane-label-select">
          <n-select
            v-model:value="otherId"
            size="small"
            :options="otherOptions"
            :disabled="!allHosts"
            :placeholder="t('remoteFiles.dualTargetPlaceholder')"
          />
        </span>
      </div>
      <div class="rfm-dual-hint">
        {{ t('remoteFiles.dualHint') }}
      </div>
      <div class="rfm-dual">
        <RemoteFilePane
          ref="leftPane"
          :host="host"
          :busy="relaying"
          @drop-remote="(p) => onDropRemote('left', p)"
        />
        <div class="rfm-divider" />
        <div
          v-if="!otherHost && allHosts"
          class="rfm-dual-empty"
        >
          <n-empty
            :description="t('remoteFiles.dualNoOtherHost')"
            size="small"
          />
        </div>
        <RemoteFilePane
          v-else
          ref="rightPane"
          :host="otherHost"
          :busy="relaying"
          @drop-remote="(p) => onDropRemote('right', p)"
        />
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.rfm-modal { width: min(860px, 94vw); }
.rfm-modal-wide { width: min(1280px, 96vw); }
.rfm-header { display: flex; align-items: center; gap: 8px; }
.rfm-dual-head {
  display: flex; align-items: center; gap: 13px; margin-bottom: 4px;
}
.rfm-pane-label {
  flex: 1; min-width: 0;
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 12px; font-weight: 600; color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rfm-pane-label-select { font-weight: 400; }
.rfm-pane-label-select :deep(.n-select) { flex: 1; }
.rfm-dual-hint { font-size: 12px; color: var(--text-muted); margin-bottom: 8px; }
.rfm-dual { display: flex; gap: 12px; align-items: stretch; }
.rfm-dual > :first-child, .rfm-dual > :last-child { flex: 1; min-width: 0; }
.rfm-divider { width: 1px; background: var(--border-default); }
.rfm-dual-empty { flex: 1; display: flex; align-items: center; justify-content: center; padding: 40px 0; }
</style>
