<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NModal, NTag, useMessage } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { terminalApi, type PostmortemReport } from '../../api/client'
import { usePostmortemStore } from '../../stores/postmortem'
import { useAgentTerminal } from '../../composables/useAgentTerminal'
import { containsSensitiveValue } from '../../composables/useAgentFix'
import { confirmDialog } from '../../composables/useDialog'
import { copyText } from '../../utils/clipboard'
import { buildPostmortemAskPrompt } from '../../utils/postmortemPrompt'

/**
 * 复盘报告弹层（P-20261004-60）：失败会话一键复盘的聚合读面——退出码/时间窗/
 * 末命令/输出尾部（服务端已剥 ANSI + P-108 遮蔽），底部两个行动出口：
 *   - 复制报告：Markdown 文本入剪贴板（copyText 降级链——健壮性红线）
 *   - 询问智能体：复盘 gist 经 launchArgs 预填新 agent 会话（ask 链转存问询，
 *     prompt 组装在 utils/postmortemPrompt 纯函数层，500 字节保尾截断）
 * 挂 App 层单一实例（stallTriage/DiagnoseDialog 全局弹窗惯例），入口两路
 * （退出通知卡 postmortem 动作 / 会话行右键）都只写 postmortem store。
 * 敏感出域闸门（P-20261003-155）：会话被标记敏感时首拉回 {warnings}，弹层
 * 呈警示态 + 「仍要查看」二次确认带 override 重试——与导出/分享同一契约。
 */
const store = usePostmortemStore()
const { t } = useI18n()
const message = useMessage()

const report = ref<PostmortemReport | null>(null)
const loading = ref(false)
const loadFailed = ref(false)
/** 敏感出域闸门命中态：报告已就绪但需 override 二次确认才展示 */
const gated = ref(false)
/** 用户已确认出域（本弹层会话内有效，重开会话重置） */
const overrode = ref(false)

const show = computed({
  get: () => store.open,
  set: (v: boolean) => {
    if (!v) store.close()
  },
})

async function load() {
  const id = store.sessionId
  if (!id) return
  loading.value = true
  loadFailed.value = false
  try {
    // 响应拦截器已剥 axios 封装：body 本体 {data}|{warnings}（敏感出域闸门
    // 契约与导出/分享同款——warnings 在且 data 缺席 = 需二次确认）
    const body = await terminalApi.postmortem(id, { override: overrode.value }) as unknown as { data?: PostmortemReport; warnings?: string[] }
    if (body.warnings?.length && !body.data) {
      gated.value = true
      report.value = null
    } else {
      gated.value = false
      report.value = body.data ?? null
      loadFailed.value = !body.data
    }
  } catch {
    loadFailed.value = true
    report.value = null
  } finally {
    loading.value = false
  }
}

watch(() => [show.value, store.sessionId] as const, ([open]) => {
  if (!open) return
  // 打开/换会话即拉取；重开重置会话内确认态（敏感闸门每次打开都要重新过目）
  overrode.value = false
  void load()
})

async function confirmOverride() {
  const ok = await confirmDialog({
    title: t('terminal.postmortem.sensitiveTitle'),
    content: t('terminal.postmortem.sensitiveBody'),
    type: 'warning',
  })
  if (!ok) return
  overrode.value = true
  await load()
}

const markdown = computed(() => {
  const r = report.value
  if (!r) return ''
  return renderMarkdown(r)
})

/** 客户端 Markdown 渲染（与弹层展示同源的事实面；复制出口走它而非再拉
 * 服务端 text/markdown——少一次往返且离线可复制） */
function renderMarkdown(r: PostmortemReport): string {
  const rows: string[] = []
  rows.push(`# Postmortem: ${r.name || r.sessionId}`)
  rows.push(`- sessionId: \`${r.sessionId}\``)
  if (r.kind) rows[rows.length - 1] += `  |  kind: ${r.kind}`
  if (r.runtime) rows[rows.length - 1] += `  |  runtime: ${r.runtime}`
  if (r.dir) rows.push(`- dir: \`${r.dir}\``)
  rows.push(`- exit: ${r.exitCode != null ? `**${r.exitCode}**` : r.alive ? 'n/a (alive)' : t('terminal.postmortem.noRecord')}`)
  if (r.createdAt) rows.push(`- created: ${fmtTime(r.createdAt)}`)
  if (r.exitedAt) rows.push(`- exited: ${fmtTime(r.exitedAt)}`)
  const cmds = r.lastCommands ?? []
  if (cmds.length) {
    rows.push('', '## last commands')
    for (const c of cmds) rows.push(`- \`${c.command.replace(/\s+/g, ' ')}\` (exit ${c.exitCode}, ${fmtTime(c.at)})`)
  }
  rows.push('', r.outputTail ? `## output tail (${r.outputSource || 'n/a'})\n\n\`\`\`text\n${r.outputTail}\n\`\`\`` : `## output tail\n\n${t('terminal.postmortem.tailUnavailable')}`)
  return rows.join('\n')
}

function fmtTime(v: string): string {
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString()
}

async function copyReport() {
  if (await copyText(markdown.value)) {
    message.success(t('common.copied'))
  } else {
    message.error(t('common.copyFailed'))
  }
}

const asking = ref(false)

/** 一键转存问询：gist 预填新 agent 会话（dir 沿用死会话目录——现场就地可查）。
 * 敏感值确认与 TODO 修复链同款（复盘包尾部是输出原文，宁可误报弹确认） */
async function askAgent() {
  const r = report.value
  if (!r || asking.value) return
  const prompt = buildPostmortemAskPrompt(r, t)
  if (containsSensitiveValue(prompt)) {
    const ok = await confirmDialog({
      title: t('agent.fix.sensitiveTitle'),
      content: t('agent.fix.sensitiveBody'),
      type: 'warning',
    })
    if (!ok) return
  }
  asking.value = true
  try {
    const agentTerminal = useAgentTerminal()
    if (agentTerminal.busy.value) return
    const info = await agentTerminal.create(undefined, { dir: r.dir || undefined, launchArgs: prompt })
    if (!info) {
      message.error(t('terminal.postmortem.askFailed'))
      return
    }
    message.success(info.launched ? t('terminal.postmortem.askSuccess') : t('terminal.postmortem.askDegraded'))
    await agentTerminal.open('docked')
    store.close()
  } finally {
    asking.value = false
  }
}

const exitTagType = computed<'error' | 'default'>(() => {
  if (report.value?.exitCode != null && report.value.exitCode !== 0) return 'error'
  return 'default'
})
</script>

<template>
  <n-modal
    v-model:show="show"
    preset="card"
    class="postmortem-modal"
    :title="t('terminal.postmortem.title')"
    :bordered="false"
    size="small"
    data-testid="postmortem-modal"
  >
    <div
      v-if="loading"
      class="postmortem-state"
    >
      {{ t('terminal.postmortem.loading') }}
    </div>
    <div
      v-else-if="loadFailed"
      class="postmortem-state"
    >
      {{ t('terminal.postmortem.loadFailed') }}
      <n-button
        size="tiny"
        data-testid="postmortem-retry"
        @click="load"
      >
        {{ t('common.retry') }}
      </n-button>
    </div>
    <div
      v-else-if="gated"
      class="postmortem-state postmortem-gated"
      data-testid="postmortem-gated"
    >
      <span>{{ t('terminal.postmortem.sensitiveHint') }}</span>
      <n-button
        size="tiny"
        type="warning"
        data-testid="postmortem-override"
        @click="confirmOverride"
      >
        {{ t('terminal.postmortem.sensitiveConfirm') }}
      </n-button>
    </div>
    <template v-else-if="report">
      <div class="postmortem-head">
        <span
          class="postmortem-name"
          data-testid="postmortem-name"
        >{{ report.name || report.sessionId }}</span>
        <n-tag
          v-if="report.exitCode != null"
          size="small"
          :type="exitTagType"
          :bordered="false"
          data-testid="postmortem-exit"
        >
          exit {{ report.exitCode }}
        </n-tag>
        <n-tag
          v-else
          size="small"
          :bordered="false"
        >
          {{ report.alive ? t('terminal.postmortem.alive') : t('terminal.postmortem.noRecord') }}
        </n-tag>
      </div>
      <div class="postmortem-facts">
        <div
          v-if="report.runtime"
          class="postmortem-fact"
        >
          <span class="postmortem-fact-label">runtime</span>
          <span>{{ report.runtime }}</span>
        </div>
        <div
          v-if="report.dir"
          class="postmortem-fact"
        >
          <span class="postmortem-fact-label">{{ t('terminal.postmortem.dir') }}</span>
          <span
            class="postmortem-fact-value"
            :title="report.dir"
          >{{ report.dir }}</span>
        </div>
        <div
          v-if="report.exitedAt"
          class="postmortem-fact"
        >
          <span class="postmortem-fact-label">{{ t('terminal.postmortem.exitedAt') }}</span>
          <span>{{ fmtTime(report.exitedAt) }}</span>
        </div>
      </div>
      <div
        v-if="report.lastCommands?.length"
        class="postmortem-section"
      >
        <div class="postmortem-section-title">
          {{ t('terminal.postmortem.lastCommands') }}
        </div>
        <div
          v-for="(c, i) in report.lastCommands"
          :key="i"
          class="postmortem-cmd"
          :class="{ failed: c.exitCode !== 0 }"
        >
          <code data-testid="postmortem-cmd">{{ c.command.replace(/\s+/g, ' ') }}</code>
          <span class="postmortem-cmd-meta">exit {{ c.exitCode }} · {{ fmtTime(c.at) }}</span>
        </div>
      </div>
      <div class="postmortem-section">
        <div class="postmortem-section-title">
          {{ t('terminal.postmortem.outputTail') }}
          <span
            v-if="report.outputSource"
            class="postmortem-source"
          >{{ report.outputSource === 'transcript' ? t('terminal.postmortem.tailTranscript') : t('terminal.postmortem.tailScrollback') }}</span>
        </div>
        <pre
          v-if="report.outputTail"
          class="postmortem-tail"
          data-testid="postmortem-tail"
        >{{ report.outputTail }}</pre>
        <div
          v-else
          class="postmortem-tail-empty"
        >
          {{ t('terminal.postmortem.tailUnavailable') }}
        </div>
      </div>
    </template>
    <template #footer>
      <div class="postmortem-actions">
        <n-button
          size="small"
          :disabled="!report"
          data-testid="postmortem-copy"
          @click="copyReport"
        >
          {{ t('terminal.postmortem.copy') }}
        </n-button>
        <div class="postmortem-actions-spacer" />
        <n-button
          size="small"
          type="primary"
          :disabled="!report"
          :loading="asking"
          data-testid="postmortem-ask"
          @click="askAgent"
        >
          {{ t('terminal.postmortem.ask') }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.postmortem-modal { width: 640px; max-width: calc(100vw - 32px); }
.postmortem-state { display: flex; align-items: center; gap: 8px; padding: 12px 0; color: var(--text-secondary); font-size: 12px; }
.postmortem-gated { color: var(--warning, #f0a020); }
.postmortem-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.postmortem-name { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.postmortem-facts { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
.postmortem-fact { display: flex; gap: 8px; font-size: 12px; min-width: 0; }
.postmortem-fact-label { color: var(--text-secondary); flex: none; }
.postmortem-fact-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.postmortem-section { margin-top: 10px; }
.postmortem-section-title { font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; display: flex; align-items: center; gap: 6px; }
.postmortem-source { font-size: 11px; opacity: 0.75; }
.postmortem-cmd { display: flex; align-items: baseline; gap: 8px; font-size: 12px; padding: 2px 0; min-width: 0; }
.postmortem-cmd code { font-family: var(--font-mono, monospace); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.postmortem-cmd.failed code { color: var(--error, #e05561); }
.postmortem-cmd-meta { color: var(--text-secondary); font-size: 11px; flex: none; }
.postmortem-tail {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  padding: 8px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: var(--bg-panel);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
}
.postmortem-tail-empty { font-size: 12px; color: var(--text-secondary); padding: 8px 0; }
.postmortem-actions { display: flex; align-items: center; gap: 8px; }
.postmortem-actions-spacer { flex: 1; }
</style>
