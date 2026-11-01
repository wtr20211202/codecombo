<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NModal, NSpin } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { terminalApi } from '../../api/client'
import { remoteHostApi, type RemoteTerminalSessionRef } from '../../api/domains/remote'
import { useTerminalSessionsStore, type TerminalSessionInfo } from '../../stores/terminal-sessions'
import { useProjectStore } from '../../stores/project'
import { fetchWithEgressGate } from '../../composables/useEgressGate'
import { stripAnsiText } from '../../composables/useCommitSplitExecute'
import { safeAsync } from '../../utils/async-component'
import { ensureMonacoNls } from '../../utils/monaco-nls'

// 本弹层被 TerminalView（项目页急加载链）静态引入：若静态引入 DiffEditor 会把
// monaco 主模块的求值提到语言包（ensureMonacoNls）之前——原生右键菜单等
// 永久英文化（monaco 求值时缓存空 NLS，后到的语言包救不回）。必须走与
// EditorGroupPane/FileTreeView 同款「先 await 语言包再 import 编辑器组件」的门，
// monaco 求值顺序才成立（run20 五检点二分误判环境漂移的真根因）
const DiffEditor = safeAsync(() => ensureMonacoNls().then(() => import('../../views/editor/DiffEditor.vue').then(m => m.default)))

/**
 * 会话输出对比弹层（P-20261005-210）：同命令双环境 A/B 验证——「当前会话 ↔
 * 所选会话」的滚回文本 diff 一屏。三态机：
 *   pick    会话选择浮层（本地 shell / agent / 远程三组，排除当前会话自身）
 *   loading 双侧取数（本地·agent 走 P-100 服务端 ExportText 已剥 ANSI；远程无
 *           ExportText 原语，走既有远程 scrollback 端点 + 客户端 stripAnsiText）
 *   diff    DiffEditor 只读双栏（左=当前会话，右=所选会话）+ 行数摘要条
 * 时点快照语义（与 P-205 冻结同哲学）：取数完成即定格，不随后续输出刷新，
 * 标题/摘要条注明快照时刻。纯前端组装零新端点（agent 自比 = 直调双端 export）。
 * 敏感出域闸门（P-20261003-155）：任一本地侧会话被标记敏感，复用导出同款
 * warnings→confirm→override 契约（拒绝则退回选择浮层）。
 */
const props = defineProps<{
  show: boolean
  /** 左侧固定为发起对比的当前会话（tab 右键目标） */
  current: { id: string; name: string } | null
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
}>()

const { t } = useI18n()
const sessionsStore = useTerminalSessionsStore()
const projectStore = useProjectStore()

type Stage = 'pick' | 'loading' | 'diff' | 'error'

const stage = ref<Stage>('pick')
/** 右侧候选（pick 阶段选定后贯穿 loading/diff/error/retry） */
const picked = ref<Candidate | null>(null)
const leftText = ref('')
const rightText = ref('')
/** 各侧超长截断标记（大输出护栏：超限截断 + 摘要条如实提示） */
const leftTruncated = ref(false)
const rightTruncated = ref(false)
/** 快照时刻展示（diff 标题带；取数完成定格，后续不刷新） */
const snapshotLabel = ref('')
const errorMsg = ref('')
const diffStats = ref({ added: 0, removed: 0 })

// ============== 候选枚举（选择浮层三组） ==============

/** 会话选择浮层的统一候选形状：本地/agent 来自统一 store，远程来自聚合列表 */
interface Candidate {
  id: string
  name: string
  kind: 'shell' | 'agent' | 'remote'
  /** 第二行注记：shell=所属项目名 / agent=运行时 / remote=主机别名 */
  note: string
  hostId?: string
}

function shellNote(s: TerminalSessionInfo): string {
  return projectStore.projects.find(p => p.id === s.projectId)?.name || ''
}

const shellCandidates = computed<Candidate[]>(() =>
  sessionsStore.sessions
    .filter(s => s.kind === 'shell' && s.id !== props.current?.id)
    .map(s => ({ id: s.id, name: s.name, kind: 'shell' as const, note: shellNote(s) })),
)

const agentCandidates = computed<Candidate[]>(() =>
  sessionsStore.sessions
    .filter(s => s.kind === 'agent' && s.id !== props.current?.id)
    .map(s => ({ id: s.id, name: s.name, kind: 'agent' as const, note: s.runtime || '' })),
)

/** 远程候选（浮层打开时聚合拉取一次；广播候选同款口径——列表失败降级空组隐藏，
 * 服务端会话上限 20 量级无分页诉求） */
const remoteCandidates = ref<Candidate[]>([])

watch(() => props.show, (open) => {
  if (!open) return
  // 重开重置为选择浮层（快照是一次性语义：再看 = 重新取数新快照）
  stage.value = 'pick'
  picked.value = null
  diffStats.value = { added: 0, removed: 0 }
  // store 平时只消费项目 tab 可能未 loaded（广播候选同款兜底）；两路独立拉取
  // 互不阻塞——远程列表失败降级空组隐藏，不打断本地/agent 组
  if (!sessionsStore.loaded) void sessionsStore.refresh()
  void remoteHostApi.listAllTerminals({ silent: true }).then((res) => {
    const list = ((res as unknown as { data?: RemoteTerminalSessionRef[] })?.data ?? [])
    remoteCandidates.value = list
      .filter(r => r.id !== props.current?.id)
      .map(r => ({ id: r.id, name: `#${r.id.slice(0, 8)}`, kind: 'remote' as const, note: r.host, hostId: r.hostId }))
  }).catch(() => { remoteCandidates.value = [] })
})

// ============== 取数（双侧） ==============

// 大输出护栏：native 环形容量钳制 ≤16MB，16MB 级 model 对进 Monaco diff 必冻
// 结——每侧截到 2MB 字符（≈2 万行终端输出量级），截断在摘要条如实提示。P-75
// 任意两文件对比走服务端 filePolicy too-large 拦截同哲学，这里是客户端兜底
const MAX_SIDE_CHARS = 2 * 1024 * 1024

/** 滚回首尾空白行裁剪（P-20261005-210）：native 会话创建默认尺寸→客户端 resize
 *  的 ConPTY 重排会在缓冲头尾留下大段空行（实测 20~35 行纯 \r\n），原样进 diff
 *  则顶部全是无信息空行变更、有效内容沉底出 Monaco 虚拟化视口（摘要点数也被
 *  空行差稀释）。只裁首尾空白行的展示级归一（CRLF 的 \r 计入空白判定）——
 *  中段空行可能是命令输出的有意空行，保留 */
function trimBlankEdges(text: string): string {
  const lines = text.split('\n')
  const isBlank = (l: string) => l.trim() === ''
  let start = 0
  let end = lines.length
  while (start < end && isBlank(lines[start]!)) start++
  while (end > start && isBlank(lines[end - 1]!)) end--
  return lines.slice(start, end).join('\n')
}

function clampSide(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_SIDE_CHARS) return { text, truncated: false }
  return { text: text.slice(0, MAX_SIDE_CHARS), truncated: true }
}

/** 用户在敏感确认选「否」：整场对比取消退回选择浮层（区别于取数失败） */
class SensitiveDeclined extends Error {}

/** 本地/agent 侧取数：P-100 ExportText 链（服务端已剥 ANSI）。出域闸门与导出
 *  （exportOutputTabFile）同契约：JSON warnings（会话标记 + 内容敏感）→ 一次
 *  确认 → override=1&confirm=1 重取；取消/已确认仍被拦 → 整场对比取消 */
async function fetchLocalText(id: string, name: string): Promise<string> {
  const blob = await fetchWithEgressGate(
    confirm => terminalApi.exportOutput(
      id,
      confirm ? { params: { override: '1', confirm: '1' } } : undefined,
    ) as unknown as Promise<Blob>,
    name,
  )
  if (!blob) throw new SensitiveDeclined()
  return await blob.text()
}

/** 远程侧取数：既有远程 scrollback 端点（裸字节含 ANSI）+ 客户端剥 ANSI
 *  （stripAnsiText 单实现复用）。主机离线/会话回收在此失败，交 error 态如实呈现 */
async function fetchRemoteText(hostId: string, sessionId: string): Promise<string> {
  // 响应拦截器直回 body：AxiosResponse 外壳已剥，运行时即 ArrayBuffer（仓内
  // as unknown as 收窄惯例，exportOutput blob 直调同款）
  const buf = (await remoteHostApi.terminalScrollback(hostId, sessionId)) as unknown as ArrayBuffer
  return stripAnsiText(buf)
}

async function runCompare(): Promise<void> {
  const cur = props.current
  const cand = picked.value
  if (!cur || !cand) return
  stage.value = 'loading'
  errorMsg.value = ''
  diffStats.value = { added: 0, removed: 0 }
  try {
    // 快照时刻取「开始取数」时点：两侧内容与该时刻对齐（完成时刻展示不改变语义）
    const at = new Date()
    const [left, right] = await Promise.all([
      fetchLocalText(cur.id, cur.name),
      cand.kind === 'remote'
        ? fetchRemoteText(cand.hostId || '', cand.id)
        : fetchLocalText(cand.id, cand.name),
    ])
    const lc = clampSide(trimBlankEdges(left))
    const rc = clampSide(trimBlankEdges(right))
    leftText.value = lc.text
    rightText.value = rc.text
    leftTruncated.value = lc.truncated
    rightTruncated.value = rc.truncated
    snapshotLabel.value = at.toLocaleTimeString()
    stage.value = 'diff'
  } catch (e) {
    if (e instanceof SensitiveDeclined) {
      // 用户拒绝敏感出域：不是故障，退回选择浮层可换目标
      stage.value = 'pick'
      return
    }
    errorMsg.value = cand.kind === 'remote'
      ? t('terminal.compare.remoteFetchFailed', { host: cand.note })
      : t('terminal.compare.fetchFailed', { name: cand.name })
    stage.value = 'error'
  }
}

function pick(c: Candidate): void {
  picked.value = c
  void runCompare()
}

/** error 态重试：同候选重新取数（主机恢复在线/瞬时失败的自愈出口） */
function retry(): void {
  void runCompare()
}

// ============== diff 呈现 ==============

function onDiffStats(s: { added: number; removed: number }): void {
  diffStats.value = s
}

const anyTruncated = computed(() => leftTruncated.value || rightTruncated.value)
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    class="term-compare-modal"
    :title="t('terminal.compare.title')"
    :bordered="false"
    size="small"
    data-testid="term-compare-modal"
    @update:show="emit('update:show', $event)"
  >
    <!-- ① 会话选择浮层：本地 shell / agent / 远程三组（排除当前会话自身） -->
    <div
      v-if="stage === 'pick'"
      class="tcm-pick"
      data-testid="term-compare-pick"
    >
      <div class="tcm-pick-hint">
        {{ t('terminal.compare.pickHint', { name: current?.name || '' }) }}
      </div>
      <template v-if="shellCandidates.length">
        <div class="tcm-group-head">
          {{ t('terminal.compare.groupShell') }}
        </div>
        <button
          v-for="c in shellCandidates"
          :key="c.id"
          class="tcm-item"
          :data-testid="'term-compare-cand-' + c.id"
          @click="pick(c)"
        >
          <span
            class="tcm-item-name"
            :title="c.name"
          >{{ c.name }}</span>
          <span
            v-if="c.note"
            class="tcm-item-note"
          >{{ c.note }}</span>
        </button>
      </template>
      <template v-if="agentCandidates.length">
        <div class="tcm-group-head">
          {{ t('terminal.compare.groupAgent') }}
        </div>
        <button
          v-for="c in agentCandidates"
          :key="c.id"
          class="tcm-item"
          :data-testid="'term-compare-cand-' + c.id"
          @click="pick(c)"
        >
          <span
            class="tcm-item-name"
            :title="c.name"
          >{{ c.name }}</span>
          <span
            v-if="c.note"
            class="tcm-item-note"
          >{{ c.note }}</span>
        </button>
      </template>
      <template v-if="remoteCandidates.length">
        <div class="tcm-group-head">
          {{ t('terminal.compare.groupRemote') }}
        </div>
        <button
          v-for="c in remoteCandidates"
          :key="c.id"
          class="tcm-item"
          :data-testid="'term-compare-cand-' + c.id"
          @click="pick(c)"
        >
          <span class="tcm-item-host">{{ c.note }}</span>
          <span
            class="tcm-item-name"
            :title="c.id"
          >{{ c.name }}</span>
        </button>
      </template>
      <div
        v-if="!shellCandidates.length && !agentCandidates.length && !remoteCandidates.length"
        class="tcm-empty"
      >
        {{ t('terminal.compare.noCandidate') }}
      </div>
    </div>

    <!-- ② 双侧取数中 -->
    <div
      v-else-if="stage === 'loading'"
      class="tcm-state"
      data-testid="term-compare-loading"
    >
      <n-spin size="small" />
      <span>{{ t('terminal.compare.loading', { name: picked?.name || '' }) }}</span>
    </div>

    <!-- ②' 取数失败如实降级（远程离线/会话已回收），重试=同候选重新快照 -->
    <div
      v-else-if="stage === 'error'"
      class="tcm-state tcm-error"
      data-testid="term-compare-error"
    >
      <span>{{ errorMsg }}</span>
      <n-button
        size="tiny"
        data-testid="term-compare-retry"
        @click="retry"
      >
        {{ t('common.retry') }}
      </n-button>
      <n-button
        size="tiny"
        @click="stage = 'pick'"
      >
        {{ t('terminal.compare.backToPick') }}
      </n-button>
    </div>

    <!-- ③ DiffEditor 只读双栏 + 快照时刻 + 行数摘要条 -->
    <template v-else>
      <div
        class="tcm-head"
        data-testid="term-compare-head"
      >
        <span
          class="tcm-head-name"
          :title="current?.name"
        >{{ current?.name }}</span>
        <span class="tcm-head-vs">↔</span>
        <span
          class="tcm-head-name"
          :title="picked?.name"
        >{{ picked?.name }}</span>
        <span
          class="tcm-head-time"
          :title="t('terminal.compare.snapshotAt', { time: snapshotLabel })"
        >{{ t('terminal.compare.snapshotAt', { time: snapshotLabel }) }}</span>
      </div>
      <div
        class="tcm-stats"
        data-testid="term-compare-stats"
        :title="t('terminal.compare.statsTip', { time: snapshotLabel })"
      >
        <!-- 摘要条（+N/-M）：行数取 DiffEditor getLineChanges 视图真值（与高亮一致）。
             侧别语义 = 左侧（当前会话）为基准：+N 右侧多出的行 / -M 左侧独有的行 -->
        <span
          v-if="anyTruncated"
          class="tcm-stat-truncated"
          :title="t('terminal.compare.truncatedTip', { max: MAX_SIDE_CHARS })"
        >{{ t('terminal.compare.truncated') }}</span>
        <span class="tcm-stat-added">+{{ diffStats.added }}</span>
        <span class="tcm-stat-removed">-{{ diffStats.removed }}</span>
      </div>
      <div class="tcm-diff-host">
        <DiffEditor
          :old-content="leftText"
          :new-content="rightText"
          :old-label="current?.name || ''"
          :new-label="picked?.name || ''"
          auto-reveal-first-change
          @diff-stats="onDiffStats"
        />
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.term-compare-modal {
  /* 双栏 diff 需宽度（并排在窄视口由 DiffEditor 内建 900px 断点自动转行内）；
   * min() 上限封顶防超宽屏失控，窄屏随视口收缩不溢出 */
  width: min(86vw, 1400px);
}
.tcm-pick { max-height: 50vh; overflow-y: auto; }
.tcm-pick-hint { font-size: 12px; color: var(--text-secondary); margin-bottom: 6px; }
.tcm-group-head {
  padding: 6px 0 3px;
  font-size: 11px;
  color: var(--text-dim);
}
.tcm-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 8px;
  border: none;
  background: none;
  cursor: pointer;
  text-align: left;
  font-size: 12px;
  color: var(--text-body);
  border-radius: 4px;
}
.tcm-item:hover { background: var(--bg-hover); }
.tcm-item-name {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tcm-item-note,
.tcm-item-host {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-dim);
  border: 1px solid var(--border-default);
  border-radius: 3px;
  padding: 0 4px;
}
.tcm-empty { padding: 18px 0; text-align: center; font-size: 12px; color: var(--text-dim); }
.tcm-state {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 24px 0;
  justify-content: center;
  font-size: 12px;
  color: var(--text-secondary);
}
.tcm-error { color: var(--status-waiting); }
.tcm-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  min-width: 0;
}
.tcm-head-name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tcm-head-vs { color: var(--text-dim); flex-shrink: 0; }
.tcm-head-time {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-dim);
}
.tcm-stats {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-secondary);
  margin-bottom: 6px;
}
/* 状态徽标语义色四档（P-20261003-285）：+N/-M 与截断/错误提示一律引用语义名
 * 而非直引色相 accent——同语义跨面同色由主题映射表单一来源保证 */
.tcm-stat-added { color: var(--status-success); font-family: var(--font-mono, monospace); }
.tcm-stat-removed { color: var(--status-failed); font-family: var(--font-mono, monospace); }
.tcm-stat-truncated {
  color: var(--status-waiting);
  border: 1px solid var(--status-waiting);
  border-radius: 3px;
  padding: 0 4px;
}
.tcm-diff-host { height: 66vh; }
</style>
