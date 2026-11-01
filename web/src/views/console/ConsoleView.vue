<script setup lang="ts">
import { formatBadgeCount } from '../../utils/badge'
import { ref, watch, nextTick, onMounted } from 'vue'
import { NEmpty, NButton, NIcon, NScrollbar } from 'naive-ui'
import { ChatbubblesOutline } from '@vicons/ionicons5'
import { useProjectStore } from '../../stores/project'
import { useConsoleStore, type CommandLog } from '../../stores/console'
import { useErrorLogStore } from '../../stores/errorLog'
import { useI18n } from '../../composables/useI18n'
import { useAgentFix } from '../../composables/useAgentFix'
import { errorConsoleSubTabRequested } from '../../composables/useErrorDisplayInit'
import ErrorLogList from '../../components/console/ErrorLogList.vue'

const projectStore = useProjectStore()
const consoleStore = useConsoleStore()
const errorStore = useErrorLogStore()
const { t } = useI18n()
const { handToAgent } = useAgentFix()

type SubTab = 'commands' | 'errors'
const subTab = ref<SubTab>('commands')

const scrollbarRef = ref<any>(null)

function formatTime(ts: string): string {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString()
}

watch(() => consoleStore.logs.length, async () => {
  if (subTab.value === 'commands') {
    await nextTick()
    scrollbarRef.value?.scrollTo({ top: 999999 })
  }
})

// 切到 errors 时清零未读
watch(subTab, (v) => {
  if (v === 'errors') errorStore.markAllRead()
})

// 响应「查看详情」按钮（toast 回调触发），切到错误子标签
watch(errorConsoleSubTabRequested, (v) => {
  if (v === 'errors') {
    subTab.value = 'errors'
    errorConsoleSubTabRequested.value = null
  }
})

// 挂载时若 errorConsoleSubTabRequested 已被设置（toast 点击发生在卸载期间），应用之
onMounted(() => {
  if (errorConsoleSubTabRequested.value === 'errors') {
    subTab.value = 'errors'
    errorConsoleSubTabRequested.value = null
  }
})

function clearCurrent(): void {
  if (subTab.value === 'commands') consoleStore.clear()
  else errorStore.clear()
}

// 输出折叠状态（E1）：按条目 key 记录展开集合
const expandedLogs = ref(new Set<string>())
function toggleOutput(key: string): void {
  const next = new Set(expandedLogs.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expandedLogs.value = next
}

// 交给智能体修复（P-20261002-109）：失败 git 命令行 + 失败输出（error 与 output
// 合并，shared 动作内做尾部摘要/字节适配/敏感值确认；cwd 取命令工作目录）
function fixCmdWithAgent(log: CommandLog): void {
  void handToAgent({
    kind: 'task',
    command: log.args ? `${log.command} ${log.args}` : log.command,
    output: [log.error, log.output].filter(Boolean).join('\n'),
    cwd: log.workDir,
  })
}
</script>

<template>
  <div
    v-if="!projectStore.currentProjectId"
    style="display: flex; align-items: center; justify-content: center; height: 100%"
  >
    <n-empty :description="t('console.noProject')" />
  </div>

  <div
    v-else
    style="display: flex; flex-direction: column; height: 100%"
  >
    <!-- 子 tab 栏 -->
    <div class="sub-tabs">
      <button
        :class="['sub-tab', { active: subTab === 'commands' }]"
        @click="subTab = 'commands'"
      >
        {{ t('console.subtabCommands') }}
      </button>
      <button
        :class="['sub-tab', { active: subTab === 'errors' }]"
        @click="subTab = 'errors'"
      >
        {{ t('console.subtabErrors') }}
        <span
          v-if="errorStore.unreadCount > 0"
          class="badge"
        >{{ formatBadgeCount(errorStore.unreadCount) }}</span>
      </button>
      <div style="flex: 1" />
      <n-button
        size="tiny"
        quaternary
        @click="clearCurrent"
      >
        {{ t('console.errorClearAll') }}
      </n-button>
    </div>

    <!-- 命令子标签 -->
    <div
      v-if="subTab === 'commands'"
      style="flex: 1; overflow: hidden"
    >
      <n-scrollbar ref="scrollbarRef">
        <div
          v-if="consoleStore.logs.length === 0"
          class="console-empty"
        >
          {{ t('console.commandLogHint') }}
        </div>
        <div
          v-else
          class="cmd-list"
        >
          <div
            v-for="log in consoleStore.logs"
            :key="log.timestamp + '-' + log.args"
            class="cmd-row"
          >
            <div class="cmd-head">
              <span class="cmd-time">{{ formatTime(log.timestamp) }}</span>
              <span class="cmd-prompt">$ git</span>
              <span class="cmd-args">{{ log.args }}</span>
              <!-- 输出折叠开关：仅当有输出时显示（E1） -->
              <button
                v-if="log.output"
                class="cmd-toggle"
                :title="expandedLogs.has(log.timestamp + '-' + log.args) ? t('console.hideOutput') : t('console.showOutput')"
                @click="toggleOutput(log.timestamp + '-' + log.args)"
              >
                {{ expandedLogs.has(log.timestamp + '-' + log.args) ? '▾' : '▸' }}
              </button>
              <!-- 交给智能体修复：仅失败命令（error 非空，本 tab 全为失败广播）提供 -->
              <n-button
                v-if="log.error"
                size="tiny"
                quaternary
                class="cmd-fix"
                data-testid="console-cmd-fix-agent"
                :title="t('agent.fix.actionTitle')"
                :aria-label="t('agent.fix.action')"
                @click.stop="fixCmdWithAgent(log)"
              >
                <n-icon size="13">
                  <ChatbubblesOutline />
                </n-icon>
              </n-button>
            </div>
            <div
              v-if="log.error"
              class="cmd-error"
            >
              {{ log.error }}
            </div>
            <!-- 可折叠输出区：git 命令的正常 stdout（E1） -->
            <div
              v-if="log.output && expandedLogs.has(log.timestamp + '-' + log.args)"
              class="cmd-output"
            >
              {{ log.output }}
            </div>
          </div>
        </div>
      </n-scrollbar>
    </div>

    <!-- 错误子标签 -->
    <div
      v-else
      style="flex: 1; overflow: hidden"
    >
      <ErrorLogList :entries="errorStore.logs" />
    </div>
  </div>
</template>

<style scoped>
.sub-tabs {
  display: flex;
  align-items: center;
  gap: 0;
  background: var(--console-tab-bg);
  border-bottom: 1px solid var(--border-default);
  padding: 0 8px;
}
.sub-tab {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  padding: 6px 14px;
  font-size: 12px;
  cursor: pointer;
  border-right: 1px solid var(--border-subtle);
}
.sub-tab.active {
  color: var(--console-tab-active-fg);
  background: var(--console-tab-active-bg);
}
.badge {
  display: inline-block;
  background: var(--console-badge-bg);
  color: var(--console-badge-fg);
  padding: 0 6px;
  border-radius: 8px;
  font-size: 10px;
  margin-left: 4px;
}
.console-empty {
  padding: 24px;
  text-align: center;
  color: var(--text-muted);
  font-size: 0.92em;
}
.cmd-list {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
}
.cmd-row {
  padding: 4px 12px;
  border-bottom: 1px solid var(--console-row-divider);
}
.cmd-head { display: flex; gap: 8px; align-items: baseline; }
.cmd-time { color: var(--text-muted); font-size: 11px; flex-shrink: 0; }
.cmd-prompt { color: var(--accent-blue-light); }
.cmd-args { color: var(--text-body); }
.cmd-error {
  padding-left: 80px;
  color: var(--accent-red);
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 11px;
  margin-top: 2px;
}
.cmd-toggle {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 10px;
  padding: 0 2px;
  flex-shrink: 0;
}
.cmd-toggle:hover { color: var(--text-body); }
.cmd-fix {
  flex-shrink: 0;
  align-self: center;
  color: var(--text-muted);
}
.cmd-fix:hover { color: var(--brand-accent); }
.cmd-output {
  padding: 4px 0 4px 80px;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 11px;
  max-height: 240px;
  overflow-y: auto;
  background: var(--console-row-divider);
  border-radius: 4px;
  margin-top: 2px;
}
</style>
