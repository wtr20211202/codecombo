<script setup lang="ts">
import { ref, watch } from 'vue'
import { NModal, NSpin, NEmpty } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { stashApi } from '../../api/client'
import DiffViewer from '../../views/changes/DiffViewer.vue'

/**
 * Stash 内容预览弹窗（P-20261002-89）：stash 是时间舱——apply/pop 前先看看里面是什么。
 * 打开时按稳定引用拉取服务端 diff（stash show -p --include-untracked，超大已截文），
 * 经 DiffViewer 只读渲染（不传 projectId/file，无 hunk 暂存按钮）。
 * P-20261003-264：hash 优先寻址（列表移位不会预览错条目），旧服务端无 hash 时
 * 回退 index；标题仍显示 stash@{index}（用户点击的行号，保持既有识别习俗）。
 */
const props = defineProps<{
  show: boolean
  projectId: string
  index: number
  /** stash 提交完整 hash（稳定引用）；缺省 = 旧服务端，走 index 回退 */
  hash?: string
  message: string
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
}>()

const { t } = useI18n()

const diffContent = ref('')
const diffLoading = ref(false)
const diffError = ref('')

watch(() => props.show, (v) => {
  if (v) void fetchDiff()
})

async function fetchDiff() {
  if (!props.projectId) return
  diffLoading.value = true
  diffError.value = ''
  diffContent.value = ''
  try {
    const res: any = await stashApi.diff(props.projectId, { index: props.index, hash: props.hash })
    diffContent.value = res.data || ''
    if (!diffContent.value) diffError.value = t('stash.diff.empty')
  } catch (e: any) {
    // userMessage：拦截器产出的友好文案；原文保留在 Console，不直出面板
    diffError.value = e?.userMessage || t('errors.unknown')
  } finally {
    diffLoading.value = false
  }
}
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    :title="t('stash.diff.title', { index })"
    :style="{ width: 'var(--modal-w-xl)', maxWidth: '94vw' }"
    :bordered="false"
    @update:show="emit('update:show', $event)"
  >
    <div class="sdm-msg">
      <span
        class="sdm-msg-text"
        :title="message"
      >{{ message }}</span>
    </div>
    <div class="sdm-body">
      <div
        v-if="diffLoading"
        class="sdm-center"
      >
        <n-spin size="small" />
      </div>
      <div
        v-else-if="diffError"
        class="sdm-center"
      >
        <n-empty :description="diffError" />
      </div>
      <div
        v-else-if="diffContent"
        class="sdm-diff"
      >
        <DiffViewer :content="diffContent" />
      </div>
      <div
        v-else
        class="sdm-center"
      >
        <n-empty :description="t('stash.diff.empty')" />
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
.sdm-msg {
  margin-bottom: var(--space-2);
}
.sdm-msg-text {
  font-size: 12px;
  color: var(--text-secondary);
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sdm-body { height: 68vh; display: flex; flex-direction: column; overflow: hidden; }
.sdm-center { flex: 1; display: flex; align-items: center; justify-content: center; }
.sdm-diff { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.sdm-diff > :deep(*) { flex: 1; min-height: 0; }
</style>
