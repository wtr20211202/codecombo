<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { NButton, NIcon, NInput, NModal, NSelect, NSpin, NTooltip } from 'naive-ui'
import { GitBranchOutline, GitCompareOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { gitCompareApi, type GitCompareResult } from '../../api/client'
import { useProjectStore } from '../../stores/project'

/**
 * 本地-远端同项目 Git 对照卡（P-20261004-34）：选本地项目 + 远端仓库路径，
 * 服务端一次 SSH 往返取远端 HEAD/分支/脏文件数并与本地并排——
 * 「远端现在跑的是什么版本？落后本地多少？有没有未提交改动？」一眼对照，
 * 免开两个终端人肉对齐。远端路径按 host+project 维度服务端持久（对照成功
 * 自动回写，下次免手填）；远端不可达/非 git 目录按原因行降级呈现。
 */
const props = defineProps<{
  show: boolean
  hostId: string
  hostName: string
}>()
const emit = defineEmits<{
  (e: 'update:show', val: boolean): void
}>()

const { t } = useI18n()
const projectStore = useProjectStore()

// axios interceptor 已展平 AxiosResponse，运行时返回 server body 本身（remoteHost store 同款）
type Resp<T> = { data?: T }

const running = ref(false)
const result = ref<GitCompareResult | null>(null)
const topError = ref('')
const projectId = ref('')
const remotePath = ref('')
const remembered = ref(false)

// 项目下拉选项（名字 + 路径尾段辅助辨识多目录同名）
const projectOptions = computed(() =>
  projectStore.projects.map(p => ({ label: p.path ? `${p.name} · ${p.path}` : p.name, value: p.id })),
)

async function run() {
  if (!props.hostId || !projectId.value) return
  running.value = true
  topError.value = ''
  result.value = null
  try {
    const res = (await gitCompareApi.compare(props.hostId, projectId.value, remotePath.value.trim() || undefined)) as unknown as Resp<GitCompareResult>
    if (!res.data) throw new Error(t('remoteOps.gitCompare.failed'))
    result.value = res.data
    remotePath.value = res.data.remotePath
    remembered.value = res.data.pathRemembered
    // 对照成功且路径是本次显式输入（非记忆回填）→ 服务端记忆一次，下次免手填。
    // fire-and-forget：记忆失败只降级为「下次重填」，不打断对照结果呈现
    if (res.data.remotePath && !res.data.pathRemembered) {
      void gitCompareApi.savePath(props.hostId, projectId.value, res.data.remotePath).then(() => {
        remembered.value = true
      }).catch(() => { /* 记忆尽力而为 */ })
    }
  } catch (e: any) {
    // silent 调用：错误不弹拦截器 toast，就地呈现（缺远端路径等 400 引导补填）
    topError.value = e?.userMessage || e?.message || t('remoteOps.gitCompare.failed')
  } finally {
    running.value = false
  }
}

// 打开即预拉项目清单并预选当前项目；有当前项目时自动跑一次对照
//（缺省远端路径 → 服务端回填记忆；无记忆 400 → 就地提示补填路径）
watch(() => props.show, async (v) => {
  if (!v) return
  result.value = null
  topError.value = ''
  remembered.value = false
  remotePath.value = '' // 清残留：路径记忆按 host+project 维度，换主机不能沿用上一台的输入
  try {
    if (projectStore.projects.length === 0) await projectStore.fetchProjects()
  } catch { /* 锁定态等：项目清单拉不到则下拉空，用户切锁定恢复后重开 */ }
  if (!projectId.value || !projectStore.projects.some(p => p.id === projectId.value)) {
    projectId.value = projectStore.currentProject?.id || projectStore.projects[0]?.id || ''
  }
  if (projectId.value) void run()
})

/** 短 hash 展示（7 位，git log 惯例） */
const shortHash = (h?: string) => (h ? h.slice(0, 7) : '')

/** 两端 HEAD 是否不一致（可比时才高亮；任一侧缺失不误报） */
const headMismatch = computed(() =>
  !!result.value?.local.head && !!result.value?.remote.head &&
  result.value.local.head !== result.value.remote.head,
)

/** behind 提示行：i18n 文案按 relation 分档 */
const behindText = computed(() => {
  const b = result.value?.behind
  if (!b) return ''
  switch (b.relation) {
    case 'same': return t('remoteOps.gitCompare.behindSame')
    case 'remoteBehind': return t('remoteOps.gitCompare.behindRemoteBehind', { n: b.remoteBehindCount ?? 0 })
    case 'remoteAhead': return t('remoteOps.gitCompare.behindRemoteAhead', { n: b.localBehindCount ?? 0 })
    case 'diverged': return t('remoteOps.gitCompare.behindDiverged', { a: b.remoteBehindCount ?? 0, b: b.localBehindCount ?? 0 })
    default: return t('remoteOps.gitCompare.behindUnknown')
  }
})
const behindCls = computed(() => {
  const r = result.value?.behind?.relation
  if (r === 'same') return 'is-same'
  if (r === 'unknown') return 'is-unknown'
  return 'is-diff'
})

/** 降级原因 → 本地化文案（unavailableReason 稳定枚举） */
function reasonText(side: { available: boolean; unavailableReason?: string; unavailableDetail?: string }): string {
  if (side.available) return ''
  const map: Record<string, string> = {
    notGitRepo: t('remoteOps.gitCompare.rNotGitRepo'),
    pathMissing: t('remoteOps.gitCompare.rPathMissing'),
    gitMissing: t('remoteOps.gitCompare.rGitMissing'),
    unreachable: t('remoteOps.gitCompare.rUnreachable'),
    timeout: t('remoteOps.gitCompare.rTimeout'),
  }
  return map[side.unavailableReason || ''] || t('remoteOps.gitCompare.rError')
}
</script>

<template>
  <n-modal
    :show="props.show"
    :mask-closable="false"
    class="gitcmp-modal"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <div class="gitcmp-card">
      <div class="gitcmp-header">
        <div class="gitcmp-title">
          <n-icon size="16">
            <GitBranchOutline />
          </n-icon>
          <span>{{ t('remoteOps.gitCompare.title') }} — {{ props.hostName }}</span>
        </div>
        <button
          class="gitcmp-close"
          @click="emit('update:show', false)"
        >
          &times;
        </button>
      </div>

      <div class="gitcmp-body">
        <!-- 项目 + 远端路径控制行 -->
        <div class="gitcmp-controls">
          <n-select
            v-model:value="projectId"
            size="small"
            :options="projectOptions"
            :placeholder="t('remoteOps.gitCompare.projectPlaceholder')"
            filterable
            class="gitcmp-project"
            data-testid="gitcmp-project"
            @update:value="() => { result = null; topError = '' }"
          />
          <n-input
            v-model:value="remotePath"
            size="small"
            :placeholder="t('remoteOps.gitCompare.pathPlaceholder')"
            class="gitcmp-path"
            data-testid="gitcmp-path"
            @keydown.enter="run"
          />
          <n-button
            size="small"
            type="primary"
            :loading="running"
            data-testid="gitcmp-run"
            @click="run"
          >
            {{ t('remoteOps.gitCompare.run') }}
          </n-button>
        </div>
        <div
          v-if="remembered && remotePath"
          class="gitcmp-remembered"
        >
          {{ t('remoteOps.gitCompare.remembered') }}
        </div>

        <div
          v-if="running"
          class="gitcmp-loading"
        >
          <n-spin size="medium" />
          <div class="gitcmp-loading-text">
            {{ t('remoteOps.gitCompare.running') }}
          </div>
        </div>

        <div
          v-else-if="topError"
          class="gitcmp-error"
          data-testid="gitcmp-error"
        >
          {{ topError }}
        </div>

        <template v-else-if="result">
          <!-- 顶层异常（FTP 不支持 SSH 等） -->
          <div
            v-if="result.error"
            class="gitcmp-error"
          >
            {{ result.error }}
          </div>
          <template v-else>
            <!-- 列头（本地 / 远端） -->
            <div class="gitcmp-cols">
              <span />
              <span>{{ t('remoteOps.gitCompare.localSide') }}</span>
              <span>{{ t('remoteOps.gitCompare.remoteSide') }}</span>
            </div>
            <!-- 两端三行对照：HEAD / 分支 / 脏文件数 -->
            <div
              class="gitcmp-grid"
              :class="{ 'has-mismatch': headMismatch }"
              data-testid="gitcmp-grid"
            >
              <div class="gitcmp-row gitcmp-row-head">
                <span class="gitcmp-row-label">{{ t('remoteOps.gitCompare.head') }}</span>
                <span
                  class="gitcmp-row-value gitcmp-hash"
                  :class="{ 'is-mismatch': headMismatch }"
                  data-testid="gitcmp-local-head"
                >{{ shortHash(result.local.head) || '—' }}</span>
                <span
                  class="gitcmp-row-value gitcmp-hash"
                  :class="{ 'is-mismatch': headMismatch }"
                  data-testid="gitcmp-remote-head"
                >{{ shortHash(result.remote.head) || '—' }}</span>
              </div>
              <div class="gitcmp-row">
                <span class="gitcmp-row-label">{{ t('remoteOps.gitCompare.branch') }}</span>
                <span
                  class="gitcmp-row-value"
                  data-testid="gitcmp-local-branch"
                >{{ result.local.branch || t('remoteOps.gitCompare.detached') }}</span>
                <span
                  class="gitcmp-row-value"
                  data-testid="gitcmp-remote-branch"
                >{{ result.remote.branch || t('remoteOps.gitCompare.detached') }}</span>
              </div>
              <div class="gitcmp-row">
                <span class="gitcmp-row-label">{{ t('remoteOps.gitCompare.dirty') }}</span>
                <span
                  class="gitcmp-row-value"
                  data-testid="gitcmp-local-dirty"
                >{{ result.local.dirtyCount }}</span>
                <span
                  class="gitcmp-row-value"
                  data-testid="gitcmp-remote-dirty"
                >{{ result.remote.dirtyCount }}</span>
              </div>
            </div>

            <!-- behind 提示行 -->
            <div
              v-if="behindText"
              class="gitcmp-behind"
              :class="behindCls"
              data-testid="gitcmp-behind"
            >
              {{ behindText }}
            </div>

            <!-- 任一侧降级原因行 -->
            <div
              v-for="side in (['local', 'remote'] as const)"
              :key="side"
              v-show="!result[side].available"
              class="gitcmp-degrade"
              :data-testid="`gitcmp-${side}-degrade`"
            >
              {{ side === 'local' ? t('remoteOps.gitCompare.localSide') : t('remoteOps.gitCompare.remoteSide') }}：
              {{ reasonText(result[side]) }}
              <n-tooltip
                v-if="result[side].unavailableDetail"
                trigger="hover"
              >
                <template #trigger>
                  <span class="gitcmp-degrade-detail">{{ t('remoteOps.gitCompare.detail') }}</span>
                </template>
                {{ result[side].unavailableDetail }}
              </n-tooltip>
            </div>

            <div class="gitcmp-meta">
              <span class="gitcmp-duration">{{ result.durationMs }}ms</span>
              <n-button
                size="tiny"
                @click="run"
              >
                <template #icon>
                  <n-icon data-icon-action="git.compare"><GitCompareOutline /></n-icon>
                </template>
                {{ t('remoteOps.gitCompare.rerun') }}
              </n-button>
            </div>
          </template>
        </template>
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
.gitcmp-card {
  width: 560px; max-width: 92vw;
  background: var(--bg-panel); border: 1px solid var(--border-default);
  border-radius: 12px; box-shadow: var(--shadow-strong);
  display: flex; flex-direction: column; overflow: hidden;
}
.gitcmp-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 18px; border-bottom: 1px solid var(--border-default);
}
.gitcmp-title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; color: var(--text-primary); }
.gitcmp-close {
  background: none; border: none; color: var(--text-muted);
  font-size: 22px; cursor: pointer; padding: 0 4px; line-height: 1; border-radius: 4px;
}
.gitcmp-close:hover { color: var(--text-primary); background: var(--bg-hover); }
.gitcmp-body { padding: 14px 18px; overflow-y: auto; max-height: 70vh; }
.gitcmp-controls { display: flex; gap: 8px; align-items: center; }
.gitcmp-project { flex: 1 1 40%; min-width: 0; }
.gitcmp-path { flex: 1 1 60%; min-width: 0; }
.gitcmp-remembered { margin-top: 6px; font-size: 11px; color: var(--text-muted); }
.gitcmp-loading { padding: 40px; text-align: center; }
.gitcmp-loading-text { margin-top: 10px; font-size: 12px; color: var(--text-secondary); }
.gitcmp-error {
  margin-top: 10px; padding: 10px 12px; border-radius: 6px;
  background: var(--bg-canvas); border: 1px solid var(--border-default);
  color: var(--accent-red); font-size: 13px; word-break: break-all;
}
.gitcmp-grid { display: flex; flex-direction: column; }
.gitcmp-row {
  display: grid; grid-template-columns: 72px 1fr 1fr; gap: 8px; align-items: baseline;
  padding: 7px 10px; border-bottom: 1px solid var(--border-subtle);
}
.gitcmp-row-label { font-size: 12px; color: var(--text-secondary); }
.gitcmp-row-value { font-size: 13px; color: var(--text-primary); font-family: var(--font-mono); word-break: break-all; }
.gitcmp-hash.is-mismatch { color: var(--accent-yellow); font-weight: 600; }
.gitcmp-cols {
  display: grid; grid-template-columns: 72px 1fr 1fr; gap: 8px;
  padding: 0 10px 5px; margin-top: 14px; font-size: 11px; color: var(--text-muted);
  border-bottom: 1px solid var(--border-subtle);
}
.gitcmp-cols span:not(:first-child) { text-align: left; }
.gitcmp-behind {
  margin-top: 12px; padding: 7px 10px; border-radius: 6px;
  background: var(--bg-canvas); border: 1px solid var(--border-subtle);
  font-size: 12px;
}
.gitcmp-behind.is-same { color: var(--accent-green); }
.gitcmp-behind.is-diff { color: var(--accent-yellow); border-color: var(--accent-yellow); }
.gitcmp-behind.is-unknown { color: var(--text-secondary); }
.gitcmp-degrade {
  margin-top: 8px; padding: 6px 10px; border-radius: 6px;
  background: var(--bg-canvas); border: 1px dashed var(--border-default);
  font-size: 12px; color: var(--text-secondary);
}
.gitcmp-degrade-detail { margin-left: 6px; cursor: help; color: var(--accent-blue); text-decoration: underline dotted; }
.gitcmp-meta { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
.gitcmp-duration { font-size: 12px; color: var(--text-secondary); font-family: var(--font-mono); }
</style>
