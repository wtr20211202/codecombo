<script setup lang="ts">
import { ref, watch } from 'vue'
import { NButton, NIcon, NSpin } from 'naive-ui'
import { RefreshOutline } from '@vicons/ionicons5'
import { diffApi } from '../../api/client'
import { useProjectStore } from '../../stores/project'
import { useChangesStore } from '../../stores/changes'
import type { FileStatus } from '../../stores/changes'
import { useI18n } from '../../composables/useI18n'
import DiffViewer from '../../views/changes/DiffViewer.vue'

// 变更面板文件行内嵌 diff（P-20261004-25）：仅展开态由 CommitChangeTree 的
// v-if 挂载（懒加载——收起零请求，展开才拉 GetFileDiff），嵌入 DiffViewer 并
// 传 enableHunkStaging 点亮 hunk 三键（stage/unstage/discard）。三键动作后的
// 状态对流两步：fetchStatus 整表替换驱动树行 staged 翻转/文件摘除，再重拉自身
// diff——staged 未翻转时（文件仍余其他块）内容也已变化，不重拉会继续显示已
// 处置掉的块。
const props = defineProps<{ file: FileStatus }>()

const projectStore = useProjectStore()
const changesStore = useChangesStore()
const { t } = useI18n()

const content = ref('')
const loading = ref(false)
const failed = ref(false)
let gen = 0

async function fetchDiff(): Promise<void> {
  const pid = projectStore.currentProjectId
  if (!pid) return
  const g = ++gen
  loading.value = true
  failed.value = false
  try {
    // silent：失败在展开槽内就地给出重试（槽高有限，不叠拦截器全局 toast）
    const res = await diffApi.getFileDiff(pid, props.file.path, props.file.staged, { silent: true }) as unknown as { data?: string }
    if (g !== gen) return // 过期代（staged 翻转连发/即将卸载）：丢弃防旧内容回写
    content.value = res?.data || ''
  } catch {
    if (g !== gen) return
    failed.value = true
  } finally {
    if (g === gen) loading.value = false
  }
}

// path/staged 任一「值」变化即重拉：staged 翻转 = 对比面换了侧（工作区 diff ↔
// 索引 diff）。键化成字符串比较——fetchStatus 整表替换会让 file 对象换身份但
// 值不变，按身份比较会对每次 status 刷新空转重拉
watch(() => `${props.file.path}|${props.file.staged}`, () => { void fetchDiff() }, { immediate: true })

async function onHunkAction(): Promise<void> {
  const pid = projectStore.currentProjectId
  if (!pid) return
  try { await changesStore.fetchStatus(pid) } catch { /* 拦截器处理 */ }
  void fetchDiff()
}
</script>

<template>
  <div class="cp-inline-diff-body">
    <div
      v-if="loading"
      class="cp-inline-diff-state"
    >
      <n-spin size="small" />
    </div>
    <div
      v-else-if="failed"
      class="cp-inline-diff-state"
    >
      <span>{{ t('changes.inlineDiff.loadFailed') }}</span>
      <n-button
        size="tiny"
        quaternary
        type="primary"
        :title="t('common.refresh')"
        @click="fetchDiff()"
      >
        <n-icon size="12"><RefreshOutline /></n-icon>
      </n-button>
    </div>
    <!-- 空差异（未跟踪文件 git diff 无输出等）：诚实空态，不渲染空 DiffViewer -->
    <div
      v-else-if="!content"
      class="cp-inline-diff-state"
    >
      {{ t('commitPanel.noChanges') }}
    </div>
    <DiffViewer
      v-else
      :content="content"
      :file="props.file.path"
      :project-id="projectStore.currentProjectId || ''"
      :staged="props.file.staged"
      :enable-hunk-staging="true"
      @hunk-staged="onHunkAction"
      @hunk-discarded="onHunkAction"
    />
  </div>
</template>

<!-- 自有样式独立 scoped（外层 .cp-inline-diff 槽框在 commit-panel.css，由
     CommitChangeTree 的 scoped 编译持有；本组件内部元素父 scoped 够不着） -->
<style scoped>
.cp-inline-diff-body { height: 100%; display: flex; flex-direction: column; }
.cp-inline-diff-state { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; color: var(--text-muted); font-size: 0.85em; }
</style>
