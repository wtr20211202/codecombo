<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
// 应用未全局注册 naive-ui：模板里用到的组件必须显式 import（历史回归教训）
import { NButton, NEmpty, NIcon, NInput, NModal, NSelect, NSpin } from 'naive-ui'
import { ChatbubbleEllipsesOutline, FolderOpenOutline, GitNetworkOutline, RefreshOutline, TimeOutline } from '@vicons/ionicons5'
import BrandIcon from '../common/BrandIcon.vue'
import { useI18n } from '../../composables/useI18n'
import { useInstanceRelay } from '../../composables/useInstanceRelay'
import { instanceFetch } from '../../api/instanceFetch'
import { useInstanceStore } from '../../stores/instance'
import { useContextWarnStore } from '../../stores/contextWarn'
import { isLowRemaining } from '../../utils/sessionRelay'
import type { ClaudeSessionInfo } from '../../api/domains/claude'

/**
 * 从实例接力弹层（P-20261003-218）：会话中心工具条「从实例接力」入口——选
 * 来源实例 + 会话，把该会话 timeline 尾部结论注入**本实例**新开会话（取数/
 * 装箱/创建收口 useInstanceRelay，复用 P-114 接力链；宿主接线由 ClaudeSessionPicker
 * 完成，与行内接力同一「选中刚创建的会话」语义）。
 *
 * - 数据通道 = P-125 跨实例聚合同款 instanceFetch（本机 = 同源 /api，远程 =
 *   回环代理 /proxy/<id>/api 带锁令牌）；**只读边界**：本弹层对远端只发 GET
 *   （会话列表），写回零——远端数据面零触碰
 * - 来源实例清单 = 登记实例里除去「当前所在实例」（本机接力的行内入口已覆盖
 *   当前实例）；「本机」项仅在用户正看着远程实例时出现（id 恒 'local'，名字
 *   取中心实例——InstanceSessionOverview 块 0 同口径）
 * - 检索/分页与会话中心同构：q 服务端过滤（远端同样有 5s 护栏）+ limit=50
 *   「加载更多」；远端不可达显示降级态，刷新可重试（失败可恢复）
 */
const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  /** 接力成功：携带本实例新会话 id（宿主激活 + 开管理页，与行内接力同接线） */
  (e: 'relayed', sessionId: string): void
}>()

const { t } = useI18n()
const instanceStore = useInstanceStore()
const contextWarn = useContextWarnStore()
const { relayingId, relayFrom } = useInstanceRelay()

// ============== 来源实例清单（除去当前所在实例） ==============
const instanceId = ref('')
/** 实例健康态后缀：offline/invalid 的来源实例在选择器里就地可见（选择即可知情，
 *  选中后拉取失败还有降级态兜底）；unknown（未探测完）不加后缀 */
function statusSuffix(id: string): string {
  const st = instanceStore.instances.find(i => i.id === id)?.status
  return st === 'offline' || st === 'invalid' ? ` (${t('instanceSessions.unreachable')})` : ''
}
const instanceOptions = computed(() => {
  const cur = instanceStore.currentInstanceId
  const central = instanceStore.instances.find(i => i.isLocal)
  const opts: Array<{ label: string; value: string }> = []
  // 本机（中心实例）：id 恒 'local'（instanceFetch 口径），名字取中心实例而非
  // currentInstance——视图切在远程实例上时不能把中心数据标成远程实例名
  if (cur !== 'local') opts.push({ label: (central?.name || 'Local') + statusSuffix('local'), value: 'local' })
  for (const i of instanceStore.instances) {
    if (i.isLocal || i.id === cur) continue
    opts.push({ label: i.name + statusSuffix(i.id), value: i.id })
  }
  return opts
})
// 成功提示里的实例名取登记名原样（不带健康态后缀——提示面要的是名字不是状态）
const selectedName = computed(() => {
  if (instanceId.value === 'local') return instanceStore.instances.find(i => i.isLocal)?.name || 'Local'
  return instanceStore.instances.find(i => i.id === instanceId.value)?.name || ''
})

watch(() => props.show, (v) => {
  if (!v) return
  // 打开即重置：接力是一次性动作，残留上一轮的实例选择/检索词易误接力
  instanceId.value = ''
  searchInput.value = ''
  q.value = ''
  rows.value = []
  total.value = 0
  reachable.value = true
  void instanceStore.fetchInstances().then(() => {
    // 清单就绪后默认选第一项（实例删除/登记变化的陈旧值兜底）
    if (!instanceOptions.value.some(o => o.value === instanceId.value)) {
      instanceId.value = instanceOptions.value[0]?.value || ''
    }
    if (instanceId.value) void fetchPage(0, false)
  })
})

// ============== 远端会话列表（只读 GET，检索/分页同会话中心） ==============
const rows = ref<ClaudeSessionInfo[]>([])
const total = ref(0)
const loading = ref(false)
const loadingMore = ref(false)
const reachable = ref(true)
const LIMIT = 50
const searchInput = ref('')
const q = ref('')

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let querySeq = 0

async function fetchPage(offset: number, append: boolean) {
  if (!instanceId.value) return
  const seq = ++querySeq
  if (append) loadingMore.value = true
  else loading.value = true
  try {
    // 只读边界：GET /claude/sessions 经回环代理打远端，远端列表端点自带
    // 分页/检索护栏（与本机同一段服务端代码）
    const params = new URLSearchParams({
      limit: String(LIMIT),
      offset: String(offset),
      withPressure: 'true',
    })
    if (q.value) params.set('q', q.value)
    const res = await instanceFetch<{ data?: { sessions?: ClaudeSessionInfo[]; total?: number } }>(
      instanceId.value, 'GET', `/claude/sessions?${params.toString()}`)
    if (seq !== querySeq) return // 竞态丢弃：已有更新请求在途
    reachable.value = true
    const list = res?.data?.sessions ?? []
    total.value = res?.data?.total ?? 0
    rows.value = append ? [...rows.value, ...list] : list
  } catch {
    if (seq === querySeq) {
      reachable.value = false // 不可达降级：清列表出提示，刷新可重试
      rows.value = []
      total.value = 0
    }
  } finally {
    if (seq === querySeq) {
      loading.value = false
      loadingMore.value = false
    }
  }
}

function onSearchInput(v: string) {
  searchInput.value = v
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    q.value = v.trim()
    void fetchPage(0, false)
  }, 300)
}

function refreshList() {
  void fetchPage(0, false)
}

function loadMore() {
  if (rows.value.length < total.value) void fetchPage(rows.value.length, true)
}

// ============== 接力（行点击即触发；成功走宿主接线） ==============
async function onRelay(s: ClaudeSessionInfo) {
  if (relayingId.value) return
  const id = await relayFrom(instanceId.value, selectedName.value, s)
  if (!id) return
  emit('update:show', false)
  emit('relayed', id)
}

/** cwd 末段目录名（远端路径同样兼容 / \ 两分隔符，与 picker folderName 同语义） */
function folderName(cwd: string): string {
  return cwd.split(/[\\/]/).pop() || cwd
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer)
})
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    :title="t('claudeSessions.instanceRelay.title')"
    :style="{ width: 'var(--modal-w-lg)', maxWidth: '94vw' }"
    :bordered="false"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <!-- 只读边界注记（任务书②）：跨实例拉取零写回，打消「会不会动远端」的顾虑 -->
    <div
      class="ird-note"
      data-test="instance-relay-note"
    >
      <n-icon size="12">
        <GitNetworkOutline />
      </n-icon>{{ t('claudeSessions.instanceRelay.readOnlyNote') }}
    </div>

    <div class="ird-toolbar">
      <n-select
        v-model:value="instanceId"
        size="small"
        :options="instanceOptions"
        :placeholder="t('claudeSessions.instanceRelay.pickInstance')"
        :disabled="instanceOptions.length === 0 || relayingId !== ''"
        data-test="instance-relay-instance"
        @update:value="refreshList"
      />
      <n-button
        size="small"
        quaternary
        :disabled="!instanceId"
        :title="t('instanceSessions.refresh')"
        data-test="instance-relay-refresh"
        @click="refreshList"
      >
        <template #icon>
          <n-icon size="12">
            <RefreshOutline />
          </n-icon>
        </template>
      </n-button>
    </div>

    <n-input
      v-if="instanceId"
      size="small"
      clearable
      :placeholder="t('claudeSessions.instanceRelay.searchPlaceholder')"
      :value="searchInput"
      data-test="instance-relay-search"
      @update:value="onSearchInput"
    />

    <div
      class="ird-list"
      data-test="instance-relay-list"
    >
      <!-- 无可接力实例：登记入口引导（新入口可发现、空态可行动） -->
      <n-empty
        v-if="instanceOptions.length === 0"
        size="small"
        :description="t('claudeSessions.instanceRelay.noInstances')"
        class="ird-empty"
      />
      <template v-else-if="instanceId">
        <n-spin
          v-if="loading && reachable"
          size="small"
          class="ird-loading"
        />
        <!-- 不可达降级态：如实告知 + 刷新可重试（失败可恢复） -->
        <div
          v-else-if="!reachable"
          class="ird-unreachable"
          data-test="instance-relay-unreachable"
        >
          {{ t('claudeSessions.instanceRelay.unreachable') }}
        </div>
        <n-empty
          v-else-if="rows.length === 0"
          size="small"
          :description="q ? t('claudeSessions.noMatch') : t('claudeSessions.instanceRelay.empty')"
          class="ird-empty"
        />
        <template v-else>
          <button
            v-for="s in rows"
            :key="s.id"
            class="ird-row"
            :class="{ 'is-busy': relayingId === s.id }"
            :data-test="`instance-relay-row-${s.id}`"
            :title="t('claudeSessions.instanceRelay.rowTip')"
            :disabled="relayingId !== ''"
            @click="onRelay(s)"
          >
            <BrandIcon
              name="claude"
              :size="14"
              class="ird-row-icon"
            />
            <span class="ird-row-main">
              <span class="ird-row-title">{{ s.title }}</span>
              <span class="ird-row-meta">
                <span
                  class="ird-meta-seg"
                  :title="s.cwd"
                >
                  <n-icon size="10">
                    <FolderOpenOutline />
                  </n-icon>{{ folderName(s.cwd) }}
                </span>
                <span class="ird-meta-seg">
                  <n-icon size="10">
                    <TimeOutline />
                  </n-icon>{{ fmtTime(s.lastAt) }}
                </span>
                <span class="ird-meta-seg">
                  <n-icon size="10">
                    <ChatbubbleEllipsesOutline />
                  </n-icon>{{ s.messageCount }}
                </span>
              </span>
            </span>
            <!-- 接力角标：仅非活跃行（结论未定型不接力）；低余量活跃行常显
                 （P-141 换代入口例外，与本机接力行同口径，阈值用户可调
                 P-20261006-33）；取数中 is-busy -->
            <span
              v-if="!s.active || isLowRemaining(s.pressure, contextWarn.pct)"
              class="ird-row-relay"
              data-test="instance-relay-go"
            >{{ t('claudeSessions.relay.badge') }}</span>
            <span
              v-else
              class="ird-row-live"
            >{{ t('claudeSessions.active') }}</span>
          </button>
          <div
            v-if="rows.length < total"
            class="ird-more"
          >
            <n-button
              size="tiny"
              quaternary
              :loading="loadingMore"
              data-test="instance-relay-load-more"
              @click="loadMore"
            >
              {{ t('claudeSessions.loadMore', { n: total - rows.length }) }}
            </n-button>
          </div>
        </template>
      </template>
    </div>
  </n-modal>
</template>

<style scoped>
.ird-note {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-tertiary);
  margin-bottom: 10px;
}
.ird-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.ird-toolbar :first-child {
  flex: 1;
}
.ird-list {
  max-height: 52vh;
  overflow-y: auto;
  margin-top: 8px;
}
.ird-loading {
  display: block;
  margin: 24px auto;
}
.ird-unreachable {
  font-size: 12px;
  color: var(--accent-red);
  text-align: center;
  padding: 24px 0;
}
.ird-empty {
  margin: 24px 0;
}
.ird-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font-size: 12px;
}
.ird-row:hover { background: var(--bg-hover); }
.ird-row:disabled { cursor: default; opacity: 0.6; }
.ird-row-icon { flex-shrink: 0; }
.ird-row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.ird-row-title {
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ird-row-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--text-tertiary);
  font-size: 10px;
}
.ird-meta-seg {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 180px;
}
.ird-row-relay {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--accent-blue);
  background: var(--bg-hover);
  border-radius: 6px;
  padding: 1px 7px;
  opacity: 0;
  transition: opacity var(--motion-base);
}
.ird-row:hover .ird-row-relay,
.ird-row:focus-visible .ird-row-relay,
.ird-row.is-busy .ird-row-relay { opacity: 1; }
.ird-row.is-busy .ird-row-relay { color: var(--text-tertiary); }
.ird-row-live {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-tertiary);
}
.ird-more {
  text-align: center;
  padding: 4px 0;
}
</style>
