<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { NButton, NInput, NSelect, NModal } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { remoteHostApi } from '../../api/client'
import type { RemoteHost } from '../../api/client'

// 传输到主机弹窗（自 RemoteFilePane 按区块拆出，P-20261002-27）：
// 目标主机多选 + 目标目录输入。纯表单：主机列表自加载（排除来源主机），
// 开始传输经 start 事件上抛——勾选路径拼装、API 调用与结果 toast 在宿主
// （勾选/主机状态由宿主持有，与拆分前同语义）。
const props = defineProps<{
  /** 来源主机 id（目标列表排除自身，跨主机互传） */
  excludeHostId?: string
  /** 勾选文件数（提示文案 n 参数） */
  checkedCount: number
  /** 传输进行中（开始按钮 loading） */
  transferring: boolean
  /** 打开时预填的目标目录（来源面板当前目录，与拆分前同语义） */
  cwd: string
}>()

const show = defineModel<boolean>('show', { required: true })

const emit = defineEmits<{
  (e: 'start', payload: { targets: string[]; dir: string; hostNames: Record<string, string> }): void
}>()

const { t } = useI18n()

const transferTargets = ref<string[]>([])
const transferDir = ref('')

const allHosts = ref<RemoteHost[] | null>(null)
const targetOptions = computed(() =>
  (allHosts.value || [])
    .filter(h => h.id !== props.excludeHostId)
    .map(h => ({ label: `${h.name}（${h.user}@${h.host}）`, value: h.id })))

watch(show, (v) => {
  if (!v) return
  transferDir.value = props.cwd
  transferTargets.value = []
  void remoteHostApi.list().then((res) => {
    allHosts.value = (res as unknown as { data?: RemoteHost[] }).data || []
  }).catch(() => { allHosts.value = [] })
})

function start() {
  // 目标主机名映射随载荷上抛：宿主结果 toast 按名展示（与拆分前 allHosts 反查同源）
  const hostNames: Record<string, string> = {}
  for (const h of allHosts.value || []) hostNames[h.id] = h.name
  emit('start', { targets: [...transferTargets.value], dir: transferDir.value, hostNames })
}
</script>

<template>
  <n-modal
    v-model:show="show"
    preset="card"
    :title="t('remoteFiles.transferTitle')"
    class="rf-transfer"
    :bordered="false"
  >
    <div class="rf-transfer-body">
      <div class="rf-transfer-row">
        <span class="rf-transfer-label">{{ t('remoteFiles.transferTargets') }}</span>
        <n-select
          v-model:value="transferTargets"
          multiple
          clearable
          :options="targetOptions"
          :placeholder="t('remoteFiles.transferTargetsPlaceholder')"
          :max-tag-count="3"
        />
      </div>
      <div class="rf-transfer-row">
        <span class="rf-transfer-label">{{ t('remoteFiles.transferDir') }}</span>
        <n-input
          v-model:value="transferDir"
          :placeholder="t('remoteFiles.transferDirPlaceholder')"
        />
      </div>
      <div class="rf-transfer-hint">
        {{ t('remoteFiles.transferHint', { n: checkedCount }) }}
      </div>
    </div>
    <template #footer>
      <div class="rf-transfer-foot">
        <n-button
          size="small"
          quaternary
          @click="show = false"
        >
          {{ t('common.cancel') }}
        </n-button>
        <n-button
          size="small"
          type="primary"
          :loading="transferring"
          :disabled="transferTargets.length === 0"
          @click="start"
        >
          {{ t('remoteFiles.transferStart') }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped src="./remote-file-transfer-modal.css"></style>
