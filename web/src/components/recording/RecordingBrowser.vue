<script setup lang="ts">
/**
 * 审批过程实况浏览（P-20261001-15）：recordings 元数据索引列表 + 回放器宿主。
 * 入口：审批卡「查看过程实况」（focusApprovalId 命中自动选中）与审批历史
 * （值班大屏入口，全量列表即审批录制的承载面）。
 * 列表项：op / agent / 状态 / 起止 / 大小；支持单条删除（隐私：屏幕实况可随
 * 时清除，服务端对活动录制先收尾）。空态提示录制默认关闭。
 * 「会话回放」（P-20261002-82）：录制自带 sessionId 的审批历史同款入口——
 * 经工作目录桥接打开发起会话的 Claude 时间线并定位到录制开始时刻。
 */
import { computed, ref, watch } from 'vue'
import { NButton, NEmpty, NIcon, NModal, NSpin, NTag, useMessage } from 'naive-ui'
import { CloseOutline, PlayOutline, ShareSocialOutline, TrashOutline, VideocamOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { recordingApi, type RecordingMeta } from '../../api/domains/recording'
import type { ClaudeSessionInfo } from '../../api/domains/claude'
import { agentLabelOf, useApprovalActions } from '../../composables/useApprovalActions'
import { useShareDialog } from '../../composables/useShareDialog'
import { formatBytes } from '../../utils/recording'
import CastReplayer from './CastReplayer.vue'
import SessionReplayModal from '../claude/SessionReplayModal.vue'

const props = defineProps<{
  show: boolean
  /** 审批卡入口：打开时自动选中含该审批标记的录制 */
  focusApprovalId?: string
}>()

const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const { t } = useI18n()
const message = useMessage()
const { resolveReplayTarget } = useApprovalActions()
// 会话回放分享（P-20261004-103）：与「分享输出快照」同族的异步 walkthrough
// 入口——把选中录制的 cast 生成为只读回放短链（默认 1 小时），结果卡由
// useShareDialog 单例弹出（Layout 挂载的 ShareResultDialog 消费）
const { createRecordingShare } = useShareDialog()

const list = ref<RecordingMeta[]>([])
const loading = ref(false)
const loaded = ref(false)
const selectedId = ref('')

const selected = computed(() => list.value.find((r) => r.id === selectedId.value) ?? null)

async function load(): Promise<void> {
  loading.value = true
  try {
    const res = (await recordingApi.list({ limit: 100 })) as unknown as { data?: RecordingMeta[] }
    list.value = res?.data ?? []
    loaded.value = true
    // 焦点优先：审批卡入口按审批标记选中；否则默认最新一条
    const focus = props.focusApprovalId
      ? list.value.find((r) => r.approvalIds?.includes(props.focusApprovalId!))
      : undefined
    selectedId.value = (focus ?? list.value[0])?.id ?? ''
  } catch {
    list.value = []
    loaded.value = true
  } finally {
    loading.value = false
  }
}

watch(
  () => props.show,
  (v) => {
    if (v) load()
  },
)

async function removeItem(r: RecordingMeta): Promise<void> {
  try {
    await recordingApi.remove(r.id)
    message.success(t('recording.deleted'))
    if (selectedId.value === r.id) selectedId.value = ''
    await load()
  } catch {
    message.error(t('recording.deleteFailed'))
  }
}

function fmtTime(v?: string): string {
  if (!v) return '—'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

function statusType(r: RecordingMeta): 'warning' | 'default' {
  return r.status === 'recording' ? 'warning' : 'default'
}

// 会话回放（P-20261002-82）：审批历史列表项（含 sessionId 的录制）同款入口，
// 定位时刻取录制开始（审批窗口的起点）。解析失败 toast 降级、不开弹层
const replaySession = ref<ClaudeSessionInfo | null>(null)
const replayFocusAt = ref('')
async function openReplay(r: RecordingMeta): Promise<void> {
  const target = await resolveReplayTarget(r.sessionId, r.startedAt)
  if (!target) return
  replayFocusAt.value = r.startedAt || ''
  replaySession.value = target
}

// 分享回放（P-20261004-103）：把该录制的 cast 生成为只读回放短链（异步
// walkthrough）。录制中也可分享（创建时快照定格当前内容）；无输出/空录制
// 由服务端 400 拦截（toast 具体原因），共享管理面同族端点复用
function shareReplay(r: RecordingMeta): void {
  void createRecordingShare(r.id)
}
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    class="rb-modal"
    :title="t('recording.title')"
    :bordered="false"
    @update:show="emit('update:show', $event)"
  >
    <div class="rb-root">
      <div class="rb-side">
        <n-spin
          :show="loading"
          size="small"
        >
          <n-empty
            v-if="loaded && list.length === 0"
            :description="t('recording.empty')"
            class="rb-empty"
          />
          <div
            v-else
            class="rb-list"
          >
            <button
              v-for="r in list"
              :key="r.id"
              class="rb-item"
              :class="{ 'is-active': r.id === selectedId }"
              @click="selectedId = r.id"
            >
              <div class="rb-item-head">
                <n-tag
                  size="small"
                  :type="statusType(r)"
                  round
                >
                  {{ r.status === 'recording' ? t('recording.liveBadge') : t('recording.done') }}
                </n-tag>
                <span
                  v-if="r.agent"
                  class="rb-agent"
                >{{ agentLabelOf(r.agent, t('recording.agentUnknown')) }}</span>
                <n-button
                  v-if="r.sessionId"
                  size="tiny"
                  quaternary
                  class="rb-replay"
                  :title="t('approval.replay.button')"
                  @click.stop="openReplay(r)"
                >
                  <n-icon size="13">
                    <PlayOutline />
                  </n-icon>
                </n-button>
                <n-button
                  size="tiny"
                  quaternary
                  class="rb-share"
                  :title="t('recording.shareReplay')"
                  :aria-label="t('recording.shareReplay')"
                  data-testid="recording-share"
                  @click.stop="shareReplay(r)"
                >
                  <n-icon size="13">
                    <ShareSocialOutline />
                  </n-icon>
                </n-button>
                <n-button
                  size="tiny"
                  quaternary
                  class="rb-del"
                  :title="t('recording.delete')"
                  @click.stop="removeItem(r)"
                >
                  <n-icon size="13">
                    <TrashOutline />
                  </n-icon>
                </n-button>
              </div>
              <div
                class="rb-item-op"
                :title="r.target"
              >
                {{ r.op || '—' }}
              </div>
              <div class="rb-item-meta">
                {{ fmtTime(r.startedAt) }} · {{ formatBytes(r.sizeBytes) }}
              </div>
            </button>
          </div>
        </n-spin>
      </div>

      <div class="rb-main">
        <template v-if="selected">
          <div class="rb-main-head">
            <n-icon size="14">
              <VideocamOutline />
            </n-icon>
            <span
              class="rb-main-op"
              :title="selected.target"
            >{{ selected.op || selected.id }}</span>
            <n-button
              size="tiny"
              quaternary
              :title="t('common.close')"
              @click="emit('update:show', false)"
            >
              <n-icon size="14">
                <CloseOutline />
              </n-icon>
            </n-button>
          </div>
          <CastReplayer
            :key="selected.id"
            :recording="selected"
            @drafted="emit('update:show', false)"
          />
        </template>
        <n-empty
          v-else
          :description="t('recording.selectHint')"
          class="rb-empty"
        />
      </div>
    </div>
  </n-modal>
  <!-- 会话回放（P-20261002-82）：审批历史列表项直达发起会话的时间线 -->
  <SessionReplayModal
    :show="!!replaySession"
    :session="replaySession"
    :focus-at="replayFocusAt"
    @update:show="(v: boolean) => { if (!v) replaySession = null }"
  />
</template>

<style scoped>
.rb-modal { width: min(960px, 92vw); }
.rb-root { display: flex; gap: 12px; min-height: 420px; }
.rb-side { width: 260px; flex-shrink: 0; display: flex; flex-direction: column; min-height: 0; }
.rb-list { display: flex; flex-direction: column; gap: 6px; max-height: 60vh; overflow-y: auto; padding-right: 2px; }
.rb-item {
  border: 1px solid var(--border-default); border-radius: 8px; padding: 8px 10px;
  background: transparent; color: var(--text-primary); text-align: left; cursor: pointer;
}
.rb-item.is-active { border-color: var(--accent-primary, var(--accent-yellow-warm)); }
.rb-item-head { display: flex; align-items: center; gap: 6px; }
.rb-agent { font-size: 0.72em; color: var(--text-secondary); }
.rb-replay { margin-left: auto; }
.rb-item-op { margin-top: 4px; font-size: 0.8em; font-family: monospace; word-break: break-all;
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.rb-item-meta { margin-top: 4px; font-size: 0.7em; color: var(--text-muted); }
.rb-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.rb-main-head { display: flex; align-items: center; gap: 6px; }
.rb-main-op { font-size: 0.85em; font-family: monospace; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; flex: 1; }
.rb-empty { margin: auto; }
</style>
