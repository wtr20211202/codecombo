<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NCheckbox, NIcon, NPopover, useMessage } from 'naive-ui'
import { RadioOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import type { BroadcastSendOutcome } from '../../composables/useTerminalBroadcast'
import type { RemoteTerminalSessionRef } from '../../api/domains/remote'

/**
 * 终端广播输入条（P-20261003-288 舰队式批量输入）：广播模式下出现在 tab 栏
 * 下方的单行输入面——目标计数 + popover 显式勾选（agent 会话 / 远程主机两组，
 * P-20261005-11 增远程分组：主机别名徽标与 agent 组并列）+ 文本输入 + 发送。
 * 纯 UI 组件：选中集与发送链在 useTerminalBroadcast（宿主注入），此处只做
 * 文案组装与结果回告（成功/部分成功/失败三态 toast）。
 * 输入历史（P-20261005-13）：数据（入史/去重置顶/封顶）在 composable，此处只
 * 做 ↑/↓ 巡历与聚焦下拉两用交互（clone-url-history 同族：mousedown.prevent
 * 保焦点、点选回填不直发）；与 Ctrl+Alt+V 剪贴板历史正交不拦截。
 */
const props = defineProps<{
  /** 广播目标数（tab 点选 + 显式勾选的 agent 会话 + 远程主机终端；<2 不可发送） */
  targetCount: number
  /** agent 会话候选（默认一个都不勾——防向运行中 agent 插话） */
  agentCandidates: Array<{ id: string; name: string }>
  selectedAgentIds: Set<string>
  /** 远程终端会话候选（跨主机聚合拉取；空 = 分组隐藏） */
  remoteCandidates: RemoteTerminalSessionRef[]
  selectedRemoteIds: Set<string>
  /** 发送动作（useTerminalBroadcast.send，尾部换行自动补在链内） */
  send: (text: string) => Promise<BroadcastSendOutcome>
  /** 本页已有广播回告（非 null = 显示「查看结果」重开入口，P-20261005-12） */
  hasResult: boolean
  /** 广播输入历史（会话内，最新在前；P-20261005-13） */
  inputHistory: string[]
}>()

const emit = defineEmits<{
  (e: 'exit'): void
  (e: 'toggleAgent', id: string): void
  (e: 'toggleRemote', id: string): void
  (e: 'viewResult'): void
}>()

const { t } = useI18n()
const message = useMessage()

const text = ref('')
const sending = ref(false)

// ============== 输入历史交互（P-20261005-13）：↑/↓ 巡历 + 聚焦下拉 ==============
/** 巡历游标：-1 = 未在巡历（输入框是草稿），≥0 = 正巡历史下标（0=最新） */
const historyIndex = ref(-1)
/** 上翻前的草稿：↓ 走过最新一条时恢复（shell 惯例，草稿不丢） */
const draftBeforeRecall = ref('')
/** 聚焦下拉显隐（focus/click 出——发送后焦点仍留输入框，focus 不再触发；
 *  blur/Escape/点选后收，条目 mousedown.prevent 保焦点不吃掉 click） */
const historyOpen = ref(false)

const historyVisible = computed(() => historyOpen.value && props.inputHistory.length > 0)

/** 手工键入即退出巡历态：程序化回填走 v-model 直写不触发 input 事件，
 *  此处只来自真实打字——游标复位后下次 ↑ 从最新重新开始（可预期） */
function onHistoryInput(): void {
  historyIndex.value = -1
}

function openHistory(): void {
  historyOpen.value = true
}

function closeHistory(): void {
  historyOpen.value = false
}

/** ↑：向更旧巡历一步；首次上翻先存草稿，已到最旧则停住 */
function recallOlder(): void {
  if (props.inputHistory.length === 0) return
  if (historyIndex.value + 1 >= props.inputHistory.length) return
  if (historyIndex.value === -1) draftBeforeRecall.value = text.value
  historyIndex.value += 1
  text.value = props.inputHistory[historyIndex.value] ?? ''
}

/** ↓：向更新回退一步；走过最新一条恢复上翻前草稿并退出巡历态 */
function recallNewer(): void {
  if (historyIndex.value === -1) return
  historyIndex.value -= 1
  text.value = historyIndex.value === -1
    ? draftBeforeRecall.value
    : props.inputHistory[historyIndex.value] ?? ''
}

/** 下拉点选回填：只入输入框待编辑/发送，不直接广播（误点不等于要发） */
function applyHistory(entry: string): void {
  text.value = entry
  historyIndex.value = -1
  draftBeforeRecall.value = ''
  closeHistory()
}

/** 发送后复位巡历态：入史记账在 composable.send 成功链内，此处同步清输入框 */
function resetRecallState(): void {
  historyIndex.value = -1
  draftBeforeRecall.value = ''
  closeHistory()
}

const canSend = computed(() =>
  props.targetCount >= 2 && text.value.trim().length > 0 && !sending.value)

/** 目标计数文案：不足 2 个时说明原因（可发送门槛），够 2 个展示目标数 */
const targetLabel = computed(() => props.targetCount >= 2
  ? t('terminal.broadcast.targets', { count: props.targetCount })
  : t('terminal.broadcast.needTwo'))

/** popover 触发钮徽标数 = 两组显式勾选之和（tab 点选在标签栏可见，不重复计） */
const explicitCount = computed(() => props.selectedAgentIds.size + props.selectedRemoteIds.size)

/** 远程会话展示名：主机别名徽标 + 会话短 id 消歧（同主机多会话场景） */
function remoteShortId(id: string): string {
  return id.slice(0, 8)
}

async function doSend(): Promise<void> {
  if (!canSend.value) return
  sending.value = true
  try {
    const out = await props.send(text.value)
    if (out.missing === 0 && out.failed === 0) {
      message.success(t('terminal.broadcast.sent', { count: out.written }))
    } else {
      // 部分成功如实回告（missing=已消失 / failed=写失败），不掉队静默；
      // 远程失败目标附主机别名（P-20261005-11：哪台失败一目了然），本地失败
      // 或旧服务端（failedHosts 缺省）无主机段，文案回退既有形态
      let msg = t('terminal.broadcast.partial', {
        written: out.written, missing: out.missing, failed: out.failed,
      })
      if (out.failedHostNames.length > 0) {
        msg += ' ' + t('terminal.broadcast.failedHosts', { hosts: out.failedHostNames.join('、') })
      }
      message.warning(msg)
    }
    text.value = ''
    resetRecallState()
  } catch {
    message.error(t('terminal.broadcast.sendFailed'))
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <div
    class="term-broadcast-bar"
    data-testid="terminal-broadcast-bar"
  >
    <n-icon
      size="14"
      class="term-broadcast-ico"
    >
      <RadioOutline />
    </n-icon>
    <span
      class="term-broadcast-count"
      :class="{ 'is-ready': targetCount >= 2 }"
    >{{ targetLabel }}</span>

    <!-- agent 会话 / 远程主机显式勾选（提案②：默认只列 kind=shell；P-20261005-11
         增「远程主机」分组——跨主机批量写与 agent 插话同属显式勾选语义） -->
    <n-popover
      trigger="click"
      placement="bottom-start"
      :content-style="{ maxHeight: '240px', overflow: 'auto' }"
    >
      <template #trigger>
        <button
          class="term-broadcast-agent-btn"
          :title="t('terminal.broadcast.pickMoreTip')"
        >
          {{ t('terminal.broadcast.pickMore') }}
          <span
            v-if="explicitCount > 0"
            class="term-broadcast-agent-badge"
          >{{ explicitCount }}</span>
        </button>
      </template>
      <div class="term-broadcast-agent-list">
        <!-- agent 会话组 -->
        <div class="term-broadcast-group-head">
          {{ t('terminal.broadcast.pickAgent') }}
        </div>
        <div
          v-if="agentCandidates.length === 0"
          class="term-broadcast-agent-empty"
        >
          {{ t('terminal.broadcast.noAgent') }}
        </div>
        <label
          v-for="a in agentCandidates"
          :key="a.id"
          class="term-broadcast-agent-item"
        >
          <n-checkbox
            :checked="selectedAgentIds.has(a.id)"
            @update:checked="emit('toggleAgent', a.id)"
          />
          <span class="term-broadcast-agent-name">{{ a.name }}</span>
        </label>

        <!-- 远程主机组（P-20261005-11）：主机别名徽标 + 会话短 id 消歧 -->
        <template v-if="remoteCandidates.length > 0">
          <div class="term-broadcast-group-head">
            {{ t('terminal.broadcast.remoteGroup') }}
          </div>
          <label
            v-for="r in remoteCandidates"
            :key="r.id"
            class="term-broadcast-agent-item"
          >
            <n-checkbox
              :checked="selectedRemoteIds.has(r.id)"
              @update:checked="emit('toggleRemote', r.id)"
            />
            <span class="term-broadcast-host-badge">{{ r.host }}</span>
            <span class="term-broadcast-agent-name term-broadcast-remote-id">#{{ remoteShortId(r.id) }}</span>
          </label>
        </template>
      </div>
    </n-popover>

    <!-- 输入历史（P-20261005-13）：聚焦出最近广播命令下拉点选回填；↑/↓ 键盘
         巡历（shell 惯例，草稿可恢复）。克隆 URL 历史同族：mousedown.prevent
         保输入框焦点（点击不先触发 blur 收起） -->
    <div class="term-broadcast-input-wrap">
      <input
        v-model="text"
        class="term-broadcast-input"
        type="text"
        :placeholder="targetCount >= 2 ? t('terminal.broadcast.placeholder') : t('terminal.broadcast.needTwo')"
        :disabled="targetCount < 2"
        :aria-label="t('terminal.broadcast.title')"
        @keydown.enter.prevent="doSend"
        @keydown.up.prevent="recallOlder"
        @keydown.down.prevent="recallNewer"
        @keydown.escape="closeHistory"
        @focus="openHistory"
        @click="openHistory"
        @blur="closeHistory"
        @input="onHistoryInput"
      >
      <div
        v-if="historyVisible"
        class="term-broadcast-history"
        data-testid="terminal-broadcast-history"
        @mousedown.prevent
      >
        <button
          v-for="(h, hi) in inputHistory"
          :key="h"
          class="term-broadcast-history-item"
          :data-testid="`terminal-broadcast-history-item-${hi}`"
          :title="h"
          @click="applyHistory(h)"
        >
          <span class="term-broadcast-history-text">{{ h }}</span>
        </button>
      </div>
    </div>
    <n-button
      size="tiny"
      type="primary"
      :disabled="!canSend"
      :loading="sending"
      @click="doSend"
    >
      {{ t('terminal.broadcast.send') }}
    </n-button>
    <!-- 查看结果（P-20261005-12）：发送成功面板已自动展开过一次；此钮重开
         （手动关掉后想回看尾部输出，免重新广播一遍） -->
    <n-button
      v-if="props.hasResult"
      size="tiny"
      quaternary
      data-testid="terminal-broadcast-view-result"
      @click="emit('viewResult')"
    >
      {{ t('terminal.broadcastResult.viewResult') }}
    </n-button>
    <button
      class="term-broadcast-exit"
      :title="t('terminal.broadcast.exit')"
      :aria-label="t('terminal.broadcast.exit')"
      @click="emit('exit')"
    >
      &times;
    </button>
  </div>
</template>

<style scoped>
.term-broadcast-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border-default);
  background: var(--bg-panel);
}

.term-broadcast-ico {
  color: var(--accent-blue);
  flex: none;
}

.term-broadcast-count {
  flex: none;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.term-broadcast-count.is-ready {
  color: var(--accent-blue);
  font-weight: 600;
}

.term-broadcast-agent-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--border-default);
  border-radius: 3px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  padding: 1px 6px;
  cursor: pointer;
}

.term-broadcast-agent-btn:hover {
  color: var(--text-primary);
  border-color: var(--border-strong);
}

.term-broadcast-agent-badge {
  background: var(--accent-blue);
  color: var(--text-on-accent);
  border-radius: 8px;
  font-size: 10px;
  padding: 0 5px;
  line-height: 14px;
}

.term-broadcast-agent-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 180px;
}

/* 分组头（P-20261005-11）：agent / 远程主机两组的小标签，分隔线区隔 */
.term-broadcast-group-head {
  font-size: 10px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-bottom: 1px solid var(--border-default);
  padding-bottom: 2px;
  margin-top: 4px;
}

.term-broadcast-agent-item {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.term-broadcast-agent-name {
  font-size: 12px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 主机别名徽标：远程条目的主视觉（与会话短 id 主次分明） */
.term-broadcast-host-badge {
  flex: none;
  font-size: 10px;
  line-height: 16px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--accent-blue);
  color: var(--text-on-accent);
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.term-broadcast-remote-id {
  color: var(--text-secondary);
  font-size: 11px;
}

.term-broadcast-agent-empty {
  font-size: 12px;
  color: var(--text-secondary);
}

/* 输入历史下拉（P-20261005-13）的定位容器：flex 收缩责任上移到这里 */
.term-broadcast-input-wrap {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
}

.term-broadcast-input {
  flex: 1;
  min-width: 0;
  height: 24px;
  border: 1px solid var(--border-default);
  border-radius: 3px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
  padding: 0 8px;
  outline: none;
}

.term-broadcast-input:focus {
  border-color: var(--accent-blue);
}

/* 历史下拉（P-20261005-13，clone-url-history 同族——absolute 于 relative 行容器） */
.term-broadcast-history {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 30;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  box-shadow: var(--shadow-strong);
  max-height: 180px;
  overflow-y: auto;
}

.term-broadcast-history-item {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 5px 10px;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background var(--motion-fast);
}

.term-broadcast-history-item:hover {
  background: var(--bg-hover);
}

.term-broadcast-history-text {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-body);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.term-broadcast-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.term-broadcast-exit {
  flex: none;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  padding: 2px;
}

.term-broadcast-exit:hover {
  color: var(--text-primary);
}
</style>
