<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NDropdown, NIcon, NInput } from 'naive-ui'
import { ChevronDownOutline, ChevronForwardOutline } from '@vicons/ionicons5'
import { useProjectStore } from '../../stores/project'
import { worktreeApi } from '../../api/client'
import { useDialog, useMessage } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { sessionWorkingDir, useTerminalSessionsStore } from '../../stores/terminal-sessions'
import NewSessionDialog from '../agent/NewSessionDialog.vue'
import { NCheckbox } from 'naive-ui'
import { isHistWorktreePath } from '../../utils/histWorktree'
import { OPS_WORKTREES_CHANGED } from '../../utils/opsEvents'

/**
 * Git 侧栏 Worktree 分节（从 GitPanel.vue 抽出）：
 * 列表/折叠/右键菜单（打开为项目/锁定/删除）/添加 Worktree 弹窗，自包含。
 */
const projectStore = useProjectStore()
const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()

interface WorktreeItem { path: string; branch: string; hash: string; isMain: boolean; isLocked: boolean; lockedReason: string }
const worktrees = ref<WorktreeItem[]>([])
const showAddWorktreeModal = ref(false)
const newWorktreePath = ref('')
const newWorktreeBranch = ref('')
const newWorktreeRef = ref('')
const collapsed = ref(false)

// ============== 智能体会话关联（B2） ==============
// 每个 worktree 显示驻留其目录下的智能体会话数（按会话 cwd 前缀归属）；
// 右键「在此开 Agent 终端」/ 创建后一键起终端，经共享 NewSessionDialog 预填目录。
// 驻留归属按会话实时 cwd（P-20261004-59 OSC 7 追踪 currentDir，无帧回落创建
// dir——sessionWorkingDir 统一收口）：agent cd 进 worktree 子目录仍驻留
// （前缀语义）、cd 出 worktree 即摘徽标，不再挂在创建时快照上错亮
const sessionsStore = useTerminalSessionsStore()
const agentSessionCount = (wt: WorktreeItem) => {
  const root = wt.path.split('\\').join('/').replace(/\/+$/, '')
  return sessionsStore.systemSessions.filter(s => {
    const p = sessionWorkingDir(s).split('\\').join('/')
    return p === root || p.startsWith(root + '/')
  }).length
}
const showAgentDialog = ref(false)
const agentDialogDir = ref('')
function openAgentHere(wt: WorktreeItem) {
  agentDialogDir.value = wt.path
  showAgentDialog.value = true
}
/** 创建 worktree 后一键起智能体终端（弹窗勾选） */
const openAgentAfterCreate = ref(false)

async function fetchWorktrees() {
  if (!projectStore.currentProjectId) return
  try {
    const res: any = await worktreeApi.list(projectStore.currentProjectId)
    worktrees.value = res.data || []
  } catch { /* silent */ }
}

watch(() => projectStore.currentProjectId, () => void fetchWorktrees(), { immediate: true })

// 跨组件创建的即时对账（P-20261005-179）：提交右键「历史检视 worktree」
// 等异组件动作经 OPS_WORKTREES_CHANGED 广播，收到即重拉——面板自身只挂
// 项目切换 watch，同项目内的创建须靠事件才能现身管理区
function onWorktreesChanged() { void fetchWorktrees() }
onMounted(() => window.addEventListener(OPS_WORKTREES_CHANGED, onWorktreesChanged))
onBeforeUnmount(() => window.removeEventListener(OPS_WORKTREES_CHANGED, onWorktreesChanged))

function getWorktreeDisplayName(wt: WorktreeItem) {
  if (wt.isMain) return t('git.mainWorktree')
  // 取最后两级目录名
  const parts = wt.path.replace(/\\/g, '/').split('/')
  return parts.length >= 2 ? parts.slice(-2).join('/') : parts[parts.length - 1] || wt.path
}

/** 分支列文案：历史检视 worktree（HEAD 分离）显示落点短 hash——「哪个提交的
 *  代码态」即其身份，比通用的「未在分支上」更能防误认为工作分支；其余分离态
 *  沿旧文案 */
function wtBranchLabel(wt: WorktreeItem): string {
  if (wt.branch) return wt.branch
  if (isHistWorktreePath(wt.path) && wt.hash) return '@' + wt.hash.substring(0, 8)
  return t('git.detached')
}

async function openWorktreeAsProject(wt: WorktreeItem) {
  // 已注册同路径项目 → 直接切换（重复 add 会被服务端 409 拒绝，用户的
  // 真实意图是「切到该工作树」而不是「再注册一次」）
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const existing = projectStore.projects.find(p => norm(p.path) === norm(wt.path))
  if (existing) {
    // 切换守卫取消（未保存草稿确认选「取消」，P-20261003-105）→ 不弹成功提示
    if ((await projectStore.selectProject(existing.id)) === false) return
    message.success(t('git.worktreeOpened', { name: existing.name }))
    return
  }
  const name = wt.branch ? wt.branch.split('/').pop() || wt.branch : getWorktreeDisplayName(wt)
  projectStore.addProject(name, wt.path)
  message.success(t('git.worktreeOpened', { name: name }))
}

async function handleAddWorktree() {
  if (!projectStore.currentProjectId) return
  if (!newWorktreePath.value) {
    message.warning(t('git.worktreePathRequired'))
    return
  }
  try {
    if (newWorktreeBranch.value) {
      await worktreeApi.add(projectStore.currentProjectId, { path: newWorktreePath.value, branch: newWorktreeBranch.value })
    } else if (newWorktreeRef.value) {
      await worktreeApi.add(projectStore.currentProjectId, { path: newWorktreePath.value, ref: newWorktreeRef.value })
    } else {
      await worktreeApi.add(projectStore.currentProjectId, { path: newWorktreePath.value })
    }
    message.success(t('git.worktreeCreated'))
    const createdPath = newWorktreePath.value
    showAddWorktreeModal.value = false
    newWorktreePath.value = ''
    newWorktreeBranch.value = ''
    newWorktreeRef.value = ''
    fetchWorktrees()
    // 糖：创建后直接在新 worktree 起智能体终端（默认勾选）
    if (openAgentAfterCreate.value) {
      openAgentHere({ path: createdPath, branch: newWorktreeBranch.value, hash: '', isMain: false, isLocked: false, lockedReason: '' })
    }
    openAgentAfterCreate.value = false
  } catch { /* 拦截器处理 */ }
}

async function handleDeleteWorktree(wt: WorktreeItem) {
  dialog.warning({
    title: t('git.deleteWorktreeTitle'),
    content: t('git.deleteWorktreeConfirm', { name: wt.branch || wt.path }),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        await worktreeApi.remove(projectStore.currentProjectId!, { path: wt.path })
        message.success(t('git.worktreeDeleted'))
        fetchWorktrees()
      } catch (e: any) {
        dialog.error({
          title: t('git.deleteFailTitle'),
          content: t('git.forceDeleteConfirm', { message: e?.userMessage || e?.message || '' }),
          positiveText: t('git.branchForceDeleted'),
          negativeText: t('common.cancel'),
          onPositiveClick: async () => {
            try { await worktreeApi.remove(projectStore.currentProjectId!, { path: wt.path, force: true }); message.success(t('git.branchForceDeleted')); fetchWorktrees() }
            catch { /* 拦截器处理 */ }
          },
        })
      }
    },
  })
}

async function handleToggleWorktreeLock(wt: WorktreeItem) {
  if (!projectStore.currentProjectId) return
  try {
    if (wt.isLocked) {
      await worktreeApi.unlock(projectStore.currentProjectId, wt.path)
      message.success(t('git.worktreeUnlocked'))
    } else {
      await worktreeApi.lock(projectStore.currentProjectId, wt.path)
      message.success(t('git.worktreeLocked'))
    }
    fetchWorktrees()
  } catch { /* 拦截器处理 */ }
}

// Worktree 右键菜单
const wtContextItem = ref<WorktreeItem | null>(null)
const showWtContext = ref(false)
const wtContextX = ref(0)
const wtContextY = ref(0)

function handleWorktreeContext(e: MouseEvent, wt: WorktreeItem) {
  e.preventDefault()
  wtContextItem.value = wt
  wtContextX.value = e.clientX
  wtContextY.value = e.clientY
  showWtContext.value = true
}

const wtContextOptions = computed(() => {
  const wt = wtContextItem.value
  if (!wt) return []
  const opts: { label: string; key: string }[] = []
  opts.push({ label: t('git.ctxNewAgentHere'), key: 'agent' })
  if (!wt.isMain) opts.push({ label: t('git.ctxOpen'), key: 'open' })
  opts.push({ label: wt.isLocked ? t('git.ctxUnlock') : t('git.ctxLock'), key: 'lock' })
  if (!wt.isMain) opts.push({ label: t('common.delete'), key: 'delete' })
  return opts
})

async function handleWtContextSelect(key: string) {
  showWtContext.value = false
  const wt = wtContextItem.value
  if (!wt) return
  switch (key) {
    case 'agent': openAgentHere(wt); break
    case 'open': openWorktreeAsProject(wt); break
    case 'lock': handleToggleWorktreeLock(wt); break
    case 'delete': handleDeleteWorktree(wt); break
  }
}
</script>

<template>
  <div class="branch-section">
    <div
      class="section-header"
      @click="collapsed = !collapsed"
    >
      <n-icon size="12">
        <component :is="collapsed ? ChevronForwardOutline : ChevronDownOutline" />
      </n-icon>
      <span>{{ t('git.worktrees') }}</span>
      <span class="section-count">{{ worktrees.length }}</span>
      <button
        class="section-add-btn"
        :title="t('git.createWorktreeTitle')"
        @click.prevent.stop="showAddWorktreeModal = true; newWorktreePath = ''; newWorktreeBranch = ''; newWorktreeRef = ''"
      >
        +
      </button>
    </div>
    <template v-if="!collapsed">
      <div
        v-for="wt in worktrees"
        :key="wt.path"
        class="branch-item wt-item"
        @click="!wt.isMain ? openWorktreeAsProject(wt) : null"
        @contextmenu="handleWorktreeContext($event, wt)"
      >
        <span
          v-if="wt.isMain"
          class="wt-badge main"
        >{{ t('git.mainBadge') }}</span>
        <span
          v-if="!wt.isMain && isHistWorktreePath(wt.path)"
          class="wt-badge hist"
          :title="t('git.histBadgeTitle')"
        >{{ t('git.histBadge') }}</span>
        <span
          v-if="wt.isLocked"
          class="wt-badge locked"
          :title="t('git.locked')"
        >&#x1F512;</span>
        <span
          class="wt-branch"
          :title="wt.branch || wt.hash || t('git.detached')"
        >{{ wtBranchLabel(wt) }}</span>
        <span
          v-if="!wt.isMain"
          class="wt-path"
          :title="wt.path"
        >{{ getWorktreeDisplayName(wt) }}</span>
        <span
          v-if="agentSessionCount(wt) > 0"
          class="wt-agents"
          :title="t('git.worktreeAgentSessions', { n: agentSessionCount(wt) })"
        >{{ agentSessionCount(wt) }}</span>
      </div>
      <div
        v-if="worktrees.length === 0"
        class="remote-empty"
      >
        {{ t('git.noWorktree') }}
      </div>
    </template>
  </div>

  <NDropdown
    placement="bottom-start"
    trigger="manual"
    :x="wtContextX"
    :y="wtContextY"
    :options="wtContextOptions"
    :show="showWtContext"
    @select="handleWtContextSelect"
    @clickoutside="showWtContext = false"
  />

  <!-- 创建 Worktree 弹窗 -->
  <div
    v-show="showAddWorktreeModal"
    class="modal-overlay"
    @click.self="showAddWorktreeModal = false"
  >
    <div class="modal-card">
      <div class="modal-title">
        {{ t('git.createWorktreeTitle') }}
      </div>
      <div class="modal-body">
        <div class="modal-field">
          <label>{{ t('git.targetPath') }}</label>
          <n-input
            v-model:value="newWorktreePath"
            :placeholder="t('git.worktreePathPlaceholder')"
            size="small"
          />
        </div>
        <div class="modal-field">
          <label>{{ t('git.newBranchOptional') }}</label>
          <n-input
            v-model:value="newWorktreeBranch"
            :placeholder="t('git.newBranchPlaceholder')"
            size="small"
          />
        </div>
        <div
          v-if="!newWorktreeBranch"
          class="modal-field"
        >
          <label>{{ t('git.existingBranchOrRef') }}</label>
          <n-input
            v-model:value="newWorktreeRef"
            :placeholder="t('git.refPlaceholder')"
            size="small"
            @keyup.enter="handleAddWorktree"
          />
        </div>
        <div class="modal-field">
          <n-checkbox
            v-model:checked="openAgentAfterCreate"
            size="small"
          >
            {{ t('git.openAgentAfterCreate') }}
          </n-checkbox>
        </div>
      </div>
      <div class="modal-footer">
        <n-button
          size="small"
          @click="showAddWorktreeModal = false"
        >
          {{ t('common.cancel') }}
        </n-button>
        <n-button
          size="small"
          type="primary"
          :disabled="!newWorktreePath"
          @click="handleAddWorktree"
        >
          {{ t('common.create') }}
        </n-button>
      </div>
    </div>
  </div>

  <!-- 在此开 Agent 终端（B2：预填 worktree 目录） -->
  <NewSessionDialog
    v-model:show="showAgentDialog"
    :prefill-dir="agentDialogDir"
  />
</template>

<style scoped>
/* 可读性下限（P-20261019-3）：标题 12px/500；操作钮与行文本走 --fs-meta-min。
   原先标题 0.82em 内再叠 0.8/0.9em，计数 8.53px、+ 钮 9.59px/行高 10px；
   现改 max(px 下限, em) 并把 + 钮点击区抬到 18px（可发现性 + 可点性） */
.section-header {
  padding: var(--space-1) var(--space-2); font-size: max(var(--fs-section-min, 12px), 0.92em); font-weight: var(--fw-medium); color: var(--text-secondary);
  background: var(--bg-panel); display: flex; align-items: center; gap: var(--space-1);
  cursor: pointer; user-select: none; line-height: var(--lh-meta, 1.45);
}
.section-header:hover { color: var(--text-primary); }
.section-count { margin-left: auto; font-size: max(var(--fs-meta-min, 11.5px), 0.8em); color: var(--text-muted); }
.branch-section { border-bottom: 1px solid color-mix(in srgb, var(--border-default) 20%, transparent); }
.branch-item {
  padding: 2px var(--space-2) 2px 20px; display: flex; align-items: center; gap: var(--space-1);
  cursor: pointer; color: var(--text-primary); font-size: max(var(--fs-meta-min, 11.5px), 0.92em);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.branch-item:hover { background: var(--bg-hover); }
.section-add-btn {
  margin-left: var(--space-1); border: none; background: transparent; color: var(--text-secondary); cursor: pointer;
  /* 最小热区（P-20261019-5）：18px 是 P-20261019-3 的可点性临时档，本条统一
     并入全局底线（fine 28 / coarse 40）；+ 字视觉尺寸不变 */
  padding: 0 var(--space-1); min-width: var(--hit-target-min, 28px); min-height: var(--hit-target-min, 28px); display: inline-flex;
  align-items: center; justify-content: center;
  font-size: max(var(--fs-meta-min, 11.5px), 0.9em); line-height: 1; border-radius: 2px;
}
.section-add-btn:hover { color: var(--text-primary); background: var(--border-default); }
.remote-empty { padding: 6px 10px; font-size: max(var(--fs-meta-min, 11.5px), 0.82em); color: var(--text-muted); }
.modal-overlay {
  position: fixed; inset: 0; z-index: 2000;
  background: var(--overlay-mask);
  display: flex; align-items: center; justify-content: center;
}
.modal-card {
  width: 380px; background: var(--bg-panel); border: 1px solid var(--border-subtle); border-radius: var(--radius-lg);
  box-shadow: var(--shadow-pop-lg);
}
.modal-title {
  padding: var(--space-3) var(--space-4); font-size: 0.95em; font-weight: var(--fw-medium); color: var(--text-primary);
  border-bottom: 1px solid var(--border-default);
}
.modal-body { padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); }
.modal-field { display: flex; flex-direction: column; gap: var(--space-1); }
.modal-field label { font-size: 0.85em; color: var(--text-secondary); }
.modal-footer {
  padding: 10px var(--space-4); display: flex; justify-content: flex-end; gap: var(--space-2);
  border-top: 1px solid var(--border-default);
}
/* worktree 行：路径原为 .82em × .9em = 9.59px（双重 em 叠乘），现统一走
   元信息下限；徽标不再向下压字号，弱化交给颜色与底色 */
.wt-item { gap: 6px; font-size: max(var(--fs-meta-min, 11.5px), 0.92em); }
.wt-badge { font-size: max(var(--fs-meta-min, 11.5px), 0.75em); padding: 0 var(--space-1); border-radius: 2px; flex-shrink: 0; line-height: var(--lh-meta, 1.45); }
.wt-badge.main { background: color-mix(in srgb, var(--accent-blue) 20%, transparent); color: var(--accent-blue); }
.wt-badge.hist { background: color-mix(in srgb, var(--accent-purple) 20%, transparent); color: var(--accent-purple); }
.wt-badge.locked { background: transparent; color: var(--accent-yellow-warm); font-size: max(var(--fs-meta-min, 11.5px), 0.85em); }
/* 分支名占满剩余宽度（超出省略 + title 全名），不再设 90px 硬上限；
   主工作树无右侧路径标签，「主」徽标已表意，分支名独占整行 */
.wt-branch { color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 auto; min-width: 0; }
.wt-path { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; font-size: max(var(--fs-meta-min, 11.5px), 0.9em); }
.wt-agents {
  flex-shrink: 0; font-size: max(var(--fs-meta-min, 11.5px), 0.72em); line-height: var(--lh-meta, 1.45); padding: 0 var(--space-1); border-radius: 2px;
  background: color-mix(in srgb, var(--accent-green) 18%, transparent); color: var(--accent-green);
}
</style>
