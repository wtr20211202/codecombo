<script setup lang="ts">
import { ref, computed, inject, type Ref, watch } from 'vue'
import { NButton, NInput, NCheckbox, NSelect, createDiscreteApi } from 'naive-ui'
import { remoteApi, logApi } from '../../api/client'
import { useProjectStore } from '../../stores/project'
import { useThemeStore } from '../../stores/theme'
import { useI18n } from '../../composables/useI18n'
import { usePushPrToast } from '../../composables/usePushPrToast'

const props = defineProps<{
  show: boolean
}>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  pushed: []
}>()

const projectStore = useProjectStore()
const themeStore = useThemeStore()
const { t } = useI18n()

const { message } = createDiscreteApi(['message'], {
  configProviderProps: computed(() => ({
    theme: themeStore.naiveTheme,
    themeOverrides: themeStore.naiveOverrides,
  })),
})

// 成功回执统一走 usePushPrToast（P-20261005-215）：首推新分支时 toast 附「创建 PR」
// 外链；传入本组件的离散 message 实例（与其余提示同源，被 modal 遮挡问题不存在
// ——naive message 容器 z-index 高于本 modal）
const prToast = usePushPrToast(message)

const aheadBehindMap = inject<Ref<Record<string, { ahead: number; behind: number }>>>('sharedAheadBehindMap', ref({}))

const currentAheadBehind = computed(() =>
  aheadBehindMap.value[projectStore.currentProjectId || ''] || { ahead: 0, behind: 0 },
)

// 推送前 ahead 清单预览（P-20261003-151）：GHD/JetBrains 推送标配——确认前先
// 看到「这波要推什么」。≤20 条封顶（超出补剩余计数，总 ahead 以共享
// aheadBehindMap 为准）；上游缺失/未 tracking（noUpstream）只留注记跳过预览
const AHEAD_PREVIEW_MAX = 20
const aheadCommits = ref<Array<{ hash: string; shortHash: string; message: string }>>([])
const aheadNoUpstream = ref(false)

// 覆盖警示的 N（P-20261003-213「ahead 清单派生」）：ahead 权威计数来自共享
// aheadBehindMap，map 尚未就绪时退回预览清单长度（同一 ahead 的两个事实源）
const overwriteCount = computed(() => currentAheadBehind.value.ahead || aheadCommits.value.length)
// 勾选任一覆盖类选项即警示（裸 force 与 force-with-lease 同为覆盖远端操作，
// 服务端 Force 优先于 ForceWithLease，二者共用同一条红字）；计数不可得时不虚报数字
const showOverwriteWarning = computed(
  () => (pushForceWithLease.value || pushForce.value) && overwriteCount.value > 0,
)

async function fetchAheadPreview() {
  aheadCommits.value = []
  aheadNoUpstream.value = false
  if (!projectStore.currentProjectId) return
  // 打开即拉取、不以共享 aheadBehindMap 计数作前置闸：map 是异步批量探测的
  // 快照（项目刚进入时可能尚未就绪），服务端 range log 才是清单权威事实源；
  // 每次开层一次 `git log -n 20` 本地读子进程，用户手动节奏的弹窗可忽略
  try {
    // 响应体已被 http 拦截器解包：{ data: 提交数组, noUpstream?: true }——
    // 消费形态同 CommitsPanel 的 emptyRepo 先例（res:any 直读兄弟标志）
    const res: any = await logApi.getAhead(projectStore.currentProjectId, AHEAD_PREVIEW_MAX)
    aheadCommits.value = res?.data || []
    aheadNoUpstream.value = res?.noUpstream === true
  } catch {
    // silent 请求：失败降级为纯计数行（共享 map 仍提供「推多少个」基线信息）
  }
}

const pushRemote = ref('')
const remoteOptions = ref<{ label: string; value: string }[]>([])
const pushRemoteBranch = ref('')
const pushForce = ref(false)
const pushForceWithLease = ref(false)
// P-20261003-213：危险覆盖类选项（force / force-with-lease）收进默认折叠的「高级」区
// ——常规推送零干扰，危险出口仍可发现；每次打开复位为折叠（默认关不可达）
const pushAdvancedOpen = ref(false)
const pushTags = ref(false)
const pushFollowTags = ref(false)
const pushSetUpstream = ref(false)
const pushIsNewBranch = ref(false)
const pushCheckingRemote = ref(false)
const remoteLoading = ref(false)

// 远程列表：默认 origin，其次唯一/第一个 remote。此前硬编码 'origin'，
// upstream 指向其他命名 remote 的仓库推送目标错位（推了 origin、ahead 不归零）
async function fetchRemotes() {
  if (!projectStore.currentProjectId) return
  try {
    const res: any = await remoteApi.list(projectStore.currentProjectId, { silent: true })
    const list: { name: string }[] = res.data || []
    remoteOptions.value = list.map(r => ({ label: r.name, value: r.name }))
    if (!list.some(r => r.name === pushRemote.value)) {
      pushRemote.value = list.some(r => r.name === 'origin') ? 'origin' : (list[0]?.name || '')
    }
  } catch {
    remoteOptions.value = []
  }
}

async function checkRemoteBranchExists(branch: string) {
  if (!projectStore.currentProjectId || !branch || !pushRemote.value) return
  pushCheckingRemote.value = true
  try {
    const res = await remoteApi.checkBranchExists(projectStore.currentProjectId, pushRemote.value, branch)
    const exists = res.data === true
    pushIsNewBranch.value = !exists
    if (!exists) pushSetUpstream.value = true
  } catch {
    pushIsNewBranch.value = false
  } finally {
    pushCheckingRemote.value = false
  }
}

function openPushDialog() {
  pushForce.value = false
  pushForceWithLease.value = false
  pushAdvancedOpen.value = false
  pushTags.value = false
  pushFollowTags.value = false
  pushSetUpstream.value = false
  pushIsNewBranch.value = false
  const branch = projectStore.currentProject?.currentBranch || ''
  pushRemoteBranch.value = branch
  void fetchAheadPreview()
  void fetchRemotes().then(() => checkRemoteBranchExists(branch))
}

watch(() => props.show, (val) => {
  if (val) openPushDialog()
})

async function handlePush() {
  if (!projectStore.currentProjectId) return
  remoteLoading.value = true
  try {
    // 拦截器解包后运行时值即响应体 { data, newBranch }（pull 回执 newCommits 同款 cast）
    const res = await remoteApi.push(
      projectStore.currentProjectId,
      pushRemote.value || undefined,
      projectStore.currentProject?.currentBranch,
      pushForce.value,
      pushForceWithLease.value,
      pushTags.value,
      pushFollowTags.value,
      pushRemoteBranch.value !== projectStore.currentProject?.currentBranch ? pushRemoteBranch.value : undefined,
      pushSetUpstream.value,
      // silent: 拦截器的全局 toast 会被本 modal(z-index 2000)遮挡，改由 catch 用局部 message 弹
      // errorLabel: 错误标签记录友好标签（silent 不影响 errorLog.add，仅禁拦截器 toast）
      // ahead 刷新由后端 git.Push 的 post-push fetch 统一保证 ref 最新 + emit('pushed') 触发 fetchAllAheadBehind
      { errorLabel: 'push.fail', silent: true },
    ) as unknown as { newBranch?: boolean } | undefined
    // 首推判定（P-20261005-215）：服务端回执权威；旧服务端缺字段回退弹窗打开期的
    // ls-remote 预检（pushIsNewBranch，比「恒展示」退化更准），改推改名目标时
    // PR 头分支以当前分支名拼——名字不一致不展示（compare 页头分支对不上）
    const sameName = pushRemoteBranch.value === (projectStore.currentProject?.currentBranch || '')
    prToast.toastPushSuccess(res?.newBranch ?? (pushIsNewBranch.value && sameName))
    emit('update:show', false)
    emit('pushed')
  } catch {
    // 拦截器已写错误标签；modal 内用局部 message 弹友好提示，避免被 modal 遮挡
    message.error(t('push.fail'))
  } finally {
    remoteLoading.value = false
  }
}
</script>

<template>
  <div
    v-show="show"
    class="modal-overlay"
    @click.self="emit('update:show', false)"
  >
    <div
      class="modal-card"
      style="width: var(--modal-w-sm); max-width: 94vw"
    >
      <div class="modal-title">
        {{ t('layout.pushToRemote') }}
      </div>
      <div
        class="modal-body"
        style="display: flex; flex-direction: column; gap: 12px"
      >
        <div style="display: flex; align-items: center; gap: 8px; font-size: 13px">
          <span style="color: var(--text-secondary); flex-shrink: 0">{{ t('layout.local') }}</span>
          <span style="background: var(--bg-hover); padding: 3px 8px; border-radius: 4px; color: var(--accent-blue-light); font-family: monospace">{{ projectStore.currentProject?.currentBranch }}</span>
          <span style="color: var(--text-muted)">→</span>
          <n-select
            v-model:value="pushRemote"
            :options="remoteOptions"
            size="small"
            :placeholder="t('push.remotePlaceholder')"
            class="push-remote-select"
            @update:value="(v: string) => checkRemoteBranchExists(pushRemoteBranch)"
          />
          <n-input
            v-model:value="pushRemoteBranch"
            size="small"
            :placeholder="t('layout.remoteBranchPlaceholder')"
            style="flex: 1; font-family: monospace"
            @update:value="(v: string) => checkRemoteBranchExists(v)"
          />
          <span
            v-if="pushCheckingRemote"
            style="color: var(--text-muted); font-size: 12px"
          >...</span>
          <span
            v-else-if="pushIsNewBranch"
            style="background: color-mix(in srgb, var(--accent-orange) 13%, transparent); color: var(--accent-orange); font-size: 11px; padding: 1px 6px; border-radius: 3px; border: 1px solid color-mix(in srgb, var(--accent-orange) 27%, transparent); flex-shrink: 0; white-space: nowrap"
          >{{ t('push.newBadge') }}</span>
          <span
            v-else
            style="color: var(--accent-green); font-size: 11px; flex-shrink: 0"
          >✓</span>
        </div>
        <div
          v-if="currentAheadBehind.ahead > 0"
          style="font-size: 12px; color: var(--accent-green-dim)"
        >
          {{ t('layout.commitsToPush', { n: String(currentAheadBehind.ahead) }) }}
        </div>
        <div
          v-if="aheadCommits.length > 0"
          class="push-ahead-list"
          data-testid="push-ahead-list"
        >
          <div
            v-for="c in aheadCommits"
            :key="c.hash"
            class="push-ahead-item"
          >
            <span class="push-ahead-hash">{{ c.shortHash }}</span>
            <span class="push-ahead-subject">{{ c.message }}</span>
          </div>
          <div
            v-if="currentAheadBehind.ahead > aheadCommits.length"
            class="push-ahead-item push-ahead-more"
          >
            {{ t('push.aheadMore', { n: currentAheadBehind.ahead - aheadCommits.length }) }}
          </div>
        </div>
        <div
          v-else-if="aheadNoUpstream"
          class="push-ahead-noupstream"
        >
          {{ t('push.aheadNoUpstream') }}
        </div>
        <div style="border-top: 1px solid var(--border-default); padding-top: 10px; display: flex; flex-direction: column; gap: 6px">
          <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px; color: var(--text-body)">
            <n-checkbox
              v-model:checked="pushSetUpstream"
              size="small"
            />
            {{ t('layout.setUpstream') }} <span style="color: var(--text-muted); font-size: 11px">{{ t('layout.setUpstreamHint') }}</span>
          </label>
          <!-- P-20261003-213：独立 button 而非包 label 的 checkbox——纯折叠开关无转发语义 -->
          <button
            type="button"
            class="push-advanced-toggle"
            data-testid="push-advanced-toggle"
            @click="pushAdvancedOpen = !pushAdvancedOpen"
          >
            <span class="push-advanced-chevron">{{ pushAdvancedOpen ? '▾' : '▸' }}</span>
            {{ t('push.advanced') }}
          </button>
          <template v-if="pushAdvancedOpen">
            <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px; color: var(--text-body)">
              <n-checkbox
                v-model:checked="pushForceWithLease"
                size="small"
              />
              {{ t('push.forceWithLease') }}
            </label>
            <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px; color: var(--text-body)">
              <n-checkbox
                v-model:checked="pushForce"
                size="small"
              />
              {{ t('push.force') }}
            </label>
            <div
              v-if="showOverwriteWarning"
              class="push-overwrite-warning"
              data-testid="push-overwrite-warning"
            >
              {{ t('push.overwriteWarning', { n: overwriteCount }) }}
            </div>
          </template>
        </div>
        <div style="border-top: 1px solid var(--border-default); padding-top: 10px; display: flex; flex-direction: column; gap: 6px">
          <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px; color: var(--text-body)">
            <n-checkbox
              v-model:checked="pushFollowTags"
              size="small"
            />
            {{ t('push.followTags') }}
          </label>
          <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px; color: var(--text-body)">
            <n-checkbox
              v-model:checked="pushTags"
              size="small"
            />
            {{ t('push.allTags') }}
          </label>
        </div>
      </div>
      <div class="modal-footer">
        <n-button
          size="small"
          @click="emit('update:show', false)"
        >
          {{ t('common.cancel') }}
        </n-button>
        <n-button
          size="small"
          type="primary"
          :loading="remoteLoading"
          @click="handlePush"
        >
          {{ t('toolbar.push') }}
        </n-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed; inset: 0; z-index: 2000;
  background: var(--overlay-mask);
  display: flex; align-items: center; justify-content: center;
}
.modal-card {
  background: var(--bg-panel); border: 1px solid var(--border-subtle); border-radius: 8px;
  box-shadow: var(--shadow-pop-lg);
}
.modal-title {
  padding: 12px 16px; font-size: 0.95em; font-weight: 500; color: var(--text-primary);
  border-bottom: 1px solid var(--border-default);
}
.modal-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.push-ahead-list {
  display: flex; flex-direction: column; gap: 2px;
  max-height: 180px; overflow-y: auto;
  border: 1px solid var(--border-subtle); border-radius: 6px;
  padding: 6px 8px; background: var(--bg-hover);
}
.push-ahead-item {
  display: flex; align-items: baseline; gap: 8px;
  font-size: 12px; line-height: 1.6; min-width: 0;
}
.push-ahead-hash {
  font-family: monospace; color: var(--accent-blue-light);
  flex-shrink: 0;
}
.push-ahead-subject {
  color: var(--text-body);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.push-ahead-more { color: var(--text-muted); }
.push-ahead-noupstream { font-size: 12px; color: var(--text-muted); }
.push-advanced-toggle {
  display: flex; align-items: center; gap: 6px;
  background: none; border: none; padding: 0;
  cursor: pointer; font-size: 12px; color: var(--text-muted);
}
.push-advanced-toggle:hover { color: var(--text-secondary); }
.push-advanced-chevron { font-size: 10px; width: 10px; }
.push-overwrite-warning {
  font-size: 12px; color: var(--accent-red);
}
.push-remote-select {
  width: 120px;
  flex-shrink: 0;
  font-family: monospace;
}
.modal-footer {
  padding: 10px 16px; display: flex; justify-content: flex-end; gap: 8px;
  border-top: 1px solid var(--border-default);
}
</style>
