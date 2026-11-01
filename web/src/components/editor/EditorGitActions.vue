<script setup lang="ts">
import { ref, computed } from 'vue'
import { NIcon } from 'naive-ui'
import { ChatbubbleEllipsesOutline, GitCommitOutline, GitCompareOutline, OpenOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useProjectStore } from '../../stores/project'
import { useEditorAskAgent } from '../../composables/useEditorAskAgent'
import { buildRemoteViewUrl, remotePlatformName } from '../../utils/remoteViewUrl'
import FileHistoryModal from '../git/FileHistoryModal.vue'
import CompareRefModal from '../git/CompareRefModal.vue'

/**
 * 编辑器右上角 Git 快捷操作（IDEA 式）：文件历史 + 对比分支/Tag/提交 + 平台查看
 * + 就此文件询问智能体。弹窗实现抽至共享组件（FileHistoryModal/CompareRefModal），
 * Monaco 右键菜单经宿主 ref 调用 openHistory/openCompare 复用同一实例
 * 按钮以绝对定位挂在编辑器右上角（与 Blame 按钮同一行，由宿主定位容器）
 */
const props = defineProps<{
  projectId: string
  file: string
  /** 取编辑器光标行号（询问智能体的 prompt 聚焦行）：点击时求值，编辑器为空返回 undefined */
  getCursorLine?: () => number | undefined
}>()

const { t } = useI18n()
const projectStore = useProjectStore()
const { askAgentAboutFile } = useEditorAskAgent()

// ============== 文件历史 ==============
const showHistory = ref(false)
function openHistory() {
  if (!props.file) return
  showHistory.value = true
}

// ============== 对比分支/Tag/提交 ==============
const showCompare = ref(false)
function openCompare() {
  if (!props.file) return
  showCompare.value = true
}

// ============== 就此文件询问智能体 ==============
// 光标行在点击时求值（工具条悬浮于当前编辑文件之上，行号即该文件光标位置）
function askAgent() {
  if (!props.file) return
  void askAgentAboutFile(props.file, props.getCursorLine?.())
}

// ============== 在平台上查看 ==============
// remote + 当前分支 + 文件路径 → 平台 blob 页；无 remote/分支/文件时为 null（入口隐藏）
const remoteView = computed(() => buildRemoteViewUrl({
  remoteUrl: projectStore.currentProject?.remoteURL,
  ref: projectStore.currentProject?.currentBranch,
  filePath: props.file,
}))
const platformName = computed(() => remotePlatformName(remoteView.value?.platform || 'generic', t('editor.remoteViewGeneric')))

defineExpose({ openHistory, openCompare })
</script>

<template>
  <div class="editor-git-actions">
    <button
      class="ega-btn"
      :title="t('editor.fileHistory')"
      :disabled="!file"
      @click="openHistory"
    >
      <n-icon size="12">
        <GitCommitOutline />
      </n-icon>
      <span>{{ t('editor.fileHistoryShort') }}</span>
    </button>
    <button
      class="ega-btn"
      :title="t('editor.compareWithRef')"
      :disabled="!file"
      @click="openCompare"
    >
      <n-icon size="12">
        <GitCompareOutline />
      </n-icon>
      <span>{{ t('editor.compareShort') }}</span>
    </button>
    <!-- 询问智能体：新建 agent 会话，prompt 预填本文件（含光标行） -->
    <button
      class="ega-btn"
      :title="t('editor.ask.buttonTitle')"
      :disabled="!file"
      @click="askAgent"
    >
      <n-icon size="12">
        <ChatbubbleEllipsesOutline />
      </n-icon>
      <span>{{ t('editor.ask.button') }}</span>
    </button>
    <!-- 平台查看：a 而非 button——href 可中键/新标签直达，noopener 守外链红线 -->
    <a
      v-if="remoteView"
      class="ega-btn"
      :href="remoteView.url"
      target="_blank"
      rel="noopener noreferrer"
      :title="t('editor.remoteViewTitle', { platform: platformName })"
      :aria-label="t('editor.remoteViewTitle', { platform: platformName })"
    >
      <n-icon size="12">
        <OpenOutline />
      </n-icon>
      <span>{{ platformName }}</span>
    </a>

    <FileHistoryModal
      v-model:show="showHistory"
      :project-id="projectId"
      :file="file"
    />
    <CompareRefModal
      v-model:show="showCompare"
      :project-id="projectId"
      :file="file"
    />
  </div>
</template>

<style scoped>
.editor-git-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.ega-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: 11px;
  font-family: var(--font-ui);
  cursor: pointer;
  transition: all var(--motion-base);
}
.ega-btn:hover:not(:disabled) {
  border-color: var(--brand-accent);
  color: var(--text-primary);
  background: var(--bg-hover);
}
.ega-btn:disabled { opacity: 0.45; cursor: not-allowed; }
/* 平台查看是 a 元素：抹掉链接默认下划线，视觉与其余按钮一致 */
a.ega-btn { text-decoration: none; }
</style>
