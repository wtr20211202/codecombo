<script setup lang="ts">
import { ref, watch } from 'vue'
import {
  NButton, NIcon, NInput, NModal, NSpin, NTag, useMessage,
} from 'naive-ui'
import { TerminalOutline, PlayOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { remoteExecApi, type RemoteExecResult } from '../../api/client'
import { friendlyRemoteError } from '../../utils/remoteErrors'

const props = defineProps<{
  show: boolean
  hostId: string
  hostName: string
  /** 打开时预填的命令 */
  initialCmd?: string
}>()
const emit = defineEmits<{ (e: 'update:show', val: boolean): void }>()

const { t } = useI18n()
const message = useMessage()

const cmd = ref('')
const running = ref(false)
const result = ref<RemoteExecResult | null>(null)

watch(() => props.show, (v) => {
  if (v) {
    cmd.value = props.initialCmd || ''
    result.value = null
  }
})

async function run() {
  if (!props.hostId || !cmd.value.trim()) return
  running.value = true
  result.value = null
  try {
    const res: any = await remoteExecApi.run(props.hostId, cmd.value.trim())
    result.value = res
    if (res?.error) {
      // 底层 SSH 报错映射为可行动提示，不直出英文原文
      message.error(`${t('ai.remoteExec.failed')}: ${friendlyRemoteError(res.error, t)}`)
    }
  } catch { /* 拦截器处理 */ } finally {
    running.value = false
  }
}
</script>

<template>
  <n-modal
    :show="props.show"
    :mask-closable="false"
    class="rexec-modal"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <div class="rexec-card">
      <div class="rexec-header">
        <div class="rexec-title">
          <n-icon size="16">
            <TerminalOutline />
          </n-icon>
          <span>{{ t('ai.remoteExec.title') }} — {{ props.hostName }}</span>
        </div>
        <button
          class="rexec-close"
          @click="emit('update:show', false)"
        >
          &times;
        </button>
      </div>

      <div class="rexec-body">
        <!-- 命令输入 -->
        <n-input
          v-model:value="cmd"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 5 }"
          :placeholder="t('ai.remoteExec.cmdPlaceholder')"
          class="rexec-cmd"
          @keydown.ctrl.enter.prevent="run"
        />
        <div class="rexec-actions">
          <n-button
            size="small"
            type="primary"
            :loading="running"
            :disabled="!cmd.trim()"
            @click="run"
          >
            <template #icon>
              <n-icon size="14">
                <PlayOutline />
              </n-icon>
            </template>
            {{ t('ai.remoteExec.run') }}
          </n-button>
        </div>

        <!-- 执行结果 -->
        <div
          v-if="running"
          class="rexec-loading"
        >
          <n-spin size="small" />
        </div>
        <template v-else-if="result">
          <div
            v-if="result.error"
            class="rexec-output rexec-error"
          >
            {{ result.error }}
          </div>
          <template v-else>
            <div class="rexec-meta">
              <n-tag
                size="small"
                :type="result.ok ? 'success' : 'error'"
              >
                exit {{ result.exitCode }}
              </n-tag>
            </div>
            <pre
              v-if="result.stdout"
              class="rexec-output"
            >{{ result.stdout }}</pre>
            <pre
              v-if="result.stderr"
              class="rexec-output rexec-stderr"
            >{{ result.stderr }}</pre>
          </template>
        </template>
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
.rexec-card {
  width: 680px; max-width: 92vw; max-height: 84vh;
  background: var(--bg-panel); border: 1px solid var(--border-default);
  border-radius: 12px; box-shadow: var(--shadow-strong);
  display: flex; flex-direction: column; overflow: hidden;
}
.rexec-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid var(--border-default);
}
.rexec-title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; color: var(--text-primary); }
.rexec-close {
  background: none; border: none; color: var(--text-muted);
  font-size: 22px; cursor: pointer; padding: 0 4px; line-height: 1; border-radius: 4px;
}
.rexec-close:hover { color: var(--text-primary); background: var(--bg-hover); }
.rexec-body { flex: 1; overflow-y: auto; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; }
.rexec-cmd { font-family: var(--font-mono); }
.rexec-actions { display: flex; justify-content: flex-end; }
.rexec-loading { padding: 24px; text-align: center; }
.rexec-meta { display: flex; align-items: center; }
.rexec-output {
  margin: 0; padding: 10px 12px; border-radius: 6px;
  background: var(--bg-terminal, var(--bg-canvas));
  border: 1px solid var(--border-subtle);
  font-family: var(--font-mono); font-size: 12px; color: var(--text-primary);
  white-space: pre-wrap; word-break: break-all;
  max-height: 320px; overflow-y: auto;
}
.rexec-error { color: var(--accent-red, #f44747); }
.rexec-stderr { color: var(--accent-orange, #f0883e); }
</style>
