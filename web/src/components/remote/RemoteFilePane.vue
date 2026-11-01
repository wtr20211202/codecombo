<script setup lang="ts">
import { ref, computed, h } from 'vue'
import {
  NButton, NIcon, NInput, NDataTable, NBreadcrumb, NBreadcrumbItem,
  NEmpty, NSpin, NTooltip, useMessage,
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import {
  RefreshOutline, AddOutline, CloudUploadOutline, DownloadOutline,
  TrashOutline, CreateOutline, ArrowUpOutline,
  SwapHorizontalOutline, DocumentOutline, FolderOutline,
} from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { remoteHostApi } from '../../api/client'
import type { RemoteDirEntry, RemoteHost } from '../../api/client'
import { friendlyRemoteError } from '../../utils/remoteErrors'
import { OPS_REMOTE_OPEN_IN_EDITOR } from '../../utils/opsEvents'
import {
  useRemoteFileBrowser, X_SC_REMOTE,
} from '../../composables/useRemoteFileBrowser'
import { useRemoteFileContextMenu } from '../../composables/useRemoteFileContextMenu'
import RemoteFileContextMenu from './RemoteFileContextMenu.vue'
import RemoteFileTransferModal from './RemoteFileTransferModal.vue'
import RemotePathHistory from './RemotePathHistory.vue'

/**
 * 远程主机文件面板（自 RemoteFileManager 抽出，单主机自包含）：
 * 浏览/上传/下载/重命名/删除/复制路径 + 右键菜单 + 传输到主机弹窗。
 * 拖放双通道：OS 文件拖入 → 上传；另一面板拖入远程文件 → 上抛 dropRemote 由宿主互传。
 * 按区块拆分（P-20261002-27）：目录模型/导航/文件操作在 useRemoteFileBrowser，
 * 右键菜单在 useRemoteFileContextMenu，传输弹窗为 RemoteFileTransferModal 子组件；
 * 本组件保留工具条/表格/拖放双通道的编排与渲染。
 */
const props = defineProps<{ host: RemoteHost | null; busy?: boolean }>()

const emit = defineEmits<{
  (e: 'dropRemote', payload: { fromHostId: string; fromCwd: string; names: string[]; toCwd: string }): void
}>()

const { t } = useI18n()
const message = useMessage()

// 名称过滤（大目录快速定位）；按 host 记忆上次目录（随家目录数据持久到 localStorage）
const filterText = ref('')

// ============== 目录模型 + 导航 + 文件操作（拆至 composable） ==============

const {
  cwd, entries, loading, checked, filteredEntries,
  crumbs, joinPath, fileErrMsg,
  list, enter, up,
  showPathInput, pathDraft, openPathEdit, jumpPath,
  recentPaths, pinnedPaths, togglePinPath,
  uploadInput, pickUpload, onUploadPicked, uploadFiles,
  download, mkdir, rename, remove,
} = useRemoteFileBrowser({
  host: () => props.host,
  filterText,
})

// 路径历史快选（P-20261006-19）：点选直达（cwd watcher 驱动 list()，路径失效
// 走既有错误提示），历史/pin 的记录与持久化在 useRemoteFileBrowser
function gotoHistoryPath(p: string) {
  cwd.value = p
}

// ============== 拖放区（双通道） ==============
// type 'Files'：来自 OS 资源管理器 → 上传；
// type X_SC_REMOTE：来自本页另一主机面板 → 上抛宿主做互传

const dragOver = ref(false)
const dropTarget = ref(false)

function onDragOver(ev: DragEvent) {
  const types = ev.dataTransfer?.types
  if (types?.includes('Files')) {
    ev.preventDefault()
    dragOver.value = true
  } else if (types?.includes(X_SC_REMOTE)) {
    ev.preventDefault()
    dropTarget.value = true
  }
}

function onDragLeave() {
  dragOver.value = false
  dropTarget.value = false
}

function onDrop(ev: DragEvent) {
  dragOver.value = false
  dropTarget.value = false
  const dt = ev.dataTransfer
  if (!dt) return
  // 远程互传优先（本页拖拽也可能同时携带 Files 类型）
  const raw = dt.getData(X_SC_REMOTE)
  if (raw) {
    ev.preventDefault()
    ev.stopPropagation()
    try {
      const payload = JSON.parse(raw) as { hostId?: string; cwd?: string; names?: string[] }
      if (payload.hostId && payload.hostId !== props.host?.id && payload.names?.length) {
        emit('dropRemote', { fromHostId: payload.hostId, fromCwd: payload.cwd || '/', names: payload.names, toCwd: cwd.value })
      }
    } catch { /* 非本应用数据，忽略 */ }
    return
  }
  const files = Array.from(dt.files || [])
  if (files.length > 0) {
    ev.preventDefault()
    ev.stopPropagation()
    void uploadFiles(files)
  }
}

// ============== 传输到主机（弹窗为子组件，勾选拼装与 API 在本组件） ==============

const showTransfer = ref(false)
const transferring = ref(false)

async function startTransfer(payload: { targets: string[]; dir: string; hostNames: Record<string, string> }) {
  if (!props.host || payload.targets.length === 0) return
  transferring.value = true
  try {
    const selected = checked.value.map(n => joinPath(cwd.value, n))
    const res = await remoteHostApi.files.transfer(
      props.host.id, selected, payload.targets, payload.dir,
    ) as unknown as { data?: { results?: { hostId: string; ok: boolean; files?: number; error?: string }[] } }
    const results = res.data?.results || []
    const nameOf = (id: string) => payload.hostNames[id] || id
    for (const r of results) {
      if (r.ok) message.success(t('remoteFiles.transferred', { host: nameOf(r.hostId), n: r.files || 0 }))
      else message.error(t('remoteFiles.transferFailed', { host: nameOf(r.hostId), msg: friendlyRemoteError(r.error || '', t) }))
    }
    showTransfer.value = false
  } catch (e: unknown) {
    message.error(fileErrMsg(e, t('remoteFiles.transferFailed', { host: '?', msg: '' })))
  } finally {
    transferring.value = false
  }
}

// ============== 右键菜单（容器统一收口，拆至 composable） ==============

const { ctxShow, ctxX, ctxY, onBgContext, closeCtx, ctxOptions, onCtxSelect } = useRemoteFileContextMenu({
  host: () => props.host,
  entries,
  checked,
  cwd,
  joinPath,
  actions: {
    list: () => { void list() },
    mkdir: () => { void mkdir() },
    pickUpload,
    enter,
    download: (names) => { void download(names) },
    openTransfer: () => { showTransfer.value = true },
    rename: (name) => { void rename(name) },
    remove: (names) => { void remove(names) },
    // 在编辑器打开（P-20261003-15）：remote:<hostId>:<path> 伪路径经窗口事件
    // 上抛 Layout（视图层级隔着 RemoteConsoleView→FileManager 两层，事件与
    // OPS_OPEN_FILE_AT 同款解耦），由 useOpenFiles 远程分支挂签装载
    openEditor: (name) => {
      if (!props.host) return
      window.dispatchEvent(new CustomEvent(OPS_REMOTE_OPEN_IN_EDITOR, {
        detail: { hostId: props.host.id, path: joinPath(cwd.value, name) },
      }))
    },
  },
})

// ============== 表格 ==============

const columns = computed<DataTableColumns<RemoteDirEntry>>(() => [
  { type: 'selection' },
  {
    title: t('remoteFiles.colName'),
    key: 'name',
    sorter: (a, b) => a.name.localeCompare(b.name),
    render(row) {
      // 文件名 span 是自有 vnode：拖拽源（拖到另一主机面板互传）挂这里，
      // 不依赖 n-data-table rowProps 的事件透传
      return h('span', {
        class: 'rfc-name',
        draggable: true,
        onClick: () => (row.isDir ? enter(row) : void download([row.name])),
        onDragstart: (ev: DragEvent) => {
          const names = (checked.value.length > 1 && checked.value.includes(row.name))
            ? [...checked.value]
            : [row.name]
          ev.dataTransfer?.setData(X_SC_REMOTE, JSON.stringify({ hostId: props.host?.id, cwd: cwd.value, names }))
          if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy'
        },
      }, [
        h(NIcon, { size: 14, style: 'margin-right:6px;vertical-align:-2px' }, [
          h(row.isDir ? FolderOutline : DocumentOutline),
        ]),
        row.name + (row.isDir ? '/' : ''),
      ])
    },
  },
  {
    title: t('remoteFiles.colSize'), key: 'size', width: 100,
    sorter: (a, b) => a.size - b.size,
    render: (row) => (row.isDir ? '—' : humanSize(row.size)),
  },
  { title: t('remoteFiles.colMode'), key: 'mode', width: 110 },
  {
    title: t('remoteFiles.colMtime'), key: 'mtime', width: 170,
    sorter: (a, b) => a.mtime - b.mtime,
    render: (row) => new Date(row.mtime).toLocaleString(),
  },
  {
    title: '', key: 'actions', width: 96,
    render(row) {
      return h('div', { class: 'rfc-actions' }, [
        h('button', { class: 'rfc-act', title: t('common.rename'), onClick: (ev: MouseEvent) => { ev.stopPropagation(); void rename(row.name) } }, [h(CreateOutline)]),
        h('button', { class: 'rfc-act rfc-danger', title: t('common.delete'), onClick: (ev: MouseEvent) => { ev.stopPropagation(); void remove([row.name]) } }, [h(TrashOutline)]),
      ])
    },
  },
])

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

defineExpose({ reload: list })
</script>

<template>
  <div
    class="rf-pane"
    :class="{ 'is-busy': busy }"
  >
    <!-- 路径导航（可切换为直达输入）+ 工具栏 -->
    <div class="rf-toolbar">
      <n-input
        v-if="showPathInput"
        v-model:value="pathDraft"
        size="small"
        class="rf-path-input"
        :placeholder="t('remoteFiles.pathPlaceholder')"
        autofocus
        @keyup.enter="jumpPath"
        @keyup.esc="showPathInput = false"
        @blur="showPathInput = false"
      />
      <n-breadcrumb
        v-else
        class="rf-crumbs"
      >
        <n-breadcrumb-item
          v-for="c in crumbs"
          :key="c.path"
        >
          <span
            class="rf-crumb"
            @click="cwd = c.path"
          >{{ c.name === '/' ? '/' : c.name }}</span>
        </n-breadcrumb-item>
      </n-breadcrumb>
      <n-button
        size="small"
        quaternary
        :title="t('remoteFiles.pathEdit')"
        @click="showPathInput ? showPathInput = false : openPathEdit()"
      >
        <template #icon>
          <n-icon><CreateOutline /></n-icon>
        </template>
      </n-button>
      <!-- 路径历史快选（P-20261006-19）：置顶 pin + 最近路径两段式下拉，点选直达 -->
      <RemotePathHistory
        :pinned="pinnedPaths"
        :recent="recentPaths"
        @select="gotoHistoryPath"
        @toggle-pin="togglePinPath"
      />
      <div class="rf-tools">
        <n-tooltip trigger="hover">
          <template #trigger>
            <n-button
              size="small"
              quaternary
              :disabled="cwd === '/'"
              :title="t('remoteFiles.up')"
              @click="up"
            >
              <template #icon>
                <n-icon><ArrowUpOutline /></n-icon>
              </template>
            </n-button>
          </template>
          {{ t('remoteFiles.up') }}
        </n-tooltip>
        <n-button
          size="small"
          quaternary
          :title="t('common.refresh')"
          @click="list"
        >
          <template #icon>
            <n-icon><RefreshOutline /></n-icon>
          </template>
        </n-button>
        <n-button
          size="small"
          quaternary
          :title="t('remoteFiles.mkdir')"
          @click="mkdir"
        >
          <template #icon>
            <n-icon><AddOutline /></n-icon>
          </template>
        </n-button>
        <n-button
          size="small"
          quaternary
          :title="t('remoteFiles.upload')"
          @click="pickUpload"
        >
          <template #icon>
            <n-icon><CloudUploadOutline /></n-icon>
          </template>
        </n-button>
        <n-input
          v-model:value="filterText"
          size="small"
          class="rf-filter"
          :placeholder="t('remoteFiles.filterPlaceholder')"
          clearable
        />
        <input
          ref="uploadInput"
          type="file"
          multiple
          hidden
          @change="onUploadPicked"
        >
        <n-button
          size="small"
          quaternary
          :disabled="checked.length === 0"
          :title="t('remoteFiles.download')"
          @click="download(checked)"
        >
          <template #icon>
            <n-icon><DownloadOutline /></n-icon>
          </template>
        </n-button>
        <n-button
          v-if="host?.protocol !== 'ftp'"
          size="small"
          quaternary
          type="primary"
          ghost
          :disabled="checked.length === 0"
          :loading="transferring"
          :title="t('remoteFiles.transfer')"
          @click="showTransfer = true"
        >
          <template #icon>
            <n-icon><SwapHorizontalOutline /></n-icon>
          </template>
        </n-button>
        <n-button
          size="small"
          quaternary
          type="error"
          :disabled="checked.length === 0"
          :title="t('common.delete')"
          @click="remove(checked)"
        >
          <template #icon>
            <n-icon><TrashOutline /></n-icon>
          </template>
        </n-button>
      </div>
    </div>

    <!-- 列表区即拖放区：OS 文件拖入上传；另一面板远程文件拖入互传；空白处/行上均可右键 -->
    <n-spin
      :show="loading"
      size="small"
      class="rf-dropzone"
      :class="{ 'is-dragover': dragOver, 'is-droptarget': dropTarget }"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
      @contextmenu="onBgContext"
    >
      <n-empty
        v-if="!loading && entries.length === 0"
        :description="t('remoteFiles.empty')"
        class="rf-empty"
      />
      <n-data-table
        v-else
        v-model:checked-row-keys="checked"
        :columns="columns"
        :data="filteredEntries"
        :row-key="(r: RemoteDirEntry) => r.name"
        size="small"
        :max-height="420"
        :scroll-x="560"
        virtual-scroll
      />
    </n-spin>

    <!-- 右键菜单 -->
    <RemoteFileContextMenu
      v-if="ctxShow"
      :x="ctxX"
      :y="ctxY"
      :options="ctxOptions"
      @select="onCtxSelect"
      @close="closeCtx"
    />

    <!-- 传输到主机弹窗（勾选拼装/调用/结果 toast 在本组件，表单在子组件） -->
    <RemoteFileTransferModal
      v-model:show="showTransfer"
      :exclude-host-id="host?.id"
      :checked-count="checked.length"
      :transferring="transferring"
      :cwd="cwd"
      @start="startTransfer"
    />
  </div>
</template>

<style scoped>
.rf-pane { display: flex; flex-direction: column; min-width: 0; }
.rf-pane.is-busy { opacity: 0.6; pointer-events: none; }
.rf-pane.is-busy .rf-dropzone { outline: 2px dashed var(--brand-accent); outline-offset: -4px; }
.rf-crumb { cursor: pointer; }
.rf-crumb:hover { color: var(--brand-accent); }
.rf-toolbar {
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px; margin-bottom: 10px; flex-wrap: wrap;
}
.rf-crumbs { flex: 1; min-width: 120px; }
.rf-path-input { flex: 1; min-width: 160px; font-family: var(--font-mono); }
.rf-tools { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; }
.rf-filter { width: 130px; }
.rf-empty { padding: 40px 0; }
.rf-dropzone { border-radius: 6px; }
.rf-dropzone.is-dragover {
  outline: 2px dashed var(--brand-accent);
  outline-offset: -4px;
  background: color-mix(in srgb, var(--brand-accent) 6%, transparent);
}
.rf-dropzone.is-droptarget {
  outline: 2px dashed var(--accent-green);
  outline-offset: -4px;
  background: color-mix(in srgb, var(--accent-green) 6%, transparent);
}

:deep(.rfc-name) { cursor: pointer; }
:deep(.rfc-name:hover) { color: var(--brand-accent); }
:deep(.rfc-actions) { display: flex; gap: 4px; opacity: 0; transition: opacity var(--motion-base); }
:deep(tr:hover .rfc-actions) { opacity: 1; }
:deep(.rfc-act) {
  border: none; background: transparent; cursor: pointer; padding: 2px;
  color: var(--text-muted); display: inline-flex; border-radius: 4px;
}
:deep(.rfc-act:hover) { color: var(--brand-accent); background: var(--bg-hover); }
:deep(.rfc-act.rfc-danger:hover) { color: var(--accent-red); }
</style>
