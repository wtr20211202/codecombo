<script setup lang="ts">
import { NButton, NIcon } from 'naive-ui'
import { ArrowDownOutline, ArrowUpOutline, GitBranchOutline, LockClosedOutline, TrashOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'

/**
 * 首页项目卡片（最近打开 / 全部 / 已冻结 三组共用，自 HomeView 抽出去重）：
 * 名称/无效徽标/删除按钮/分支/ahead-behind/远程地址/路径。
 * frozen=true（P-20261003-9 已冻结组）：整卡弱化样式，悬停恢复，交互不变。
 * locked=true（P-20261004-3 硬锁）：🔒 徽标常驻（归档不可变档提示），交互不变。
 */
defineProps<{
  project: {
    id: string
    name: string
    path: string
    currentBranch?: string
    remoteURL?: string
    valid?: boolean
    gitRepo?: boolean
    frozen?: boolean
    locked?: boolean
  }
  ahead: number
  behind: number
  isRecent?: boolean
  frozen?: boolean
  index: number
}>()

const emit = defineEmits<{
  (e: 'enter'): void
  (e: 'remove', ev: MouseEvent): void
  (e: 'relocate', ev: MouseEvent): void
  (e: 'context', ev: MouseEvent): void
}>()

const { t } = useI18n()
</script>

<template>
  <div
    class="project-card"
    :class="{ 'project-card-invalid': project.valid === false, 'is-recent': isRecent, 'project-card-frozen': frozen }"
    :style="{ '--stagger-index': index }"
    tabindex="0"
    @click="emit('enter')"
    @keyup.enter="emit('enter')"
    @contextmenu.prevent="emit('context', $event)"
  >
    <div class="project-card-accent" />
    <div class="project-card-header">
      <span class="project-name">{{ project.name }}</span>
      <span
        v-if="project.valid === false"
        class="project-invalid-badge"
      >{{ t('home.invalidPath') }}</span>
      <span
        v-else-if="project.gitRepo === false"
        class="project-nongit-badge"
      >{{ t('home.notGitBadge') }}</span>
      <!-- 硬锁徽标（P-20261004-3）：归档不可变档常驻提示（悬停 title 说明） -->
      <span
        v-if="project.locked === true"
        class="project-locked-badge"
        :title="t('project.locked.badgeTitle')"
      >
        <n-icon size="11">
          <LockClosedOutline />
        </n-icon>
      </span>
      <n-button
        size="tiny"
        quaternary
        type="error"
        class="project-remove-btn"
        :title="t('home.removeTitle')"
        :aria-label="t('home.removeTitle')"
        @click="emit('remove', $event)"
      >
        <template #icon>
          <n-icon size="14">
            <TrashOutline />
          </n-icon>
        </template>
      </n-button>
    </div>
    <div
      v-if="project.valid === false"
      class="project-invalid-hint project-invalid-actions"
    >
      <span class="invalid-hint-text">{{ t('home.invalidHint') }}</span>
      <!-- 常驻动作入口：失效卡的主动作是重定位而非删除（删了会丢项目身份） -->
      <button
        class="invalid-relocate-btn"
        @click.stop="emit('relocate', $event)"
      >
        {{ t('home.relocate') }}
      </button>
    </div>
    <div
      v-else-if="project.gitRepo === false"
      class="project-invalid-hint project-nongit-hint"
    >
      {{ t('home.notGitHint') }}
    </div>
    <template v-else>
      <div class="project-branch">
        <n-icon
          size="13"
          class="branch-icon"
        >
          <GitBranchOutline />
        </n-icon>
        <span
          class="branch-name"
          :title="project.currentBranch || t('home.noBranch')"
        >{{ project.currentBranch || t('home.noBranch') }}</span>
        <span
          v-if="ahead > 0"
          class="badge-ahead"
        >
          <n-icon size="10"><ArrowUpOutline /></n-icon>{{ ahead }}
        </span>
        <span
          v-if="behind > 0"
          class="badge-behind"
        >
          <n-icon size="10"><ArrowDownOutline /></n-icon>{{ behind }}
        </span>
      </div>
      <div
        v-if="project.remoteURL"
        class="project-remote"
        :title="project.remoteURL"
      >
        {{ project.remoteURL }}
      </div>
      <div
        class="project-path"
        :title="project.path"
      >
        {{ project.path }}
      </div>
    </template>
  </div>
</template>

<style scoped>
.project-card {
  position: relative;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 16px 16px 14px;
  cursor: pointer;
  transition: transform var(--motion-base), border-color var(--motion-base), box-shadow var(--motion-base);
  overflow: hidden;
  animation: card-enter 0.35s ease backwards;
  animation-delay: calc(var(--stagger-index, 0) * 30ms);
}

@keyframes card-enter {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.project-card::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, var(--brand-accent-soft) 0%, transparent 35%);
  opacity: 0;
  transition: opacity var(--motion-base);
  pointer-events: none;
}

.project-card:hover {
  transform: translateY(-2px);
  border-color: var(--brand-accent);
  box-shadow: var(--shadow-soft), 0 0 0 1px var(--brand-accent-soft);
}

.project-card:hover::before {
  opacity: 0.5;
}

.project-card.is-recent {
  border-left: 2px solid var(--brand-accent);
}

/* 已冻结组（P-20261003-9）：整卡弱化（降不透明度+去饱和），悬停恢复以便辨认/操作 */
.project-card-frozen {
  opacity: 0.55;
  filter: saturate(0.6);
}
.project-card-frozen:hover {
  opacity: 1;
  filter: none;
}

.project-nongit-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  color: var(--text-secondary);
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  flex-shrink: 0;
}

/* 硬锁徽标（P-20261004-3）：小锁图标中性呈现（锁是状态不是错误，不走语义红） */
.project-locked-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 5px;
  border-radius: 3px;
  color: var(--accent-orange);
  border: 1px solid color-mix(in srgb, var(--accent-orange) 45%, transparent);
  background: color-mix(in srgb, var(--accent-orange) 10%, transparent);
  flex-shrink: 0;
}
.project-card-invalid {
  border-color: color-mix(in srgb, var(--accent-red) 27%, transparent);
  opacity: 0.75;
}

.project-card-invalid:hover {
  border-color: var(--accent-red);
  box-shadow: var(--shadow-pop-danger);
}

.project-card:focus-visible {
  outline: 2px solid var(--brand-accent);
  outline-offset: 2px;
}

.project-card-accent {
  position: absolute;
  top: 0;
  right: 0;
  width: 60px;
  height: 60px;
  background: radial-gradient(circle at top right, var(--brand-accent-soft), transparent 70%);
  opacity: 0.6;
  pointer-events: none;
}

.project-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  position: relative;
}

.project-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-display);
  letter-spacing: -0.2px;
}

.project-remove-btn {
  opacity: 0;
  transition: opacity var(--motion-base);
  flex-shrink: 0;
}

.project-card:hover .project-remove-btn {
  opacity: 1;
}

.project-branch {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-size: 12px;
  position: relative;
}

.branch-icon {
  color: var(--brand-accent);
  flex-shrink: 0;
}

.branch-name {
  color: var(--text-body);
  font-family: var(--font-mono);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 180px;
}

.badge-ahead,
.badge-behind {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 8px;
  font-family: var(--font-mono);
}

.badge-ahead {
  background: color-mix(in srgb, var(--accent-green) 16%, transparent);
  color: var(--accent-green);
}

.badge-behind {
  background: color-mix(in srgb, var(--accent-orange) 18%, transparent);
  color: var(--accent-orange);
}

.project-invalid-badge {
  font-size: 10px;
  color: var(--accent-red);
  border: 1px solid var(--accent-red);
  border-radius: 3px;
  padding: 0 4px;
  flex-shrink: 0;
}

.project-invalid-hint {
  font-size: 12px;
  color: var(--accent-red);
  margin-bottom: 6px;
  padding: 6px 10px;
  background: color-mix(in srgb, var(--accent-red) 10%, transparent);
  border-radius: 6px;
  position: relative;
}

/* 失效提示行：文案 + 常驻「重新定位」动作按钮 */
.project-invalid-actions {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.invalid-hint-text {
  min-width: 0;
}
.invalid-relocate-btn {
  flex-shrink: 0;
  font-size: 11px;
  line-height: 1.4;
  color: var(--accent-red);
  background: var(--bg-primary);
  border: 1px solid color-mix(in srgb, var(--accent-red) 45%, transparent);
  border-radius: 4px;
  padding: 1px 8px;
  cursor: pointer;
  transition: all var(--motion-base);
}
.invalid-relocate-btn:hover {
  color: var(--text-on-accent);
  background: var(--accent-red);
  border-color: var(--accent-red);
}

/* 非 Git 提示是中性信息（文件浏览与终端可用），不走错误语义红——
   必须排在 .project-invalid-hint 之后才能覆盖其红色（同权重后者胜） */
.project-invalid-hint.project-nongit-hint {
  color: var(--text-dim);
  background: color-mix(in srgb, var(--text-dim) 8%, transparent);
}
.project-invalid-hint.project-nongit-hint:hover {
  color: var(--text-secondary);
}

.project-remote {
  font-size: 11px;
  color: var(--text-link);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-bottom: 4px;
  font-family: var(--font-mono);
  position: relative;
}

.project-path {
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  position: relative;
}
</style>
