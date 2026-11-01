<script setup lang="ts">
// 实例切换编排组件：头像指示器按钮 + 下拉菜单 + 管理侧边栏 + 添加/编辑弹窗的组装
// 切换前置校验（离线确认）在此统一处理，子组件只负责展示与上报
import { ref } from 'vue'
import { useInstanceStore, type Instance } from '../../stores/instance'
import { useI18n } from '../../composables/useI18n'
import { confirmDialog } from '../../composables/useDialog'
import { getInstanceInitial, getInstanceDotColor, getInstanceDisplayName } from './instanceStatus'
import InstanceMenu from './InstanceMenu.vue'
import InstanceManagePanel from './InstanceManagePanel.vue'
import InstanceFormModal from './InstanceFormModal.vue'

const props = defineProps<{ showDetail?: boolean }>()
const emit = defineEmits<{
  (e: 'expand'): void
  (e: 'collapse'): void
  (e: 'sessions'): void
  (e: 'fleet'): void
  (e: 'notify'): void
}>()

const instanceStore = useInstanceStore()
const { t } = useI18n()

const indicatorRef = ref<HTMLElement | null>(null)
const showMenu = ref(false)
const menuX = ref(0)
const menuY = ref(0)

// 添加/编辑弹窗
const showForm = ref(false)
const editTarget = ref<Instance | null>(null)

function toggleMenu() {
  if (showMenu.value) {
    showMenu.value = false
    return
  }
  // 锚定指示器按钮（下拉出现在按钮正下方）
  const rect = indicatorRef.value?.getBoundingClientRect()
  menuX.value = rect?.left ?? 0
  menuY.value = (rect?.bottom ?? 0) + 6
  showMenu.value = true
}

// 切换实例：离线远程实例先二次确认，避免切换后项目加载失败一脸懵
async function confirmAndSelect(id: string) {
  const inst = instanceStore.instances.find(i => i.id === id)
  if (!inst) return
  if (!inst.isLocal && inst.status === 'offline') {
    const ok = await confirmDialog({
      type: 'warning',
      title: t('instance.offlineConfirmTitle'),
      content: t('instance.offlineConfirmContent', { name: inst.name }),
      confirmText: t('instance.switchTo'),
      cancelText: t('common.cancel'),
    })
    if (!ok) return
  }
  instanceStore.selectInstance(id)
}

function openAddForm() {
  showMenu.value = false
  editTarget.value = null
  showForm.value = true
}

function openEditForm(inst: Instance) {
  editTarget.value = inst
  showForm.value = true
}
</script>

<template>
  <div
    ref="indicatorRef"
    class="instance-indicator"
    data-testid="instance-indicator"
    :style="{
      background: getInstanceDotColor(instanceStore.currentInstance) + '33',
      borderColor: getInstanceDotColor(instanceStore.currentInstance),
    }"
    :title="getInstanceDisplayName(instanceStore.currentInstance)"
    @mousedown.stop
    @click="toggleMenu"
  >
    <span class="indicator-text">{{ getInstanceInitial(instanceStore.currentInstance) }}</span>
    <!-- 远程实例状态点：在线绿 / 未知黄 / 离线灰 -->
    <span
      v-if="!instanceStore.currentInstance.isLocal"
      class="status-dot"
      :style="{ background: getInstanceDotColor(instanceStore.currentInstance) }"
    />
  </div>

  <InstanceMenu
    :show="showMenu"
    :x="menuX"
    :y="menuY"
    @close="showMenu = false"
    @select="showMenu = false; confirmAndSelect($event)"
    @add="openAddForm"
    @manage="showMenu = false; emit('expand')"
    @sessions="showMenu = false; emit('sessions')"
    @fleet="showMenu = false; emit('fleet')"
    @notify="showMenu = false; emit('notify')"
  />

  <InstanceManagePanel
    v-if="props.showDetail"
    @close="emit('collapse')"
    @add="openAddForm"
    @switch="confirmAndSelect"
    @edit="openEditForm"
  />

  <InstanceFormModal
    v-model:show="showForm"
    :edit-instance="editTarget"
  />
</template>

<style scoped>
.instance-indicator {
  width: 36px; height: 36px; border-radius: 6px; border: 1px solid;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  position: relative; flex-shrink: 0; transition: all var(--motion-base);
  /* 最小热区（P-20261019-5）：活动栏顶部实例入口同守全局底线
     （fine 36 已 ≥28 不变，coarse 抬到 40；侧栏 44px 宽可容纳） */
  min-width: var(--hit-target-min, 28px);
  min-height: var(--hit-target-min, 28px);
}
.instance-indicator:hover { filter: brightness(1.2); }
.indicator-text { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.status-dot {
  position: absolute; bottom: -1px; right: -1px; width: 8px; height: 8px;
  border-radius: 50%; border: 2px solid var(--bg-primary);
}
</style>
