<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { NModal, NSpin, NEmpty, NButton, NCheckbox, NIcon, NTag, useMessage } from 'naive-ui'
import { TrashBinOutline } from '@vicons/ionicons5'
import { trashApi, type TrashEntry } from '../../api/domains/git'
import { AppError } from '../../api/error-types'
import { useI18n } from '../../composables/useI18n'
import { confirmDialog, confirmTrashRestoreConflict } from '../../composables/useDialog'
import { useBatchSelect } from '../../composables/useBatchSelect'
import { isSensitiveName, isSensitivePath } from '../../utils/sensitiveName'
import { restageSuggestion, restageStep } from '../../utils/restageName'

/**
 * 文件回收站浮层（P-20261003-304）：删除的文件/目录 7 天内在此列表，行内
 * 恢复（原路径；409 目标已存在弹三选前进路径——重命名恢复/打开目标位置，
 * P-20261006-15）/彻底删除（确认）。degraded 条目（manifest 缺失）path 不可知，
 * 仅可彻底删除。宿主：文件树头部回收站按钮（FileTreeView），恢复成功上抛
 * restored 供宿主刷新树；冲突选「打开目标位置」上抛 locate 供宿主关浮层
 * revealFile 定位占位文件。
 *
 * 批量操作（P-20261005-175）：复选框行选 + 表头全选（useBatchSelect 状态机，
 * 通知中心 P-281 同款），选中 ≥2 出批量动作条——批量恢复逐项走既有 restore
 * 端点（409 同名/degraded 信息缺失跳过并计入回告，P-288 部分成功语义，不中断
 * 批次）；批量彻底删单次确认（文件/目录清点）后逐项 purge。群操作是单条端点
 * 的循环编排，服务端零改动；选择随弹层关闭/条目出列自动清剪
 */
const props = defineProps<{
  show: boolean
  projectId: string
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  /** 有条目恢复回项目树（宿主刷新文件树/git 徽标） */
  (e: 'restored'): void
  /** 冲突选「打开目标位置」（P-20261006-15）：宿主关浮层并 revealFile 定位 */
  (e: 'locate', path: string): void
}>()

const { t } = useI18n()
const message = useMessage()

const entries = ref<TrashEntry[]>([])
const loading = ref(false)
const busyId = ref('')
const batchBusy = ref(false)

// 多选态：弹层开合即清空（active = show），条目出列即对账剪除（状态机内 watch）
const {
  selectedIds, toggle, toggleMany, stateOf, isSelected,
} = useBatchSelect(entries, computed(() => props.show))

const allIds = computed(() => entries.value.map(e => e.id))
const selectAllState = computed(() => stateOf(allIds.value))
const selectedCount = computed(() => selectedIds.value.size)
/** 选中条目按列表序取快照（批量链用点击时点的集合，中途改选不影响在途批次） */
const selectedTargets = computed(() => entries.value.filter(e => selectedIds.value.has(e.id)))
/** 批量恢复按钮可用性：选中集里还有可恢复条目（degraded 无原路径，恢复必败） */
const batchRestorableCount = computed(() => selectedTargets.value.filter(e => !e.degraded).length)
const showBatchBar = computed(() => selectedCount.value >= 2)

function formatTs(ms: number): string {
  return new Date(ms).toLocaleString()
}

// 条目剩余天数徽标（P-20261005-155）：保留窗与服务端 TrashRetention（trash.go
// 常量，前端无运行时读取通道，双处硬编码以此注释互指）同源 7 天；ceil 使刚
// 入站即显「剩 7 天」并随时间降到「剩不足 1 天」。≤1 天（含已超窗但尚未被
// 每日清账扫走的窗口——此时条目随时可能消失，正是临期本义）切 accent-orange
// 临期强调。列表开层时拉取、存续期内不随钟重算：开层几分钟内跨天的显示漂移
// 无决策意义，不为此引入定时器
const TRASH_RETENTION_DAYS = 7

function daysLeftOf(deletedAtMs: number): number {
  return Math.ceil((deletedAtMs + TRASH_RETENTION_DAYS * 86_400_000 - Date.now()) / 86_400_000)
}

function daysLeftText(deletedAtMs: number): string {
  const days = daysLeftOf(deletedAtMs)
  return days >= 2 ? t('files.trash.daysLeft', { n: days }) : t('files.trash.daysLeftSoon')
}

// 敏感条目判定（P-20261005-163）：basename 级命中敏感模式表（前端镜像
// utils/sensitiveName ↔ server/share/scan.go 双处互指，此处不得就地复制模式）。
// degraded 无原路径用展示名兜底（entryId 推导的原名仍可判）；目录条目仅同名
// 命中（内部含敏感文件不在纯前端路径判界内——诚实边界，误报只是提示噪音）
function isSensitiveEntry(e: TrashEntry): boolean {
  return e.path ? isSensitivePath(e.path) : isSensitiveName(e.name)
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

async function fetchEntries() {
  if (!props.projectId) return
  loading.value = true
  try {
    const res = await trashApi.list(props.projectId) as { data?: TrashEntry[] }
    entries.value = res.data || []
  } finally {
    loading.value = false
  }
}

async function restore(e: TrashEntry) {
  if (busyId.value || batchBusy.value) return
  busyId.value = e.id
  try {
    // silent：409 目标已存在是预期分支（静默免拦截器叠 toast），此处弹三选
    // 前进路径（P-20261006-15）；成功后 relocated（原父目录已消失落到根）如实提示落点
    const res = await trashApi.restore(props.projectId, e.id, { silent: true }) as { relocated?: boolean }
    if (res?.relocated) {
      message.info(t('files.trash.restoredRelocated', { name: e.name }))
    } else {
      message.success(t('files.trash.restored', { name: e.name }))
    }
    emit('restored')
    await fetchEntries()
  } catch (err) {
    if (err instanceof AppError && err.status === 409) {
      await restoreAs(e)
    }
    // 其余失败走拦截器通用提示
  } finally {
    busyId.value = ''
  }
}

// 建议名步进重试上限：-restaged…-restaged-N 全被占是病态占位形态，50 次内不
// 收敛说明目标位置被蓄意填满，交回用户手动处置（服务端 duplicate 同族护栏
// dupNameMaxTries=1000 是服务端自增面；此处每步一个往返，50 已远超正常需要）
const RESTORE_AS_MAX_TRIES = 50

/**
 * 冲突前进路径（P-20261006-15）：三选弹层——重命名恢复（as=建议名 <name>
 * -restaged.<ext>）/ 打开目标位置（上抛宿主 revealFile 定位占位文件）/ 取消。
 * 建议名也冲突（409）时自动步进 -restaged-2… 重试（服务端 as 是精确名，
 * 步进由前端逐次换名驱动）。弹层期间 busyId 保持占位：防弹层悬置时批量链
 * 或其他行并发触发同条目
 */
async function restoreAs(e: TrashEntry) {
  const choice = await confirmTrashRestoreConflict({
    name: e.name,
    suggested: restageSuggestion(e.name),
  })
  if (choice === 'locate') {
    emit('locate', e.path)
    return
  }
  if (choice !== 'rename') return
  busyId.value = e.id
  try {
    let name = restageSuggestion(e.name)
    for (let attempt = 0; attempt < RESTORE_AS_MAX_TRIES; attempt++) {
      try {
        await trashApi.restore(props.projectId, e.id, { silent: true }, name)
        message.success(t('files.trash.restoredAs', { name }))
        emit('restored')
        await fetchEntries()
        return
      } catch (err) {
        if (err instanceof AppError && err.status === 409) {
          name = restageStep(name)
          continue
        }
        return // 其余失败静默（拦截器已记账，与单条恢复同口径）
      }
    }
    message.error(t('files.trash.restoreAsExhausted'))
  } finally {
    busyId.value = ''
  }
}

async function purge(e: TrashEntry) {
  if (busyId.value || batchBusy.value) return
  if (!await confirmDialog({
    type: 'warning',
    title: t('files.trash.purgeTitle'),
    content: t('files.trash.confirmPurge', { name: e.name }),
  })) return
  busyId.value = e.id
  try {
    await trashApi.purge(props.projectId, e.id)
    message.success(t('files.trash.purged', { name: e.name }))
    await fetchEntries()
  } catch { /* 拦截器处理 */ } finally {
    busyId.value = ''
  }
}

/** 全选/取消（三态框）：toggleMany 对全量 id 本就是双向收敛——部分/未选中
 *  点一次补选为全选，全选中再点一次全组取消，与通知中心「全选当前列表」同语义 */
function toggleSelectAll() {
  toggleMany(allIds.value)
}

/**
 * 批量恢复（P-20261005-175）：逐项走既有 restore 端点的部分成功编排——
 * 409 同名冲突 / degraded 信息缺失跳过并计入回告（「N 恢复 / M 跳过」，
 * P-288 广播 written/missing/failed 同款回告惯例），单条失败不中断批次；
 * 跳过条目留在列表与选中集，用户可先行清理占位文件后对剩余项重试。
 * 串行循环：trash 操作是低频盘面动作，条目上限 trashListMax(500) 内串行
 * 足够，且避免并发 rename 同目录竞态
 */
async function batchRestore() {
  if (batchBusy.value || busyId.value) return
  const targets = selectedTargets.value
  if (targets.length < 2) return
  batchBusy.value = true
  let restored = 0
  let skipped = 0
  try {
    for (const e of targets) {
      if (e.degraded) { skipped++; continue } // 原路径不可知，服务端必 404，就地跳过
      try {
        await trashApi.restore(props.projectId, e.id, { silent: true })
        restored++
      } catch {
        skipped++ // 409 同名等预期失败：汇总回告，不中断批次、不逐条叠 toast
      }
    }
  } finally {
    batchBusy.value = false
  }
  if (restored > 0) emit('restored')
  if (skipped === 0) {
    message.success(t('files.trash.batchRestored', { n: restored }))
  } else if (restored > 0) {
    message.warning(t('files.trash.batchRestoreSkipped', { restored, skipped }))
  } else {
    message.error(t('files.trash.batchRestoreSkipped', { restored, skipped }))
  }
  await fetchEntries()
}

/**
 * 批量彻底删：单次确认弹层先清点（N 文件 / M 目录），确认后逐项走既有
 * purge 端点（silent 免逐条拦截器 toast，失败计入回告）。purge 不可恢复，
 * 确认文案与单条删除同一「不可恢复」口径
 */
async function batchPurge() {
  if (batchBusy.value || busyId.value) return
  const targets = selectedTargets.value
  if (targets.length < 2) return
  const files = targets.filter(e => !e.isDir).length
  const dirs = targets.filter(e => e.isDir).length
  if (!await confirmDialog({
    type: 'error',
    title: t('files.trash.batchPurgeTitle'),
    content: t('files.trash.confirmBatchPurge', { files, dirs }),
  })) return
  batchBusy.value = true
  let purged = 0
  let failed = 0
  try {
    for (const e of targets) {
      try {
        await trashApi.purge(props.projectId, e.id, { silent: true })
        purged++
      } catch {
        failed++
      }
    }
  } finally {
    batchBusy.value = false
  }
  if (failed === 0) {
    message.success(t('files.trash.batchPurged', { n: purged }))
  } else {
    message.warning(t('files.trash.batchPurgeFailed', { purged, failed }))
  }
  await fetchEntries()
}

watch(() => [props.show, props.projectId], ([show]) => {
  if (show) void fetchEntries()
})
onMounted(() => {
  if (props.show) void fetchEntries()
})
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    :title="t('files.trash.title')"
    :style="{ width: 'var(--modal-w-lg)', maxWidth: '94vw' }"
    :bordered="false"
    class="trash-modal"
    data-testid="trash-modal"
    @update:show="emit('update:show', $event)"
  >
    <div class="trash-body">
      <div
        v-if="loading"
        class="trash-loading"
      >
        <n-spin size="small" />
      </div>
      <n-empty
        v-else-if="entries.length === 0"
        :description="t('files.trash.empty')"
        class="trash-empty"
      >
        <template #icon>
          <n-icon><TrashBinOutline /></n-icon>
        </template>
      </n-empty>
      <div
        v-else
        class="trash-list"
      >
        <div class="trash-head">
          <n-checkbox
            data-testid="trash-select-all"
            :checked="selectAllState === 'all'"
            :indeterminate="selectAllState === 'some'"
            :aria-label="t('files.trash.selectAll')"
            @update:checked="toggleSelectAll"
          />
          <span class="trash-head-count">{{ t('files.trash.count', { n: entries.length }) }}</span>
        </div>
        <div
          v-if="showBatchBar"
          class="trash-batch-bar"
          data-testid="trash-batch-bar"
        >
          <n-button
            size="tiny"
            type="primary"
            :loading="batchBusy"
            :disabled="!!busyId || batchRestorableCount === 0"
            data-testid="trash-batch-restore"
            @click="batchRestore"
          >
            {{ t('files.trash.batchRestore', { n: selectedCount }) }}
          </n-button>
          <n-button
            size="tiny"
            type="error"
            ghost
            :loading="batchBusy"
            :disabled="!!busyId"
            data-testid="trash-batch-purge"
            @click="batchPurge"
          >
            {{ t('files.trash.batchPurge', { n: selectedCount }) }}
          </n-button>
        </div>
        <div
          v-for="e in entries"
          :key="e.id"
          class="trash-item"
          data-testid="trash-item"
        >
          <n-checkbox
            class="trash-item-check"
            data-testid="trash-item-check"
            :checked="isSelected(e.id)"
            :disabled="batchBusy"
            :aria-label="e.name"
            @update:checked="toggle(e.id)"
          />
          <div class="trash-item-main">
            <div
              class="trash-item-name"
              :title="e.path || e.name"
            >
              <span>{{ e.name }}</span>
              <span
                v-if="e.isDir"
                class="trash-item-dir"
              >/</span>
              <NTag
                v-if="e.degraded"
                size="tiny"
                :bordered="false"
                class="trash-item-degraded"
              >
                {{ t('files.trash.degraded') }}
              </NTag>
              <!-- 敏感徽标（P-20261005-163）：与剩 N 天徽标（P-20261005-155）同排
                   同语义色系（accent-orange，六主题变量）——驻留风险前置到决策面 -->
              <NTag
                v-if="isSensitiveEntry(e)"
                size="tiny"
                :bordered="false"
                class="trash-item-sensitive"
                data-testid="trash-item-sensitive"
              >
                {{ t('files.trash.sensitive') }}
              </NTag>
              <NTag
                size="tiny"
                :bordered="false"
                class="trash-item-days"
                :class="{ 'trash-item-days-urgent': daysLeftOf(e.deletedAtMs) <= 1 }"
                data-testid="trash-item-days"
              >
                {{ daysLeftText(e.deletedAtMs) }}
              </NTag>
            </div>
            <div class="trash-item-meta">
              {{ e.path || t('files.trash.pathUnknown') }} · {{ formatSize(e.size < 0 ? 0 : e.size) }} · {{ formatTs(e.deletedAtMs) }}
            </div>
            <!-- 行内驻留提示（P-20261005-163）：敏感删除物 7 天窗口内明文躺在
                 数据目录——徽标只点名，这句给「为什么敏感要紧」的可行动语境 -->
            <div
              v-if="isSensitiveEntry(e)"
              class="trash-item-sensitive-hint"
            >
              {{ t('files.trash.sensitiveHint') }}
            </div>
          </div>
          <div class="trash-item-actions">
            <!-- 敏感条目快捷彻底删（P-20261005-163）：前置实心钮把「点名→清除」
                 降为行内一击（走同一 purge 处理器，确认弹层沿既有文案）；敏感行
                 隐去常规 ghost 彻底删，同动作不在一行双钮。驻留风险自身就是删除
                 理由，故允许比恢复更靠前的视觉位 -->
            <n-button
              v-if="isSensitiveEntry(e)"
              size="tiny"
              type="error"
              :loading="busyId === e.id"
              :disabled="(!!busyId && busyId !== e.id) || batchBusy"
              data-testid="trash-purge-urgent"
              @click="purge(e)"
            >
              {{ t('files.trash.purgeNow') }}
            </n-button>
            <n-button
              v-if="!e.degraded"
              size="tiny"
              :loading="busyId === e.id"
              :disabled="(!!busyId && busyId !== e.id) || batchBusy"
              data-testid="trash-restore"
              @click="restore(e)"
            >
              {{ t('files.trash.restore') }}
            </n-button>
            <n-button
              v-if="!isSensitiveEntry(e)"
              size="tiny"
              type="error"
              ghost
              :loading="busyId === e.id"
              :disabled="(!!busyId && busyId !== e.id) || batchBusy"
              data-testid="trash-purge"
              @click="purge(e)"
            >
              {{ t('files.trash.purge') }}
            </n-button>
          </div>
        </div>
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
.trash-body { min-height: 240px; max-height: 62vh; display: flex; flex-direction: column; }
.trash-loading { flex: 1; display: flex; align-items: center; justify-content: center; }
.trash-empty { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px 0; }
.trash-head {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; font-size: 12px; color: var(--text-dim);
  border-bottom: 1px solid var(--border-default); background: var(--bg-panel);
}
.trash-list { overflow-y: auto; }
.trash-batch-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; background: var(--bg-panel);
  border-bottom: 1px solid var(--border-default);
}
.trash-item {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-bottom: 1px solid var(--bg-panel);
}
.trash-item:hover { background: var(--bg-hover); }
.trash-item-check { flex-shrink: 0; }
.trash-item-main { flex: 1; min-width: 0; }
.trash-item-name {
  font-size: 13px; color: var(--text-body);
  display: flex; align-items: center; gap: 4px; min-width: 0;
}
.trash-item-name > span:first-child {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.trash-item-dir { color: var(--text-dim); flex-shrink: 0; }
.trash-item-degraded { flex-shrink: 0; }
.trash-item-days { flex-shrink: 0; }
/* 临期（≤1 天）橙强调：accent-orange 主题变量，AgentSidebarProjectTree 锁徽标同款语义 */
.trash-item-days-urgent { color: var(--accent-orange); }
/* 敏感徽标/提示行（P-20261005-163）：accent-orange 与临期徽标同变量（风险
 * 色系一处语义），标签底色不动 naive 默认——只点字色即足够辨识 */
.trash-item-sensitive { flex-shrink: 0; color: var(--accent-orange); }
.trash-item-sensitive-hint {
  font-size: 11px; color: var(--accent-orange); margin-top: 2px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.trash-item-meta {
  font-size: 11px; color: var(--text-dim); margin-top: 2px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.trash-item-actions { display: flex; gap: 6px; flex-shrink: 0; }
</style>
