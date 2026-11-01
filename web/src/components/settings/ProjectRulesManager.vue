<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NIcon, NSelect, NSpin, NTag, useMessage } from 'naive-ui'
import { RefreshOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useProjectStore } from '../../stores/project'
import { useLocaleStore } from '../../stores/locale'
import { PROJECT_RULE_FILES } from '../../utils/projectRuleTemplates'
import { useProjectRules } from '../../composables/useProjectRules'

/**
 * 项目规则文件管理（P-20261003-181）：挂在设置 → 通用 → 智能体分区
 * （AgentTaskTemplateManager 同款自包含区块模式）。已知 agent 规则文件
 * （CLAUDE.md/AGENTS.md/.cursorrules，清单从紧）存在即列、点击经文件深链
 * 直达编辑器；缺失可「从模板创建」最小模板预填。规则文件是项目级配置而
 * 设置是全局面——顶部项目选择器定扫描目标，默认当前项目。
 */
const emit = defineEmits<{
  /** 「编辑」已发起文件深链，宿主收起设置弹窗让位编辑器 */
  (e: 'open-file'): void
}>()

const { t } = useI18n()
const message = useMessage()
const router = useRouter()
const projectStore = useProjectStore()
const localeStore = useLocaleStore()
const { statuses, scanning, scan, createFromTemplate } = useProjectRules()

const selectedProjectId = ref('')
/** 正在从模板创建的文件名（空 = 无；创建中禁其他创建钮防并发扫描错乱） */
const creating = ref('')

const projectOptions = computed(() =>
  projectStore.projects.map(p => ({ label: p.name, value: p.id })),
)

// 默认扫描目标：当前项目优先（项目页内打开设置的场景），否则首个有效项目
// （store.fetchProjects 的同款口径——首位可能是路径失效的项目）
function pickDefaultProject(): string {
  const { projects, currentProjectId } = projectStore
  if (currentProjectId && projects.some(p => p.id === currentProjectId)) return currentProjectId
  return (projects.find(p => p.valid !== false) ?? projects[0])?.id || ''
}

onMounted(async () => {
  if (!projectStore.projects.length) await projectStore.fetchProjects()
  selectedProjectId.value = pickDefaultProject()
})

// 切项目即重扫；不用 immediate——挂载流程里赋默认值即自然触发首次扫描
watch(selectedProjectId, (pid) => { if (pid) void scan(pid) })

function refresh() {
  if (selectedProjectId.value) void scan(selectedProjectId.value)
}

function onRowClick(name: string) {
  if (statuses.value[name] === 'exists') openInEditor(name)
}

/** 已存在 → 文件深链直达编辑器（Layout 消费链负责必要时切项目 + 打开 + 清 query） */
function openInEditor(name: string) {
  if (!selectedProjectId.value) return
  emit('open-file')
  void router.push({ path: '/project', query: { file: name, project: selectedProjectId.value } })
}

async function create(name: string) {
  const pid = selectedProjectId.value
  if (!pid || creating.value) return
  creating.value = name
  try {
    const r = await createFromTemplate(pid, name, localeStore.currentLocale)
    if (r === 'created') message.success(t('settings.projectRules.created', { name }))
    else if (r === 'exists') message.info(t('settings.projectRules.createExists', { name }))
    // failed：createFile 非 silent，拦截器已弹具体错误，这里不叠 toast
  } finally {
    creating.value = ''
  }
}

// 每行描述词条（文件名含点不便做 i18n 键层级，显式映射；键类型=清单 union 防漏配）
const DESC_KEYS: Record<(typeof PROJECT_RULE_FILES)[number], string> = {
  'CLAUDE.md': 'settings.projectRules.descClaudeMd',
  'AGENTS.md': 'settings.projectRules.descAgentsMd',
  '.cursorrules': 'settings.projectRules.descCursorrules',
}
</script>

<template>
  <div
    class="project-rules"
    data-testid="settings-project-rules"
  >
    <div class="pr-head">
      <span class="pr-title">{{ t('settings.projectRules.title') }}</span>
      <div class="pr-head-actions">
        <n-select
          v-model:value="selectedProjectId"
          size="tiny"
          :options="projectOptions"
          :placeholder="t('settings.projectRules.selectPlaceholder')"
          class="pr-project-select"
          data-testid="project-rules-project"
        />
        <n-button
          size="tiny"
          quaternary
          :loading="scanning"
          :title="t('settings.projectRules.refresh')"
          data-testid="project-rules-refresh"
          @click="refresh"
        >
          <template #icon>
            <n-icon size="13">
              <RefreshOutline />
            </n-icon>
          </template>
        </n-button>
      </div>
    </div>
    <div class="pr-hint">
      {{ t('settings.projectRules.hint') }}
    </div>

    <div
      v-if="projectOptions.length === 0"
      class="pr-empty"
    >
      {{ t('settings.projectRules.noProjects') }}
    </div>
    <n-spin
      v-else
      :show="scanning"
      size="small"
    >
      <div
        v-for="f in PROJECT_RULE_FILES"
        :key="f"
        class="pr-row"
        :class="{ clickable: statuses[f] === 'exists' }"
        :data-testid="'project-rules-row-' + f"
        @click="onRowClick(f)"
      >
        <span class="pr-row-name">{{ f }}</span>
        <span class="pr-row-desc">{{ t(DESC_KEYS[f]) }}</span>
        <span class="pr-row-actions">
          <n-tag
            v-if="statuses[f] === 'exists'"
            size="small"
            :bordered="false"
            class="pr-tag-exists"
          >
            {{ t('settings.projectRules.exists') }}
          </n-tag>
          <n-tag
            v-else-if="statuses[f] === 'missing'"
            size="small"
            :bordered="false"
            class="pr-tag-missing"
          >
            {{ t('settings.projectRules.missing') }}
          </n-tag>
          <n-spin
            v-else
            :size="11"
          />
          <n-button
            v-if="statuses[f] === 'exists'"
            size="tiny"
            quaternary
            @click.stop="openInEditor(f)"
          >
            {{ t('settings.projectRules.edit') }}
          </n-button>
          <n-button
            v-else-if="statuses[f] === 'missing'"
            size="tiny"
            type="primary"
            :loading="creating === f"
            :disabled="!!creating && creating !== f"
            data-testid="project-rules-create"
            @click.stop="create(f)"
          >
            {{ t('settings.projectRules.createFromTemplate') }}
          </n-button>
        </span>
      </div>
    </n-spin>
  </div>
</template>

<style scoped>
.project-rules { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border-default); }
.pr-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); margin-bottom: 6px; }
.pr-title { font-size: 13px; font-weight: var(--fw-semibold); color: var(--text-primary); }
.pr-head-actions { display: flex; align-items: center; gap: var(--space-1); }
.pr-project-select { width: 150px; }
.pr-hint { font-size: var(--fs-meta-min, 11.5px); color: var(--text-secondary); margin-bottom: 10px; }
.pr-empty { padding: var(--space-2) 0; font-size: var(--fs-meta-min, 11.5px); color: var(--text-dim); }
.pr-row {
  display: flex; align-items: center; gap: var(--space-2);
  padding: 6px 10px;
  border: 1px solid var(--border-default); border-radius: var(--radius-md);
  margin-bottom: 6px;
}
/* 已存在行整行可点（点击进编辑器）；缺失行只有创建按钮可点 */
.pr-row.clickable { cursor: pointer; }
.pr-row.clickable:hover { background: var(--bg-hover); }
.pr-row-name {
  font-family: var(--font-mono);
  font-size: 12px; font-weight: var(--fw-semibold); color: var(--text-primary);
  flex-shrink: 0;
}
.pr-row-desc {
  flex: 1; min-width: 0;
  font-size: var(--fs-meta-min, 11.5px); color: var(--text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pr-row-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.pr-tag-exists { background: color-mix(in srgb, var(--accent-green) 18%, transparent); color: var(--accent-green); }
.pr-tag-missing { background: var(--bg-hover); color: var(--text-dim); }
</style>
