<script setup lang="ts">
/**
 * 导出中心（P-20261003-266，命令面板「导出中心」入口）：各域导出入口聚合面板。
 *   - 域清单读 utils/exportCenter 注册表（新增域 = 表加一条，不硬编码堆分支）
 *   - 已落地域「前往」跳对应域（跳转分发在宿主 handleExportCenterNavigate）；
 *     未落地域禁用占位（渐进接线——发现面先行，入口随后补）
 *   - 最近导出记录：复用既有审计动作（EXPORT_AUDIT_ACTIONS 过滤一页审计），
 *     标签走 audit.action.* 既有词条，零新增落盘
 */
import { computed, ref, watch } from 'vue'
import { NButton, NIcon, NModal, NTag } from 'naive-ui'
import { ArrowForwardOutline } from '@vicons/ionicons5'
import { auditApi, type AuditEvent } from '@/api/client'
import { useI18n } from '@/composables/useI18n'
import { formatDateTime } from '@/utils/git'
import { EXPORT_AUDIT_ACTIONS, EXPORT_DOMAINS } from '@/utils/exportCenter'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  (e: 'navigate', id: string): void
}>()

const { t, te } = useI18n()

// 最近导出记录：打开面板时拉一页审计（500=服务端单页上限，导出动作低频，
// 窗口内足够代表「最近」）按导出族动作过滤。silent 取数 + 失败留空态——
// 记录区是增值展示，不为主面（域入口）叠失败 toast
const RECENT_LIMIT = 8
const recentLoading = ref(false)
const recent = ref<AuditEvent[]>([])

async function loadRecent() {
  recentLoading.value = true
  try {
    const res = await auditApi.list({ limit: 500, offset: 0 }, { silent: true }) as unknown as { data?: AuditEvent[] }
    recent.value = (res?.data || []).filter(e => EXPORT_AUDIT_ACTIONS.has(e.action)).slice(0, RECENT_LIMIT)
  } catch {
    recent.value = [] // 拉取失败：空态呈现，主面（域入口）不受影响
  } finally {
    recentLoading.value = false
  }
}

watch(() => props.show, (v) => {
  if (v) void loadRecent()
})

/** 跳对应域：关面板 + 通知宿主分发（宿主持有 togglePanel/设置直达等布局链） */
function go(id: string) {
  emit('update:show', false)
  emit('navigate', id)
}

// 动作标签复用 AuditLogPane.actionLabel 同一词条族（audit.action.<点分常量>），
// 未知动作回退原文——未来服务端新增导出动作面板不出现空洞
function actionLabel(action: string): string {
  const key = `audit.action.${action}`
  return te(key) ? t(key) : action
}

const hasRecent = computed(() => recent.value.length > 0)
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    style="width: var(--modal-w-md); max-width: 94vw"
    :title="t('exportCenter.title')"
    :bordered="false"
    data-testid="export-center-modal"
    @update:show="emit('update:show', $event)"
  >
    <p
      class="ec-desc"
      data-testid="export-center-desc"
    >
      {{ t('exportCenter.desc') }}
    </p>

    <!-- 域入口聚合：已落地 = 可点「前往」；未落地 = 占位禁用（渐进接线） -->
    <div class="ec-domains">
      <div
        v-for="d in EXPORT_DOMAINS"
        :key="d.id"
        class="ec-domain"
        :class="{ 'is-landed': d.landed }"
        :data-testid="`export-center-domain-${d.id}`"
      >
        <span class="ec-domain-icon"><n-icon :component="d.icon" /></span>
        <span class="ec-domain-main">
          <span class="ec-domain-title">{{ t(`exportCenter.domains.${d.id}.title`) }}</span>
          <span class="ec-domain-desc">{{ t(`exportCenter.domains.${d.id}.desc`) }}</span>
        </span>
        <n-button
          v-if="d.landed"
          size="tiny"
          secondary
          :data-testid="`export-center-go-${d.id}`"
          :aria-label="t('exportCenter.go')"
          @click="go(d.id)"
        >
          {{ t('exportCenter.go') }}
          <template #icon>
            <n-icon :component="ArrowForwardOutline" />
          </template>
        </n-button>
        <n-tag
          v-else
          size="small"
          :bordered="false"
          class="ec-domain-placeholder"
          :title="t('exportCenter.placeholderTip')"
          :data-testid="`export-center-placeholder-${d.id}`"
        >
          {{ t('exportCenter.placeholder') }}
        </n-tag>
      </div>
    </div>

    <!-- 最近导出记录：复用既有审计动作（打开面板时拉取，失败静默空态） -->
    <div
      class="ec-recent-head"
      data-testid="export-center-recent"
    >
      {{ t('exportCenter.recentTitle') }}
    </div>
    <div
      v-if="recentLoading"
      class="ec-recent-empty"
    >
      {{ t('exportCenter.recentLoading') }}
    </div>
    <p
      v-else-if="!hasRecent"
      class="ec-recent-empty"
      data-testid="export-center-recent-empty"
    >
      {{ t('exportCenter.recentEmpty') }}
    </p>
    <ul
      v-else
      class="ec-recent"
    >
      <li
        v-for="e in recent"
        :key="e.id"
        class="ec-recent-row"
        :title="e.detail || e.action"
      >
        <span class="ec-recent-label">{{ actionLabel(e.action) }}</span>
        <span
          v-if="e.detail"
          class="ec-recent-detail"
        >{{ e.detail }}</span>
        <span class="ec-recent-time">{{ formatDateTime(e.time) }}</span>
      </li>
    </ul>
    <p class="ec-recent-note">
      {{ t('exportCenter.recentNote') }}
    </p>
  </n-modal>
</template>

<style scoped>
.ec-desc {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0 0 10px;
}
.ec-domains {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ec-domain {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 8px 10px;
}
.ec-domain.is-landed:hover {
  border-color: var(--accent-blue);
}
.ec-domain-icon {
  display: inline-flex;
  color: var(--text-secondary);
  font-size: 18px;
}
.is-landed .ec-domain-icon { color: var(--accent-blue); }
.ec-domain-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ec-domain-title {
  font-size: 13px;
  color: var(--text-primary);
}
.ec-domain-desc {
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ec-domain-placeholder {
  flex-shrink: 0;
  opacity: 0.75;
}
.ec-recent-head {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 14px 0 6px;
}
.ec-recent {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 180px;
  overflow-y: auto;
}
.ec-recent-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  min-width: 0;
}
.ec-recent-label {
  color: var(--text-primary);
  flex-shrink: 0;
}
.ec-recent-detail {
  flex: 1;
  min-width: 0;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ec-recent-time {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--text-secondary);
  font-size: 11px;
}
.ec-recent-empty {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 4px 0;
}
.ec-recent-note {
  font-size: 11px;
  color: var(--text-secondary);
  margin: 8px 0 0;
}
</style>
