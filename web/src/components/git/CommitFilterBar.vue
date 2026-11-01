<script setup lang="ts">
import { computed } from 'vue'
import { NIcon, NInput } from 'naive-ui'
import { SearchOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'

// 变更列表过滤条（自 CommitPanel.vue 拆出，P-20261003-143）：纯 UI——路径子串
// 过滤 + 会话归属二态 chips（P-20261003-22）+ 状态四态 chips（P-20261003-136）+
// 活跃组过滤 chip（P-20261007-19，分组维度）+ 过滤态 n/总数。过滤状态由面板
// 持有（visibleFiles 过滤与键盘光标回落都依赖它），这里经 v-model 双向绑定。
const filter = defineModel<string>('filter', { default: '' })
const agentScope = defineModel<'off' | 'agent' | 'human'>('agentScope', { default: 'off' })
const statusScope = defineModel<'all' | 'unstaged' | 'staged' | 'conflict'>('statusScope', { default: 'all' })
// 活跃组过滤（P-20261007-19）：布尔开关（分组维度，与前三者 AND 叠加）；
// 活跃组是服务端持久态，这里只是显示层 opt-in 的开关
const changelistScope = defineModel<boolean>('changelistScope', { default: false })

const props = defineProps<{
  visibleCount: number
  totalCount: number
  hasConflicts: boolean
  /** 存在活跃列表：chip 可用前提（无活跃组时过滤只会得到空树，禁用即反馈） */
  hasActiveList: boolean
  /** 活跃列表名（chip title 提示当前收敛目标） */
  activeListName: string
}>()

const { t } = useI18n()

// 点击激活/再点取消，两态互斥（语义与拆分前 toggleAgentScope 一致）
function toggleScope(scope: 'agent' | 'human') {
  agentScope.value = agentScope.value === scope ? 'off' : scope
}

// 状态四态 chips（P-20261003-136）：全部=空态，其余单选、再点激活项回落全部
//（与归属 chips 的「再点取消」同款手感）；冲突项无冲突文件时禁用（点了只会
// 得到误导性空列表，禁用即「当前无冲突」的反馈）
type StatusScope = 'all' | 'unstaged' | 'staged' | 'conflict'
const statusScopeOptions = computed(() => [
  { key: 'all' as StatusScope, testid: 'cp-status-filter-all', label: t('changes.filter.statusAll'), title: t('changes.filter.statusAllTitle'), disabled: false },
  { key: 'unstaged' as StatusScope, testid: 'cp-status-filter-unstaged', label: t('changes.filter.statusUnstaged'), title: t('changes.filter.statusUnstagedTitle'), disabled: false },
  { key: 'staged' as StatusScope, testid: 'cp-status-filter-staged', label: t('changes.filter.statusStaged'), title: t('changes.filter.statusStagedTitle'), disabled: false },
  { key: 'conflict' as StatusScope, testid: 'cp-status-filter-conflict', label: t('changes.filter.statusConflict'), title: props.hasConflicts ? t('changes.filter.statusConflictTitle') : t('changes.filter.statusConflictNone'), disabled: !props.hasConflicts },
])
function setStatusScope(key: StatusScope) {
  if (key !== 'all' && statusScope.value === key) statusScope.value = 'all'
  else statusScope.value = key
}

// 活跃组 chip title 随可用态/收敛目标变化：悬停即知点下去会看到什么
const changelistChipTitle = computed(() => {
  if (!props.hasActiveList) return t('changes.changelist.filterChipNone')
  return changelistScope.value
    ? t('changes.changelist.filterChipOnTitle', { name: props.activeListName })
    : t('changes.changelist.filterChipOffTitle', { name: props.activeListName })
})
const isAnyFiltering = computed(() =>
  filter.value.trim() !== '' || agentScope.value !== 'off' || statusScope.value !== 'all' || changelistScope.value,
)
</script>

<template>
  <div class="cp-filter-row">
    <n-input
      v-model:value="filter"
      size="tiny"
      clearable
      :placeholder="t('changes.filter.placeholder')"
      class="cp-filter-input"
    >
      <template #prefix>
        <n-icon size="11">
          <SearchOutline />
        </n-icon>
      </template>
    </n-input>
    <!-- 会话归属二态过滤（P-20261003-22）：marks 命中与否切分，与路径过滤叠加；
         点击激活/再点取消，两态互斥 -->
    <button
      class="cp-agent-chip"
      data-testid="cp-agent-filter-agent"
      :class="{ active: agentScope === 'agent' }"
      :title="t('changes.agentMarks.filterAgentTitle')"
      @click="toggleScope('agent')"
    >
      {{ t('changes.agentMarks.filterAgent') }}
    </button>
    <button
      class="cp-agent-chip"
      data-testid="cp-agent-filter-human"
      :class="{ active: agentScope === 'human' }"
      :title="t('changes.agentMarks.filterHumanTitle')"
      @click="toggleScope('human')"
    >
      {{ t('changes.agentMarks.filterHuman') }}
    </button>
    <span
      v-if="isAnyFiltering"
      class="cp-filter-count"
    >{{ visibleCount }}/{{ totalCount }}</span>
  </div>
  <!-- 状态维度四态 chips（P-20261003-136）：独立一行不挤压过滤输入（窄侧栏
       6 chip + 输入框同排会把输入框挤没）；与路径/归属过滤 AND 叠加 -->
  <div class="cp-status-row">
    <button
      v-for="opt in statusScopeOptions"
      :key="opt.key"
      class="cp-status-chip"
      :data-testid="opt.testid"
      :class="{ active: statusScope === opt.key }"
      :title="opt.title"
      :disabled="opt.disabled"
      @click="setStatusScope(opt.key)"
    >
      {{ opt.label }}
    </button>
    <!-- 活跃组过滤 chip（P-20261007-19）：分组维度第 4 维，与前三者 AND 叠加；
         无活跃列表时禁用（过滤只会得到空树，禁用即「先设活跃组」的反馈） -->
    <button
      class="cp-status-chip"
      data-testid="cp-changelist-filter"
      :class="{ active: changelistScope }"
      :title="changelistChipTitle"
      :disabled="!hasActiveList"
      @click="changelistScope = !changelistScope"
    >
      {{ t('changes.changelist.filterChip') }}
    </button>
  </div>
</template>

<!-- 样式沿用面板共享样式表（scoped 按组件各编译一份，同 SecuritySettings 拆分先例） -->
<style scoped src="../../views/git/commit-panel.css"></style>
