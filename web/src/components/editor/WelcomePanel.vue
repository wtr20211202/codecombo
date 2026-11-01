<script setup lang="ts">
// 编辑器无打开文件时的欢迎页：Logo + 起步动作 + 最近文件 + 快捷键
import { computed } from 'vue'
import { NIcon, NEmpty } from 'naive-ui'
import {
  AddOutline, SearchOutline, FolderOpenOutline,
  DocumentTextOutline, TimeOutline, CodeSlashOutline,
  SettingsOutline,
} from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useRecentFiles } from '../../composables/useRecentFiles'
import AppLogo from '../common/AppLogo.vue'

const emit = defineEmits<{
  (e: 'open-file', path: string): void
  (e: 'new-file'): void
  (e: 'open-command-palette'): void
  (e: 'open-project'): void
  (e: 'open-settings'): void
}>()

const { t } = useI18n()

// 最近文件记录/过滤逻辑在 useRecentFiles（模块级单例，记录不依赖本面板挂载）
const { currentProjectRecents } = useRecentFiles()

const startActions = computed(() => [
  { id: 'new', icon: AddOutline, label: t('commandPalette.cmdNewFile'), accent: true },
  { id: 'palette', icon: SearchOutline, label: t('commandPalette.title') },
  { id: 'project', icon: FolderOpenOutline, label: t('home.addProject') },
  { id: 'settings', icon: SettingsOutline, label: t('layout.settings') },
])

const shortcuts = computed(() => [
  { keys: ['Ctrl', 'K'], label: t('commandPalette.title') },
  { keys: ['Ctrl', 'Shift', 'P'], label: t('commandPalette.commandsMode') },
  { keys: ['Ctrl', 'P'], label: t('quickOpen.placeholder') },
  { keys: ['Ctrl', '1-9'], label: t('shortcuts.railPanels') },
  { keys: ['Ctrl', ','], label: t('shortcuts.openSettings') },
  { keys: ['Ctrl', 'S'], label: t('layout.save') },
  { keys: ['Alt', '↑/↓'], label: t('layout.diffNav') },
])

function handleAction(id: string) {
  if (id === 'new') emit('new-file')
  else if (id === 'palette') emit('open-command-palette')
  else if (id === 'project') emit('open-project')
  else if (id === 'settings') emit('open-settings')
}
</script>

<template>
  <div class="welcome-root">
    <!-- 顶部品牌区 -->
    <div class="welcome-brand">
      <AppLogo
        :size="56"
        :animated="true"
      />
      <div class="welcome-title">
        Codecombo
      </div>
      <div class="welcome-subtitle">
        {{ t('home.subtitle') }}
      </div>
    </div>

    <div class="welcome-grid">
      <!-- 左侧：起步动作 -->
      <div class="welcome-card">
        <div class="card-header">
          <n-icon size="14">
            <CodeSlashOutline />
          </n-icon>
          <span>{{ t('layout.welcomeStart') }}</span>
        </div>
        <div class="action-grid">
          <button
            v-for="action in startActions"
            :key="action.id"
            class="action-item"
            :class="{ accent: action.accent }"
            @click="handleAction(action.id)"
          >
            <n-icon
              size="16"
              class="action-icon"
            >
              <component :is="action.icon" />
            </n-icon>
            <span class="action-label">{{ action.label }}</span>
          </button>
        </div>
      </div>

      <!-- 右侧：最近文件 -->
      <div class="welcome-card">
        <div class="card-header">
          <n-icon size="14">
            <TimeOutline />
          </n-icon>
          <span>{{ t('layout.welcomeRecent') }}</span>
        </div>
        <div
          v-if="currentProjectRecents.length === 0"
          class="card-empty"
        >
          <n-empty
            size="small"
            :description="t('layout.welcomeNoRecent')"
          />
        </div>
        <div
          v-else
          class="recent-list"
        >
          <button
            v-for="rec in currentProjectRecents"
            :key="rec.path"
            class="recent-item"
            @click="emit('open-file', rec.path)"
          >
            <n-icon
              size="13"
              class="recent-icon"
            >
              <DocumentTextOutline />
            </n-icon>
            <div class="recent-main">
              <div class="recent-name">
                {{ rec.name }}
              </div>
              <div class="recent-path">
                {{ rec.path }}
              </div>
            </div>
          </button>
        </div>
      </div>
    </div>

    <!-- 底部：快捷键卡片 -->
    <div class="welcome-shortcuts">
      <div
        v-for="sc in shortcuts"
        :key="sc.label"
        class="shortcut-item"
      >
        <div class="shortcut-keys">
          <kbd
            v-for="k in sc.keys"
            :key="k"
          >{{ k }}</kbd>
        </div>
        <div class="shortcut-label">
          {{ sc.label }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.welcome-root {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px;
  overflow-y: auto;
}

/* 品牌区 */
.welcome-brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-bottom: 32px;
  animation: welcome-fade-in 0.6s ease;
}

.welcome-title {
  font-size: 22px;
  font-weight: 600;
  color: var(--text-primary);
  font-family: var(--font-display);
  letter-spacing: -0.3px;
  margin-top: 6px;
}

.welcome-subtitle {
  font-size: 12px;
  color: var(--text-muted);
}

/* 卡片网格 */
.welcome-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(260px, 1fr));
  gap: 16px;
  width: 100%;
  max-width: 720px;
  margin-bottom: 24px;
}

.welcome-card {
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 200px;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
}

/* 起步动作 */
.action-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.action-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border-default);
  border-radius: 7px;
  background: var(--bg-surface);
  color: var(--text-body);
  cursor: pointer;
  transition: all var(--motion-base);
  text-align: left;
  font-family: var(--font-ui);
}

.action-item:hover {
  border-color: var(--brand-accent);
  background: var(--brand-accent-soft);
  transform: translateX(2px);
}

.action-item.accent {
  border-color: var(--brand-accent);
  background: var(--brand-accent-soft);
  color: var(--brand-accent);
}

.action-item.accent .action-icon {
  color: var(--brand-accent);
}

.action-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}

.action-item:hover .action-icon {
  color: var(--brand-accent);
}

.action-label {
  font-size: 13px;
  font-weight: 500;
}

/* 最近文件 */
.recent-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
  max-height: 180px;
}

.recent-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: none;
  background: transparent;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  transition: background var(--motion-fast);
  font-family: var(--font-ui);
}

.recent-item:hover {
  background: var(--bg-hover);
}

.recent-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}

.recent-item:hover .recent-icon {
  color: var(--brand-accent);
}

.recent-main {
  flex: 1;
  min-width: 0;
}

.recent-name {
  font-size: 13px;
  color: var(--text-primary);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.recent-path {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 1px;
}

.card-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
}

/* 快捷键 */
.welcome-shortcuts {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  justify-content: center;
  width: 100%;
  max-width: 720px;
  padding: 14px 16px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: 10px;
}

.shortcut-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.shortcut-keys {
  display: flex;
  gap: 3px;
}

.shortcut-keys kbd {
  font-family: var(--font-mono);
  font-size: 10px;
  padding: 2px 6px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-secondary);
  font-weight: 500;
}

.shortcut-label {
  font-size: 11px;
  color: var(--text-muted);
}

@keyframes welcome-fade-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

/* 响应式 */
@media (max-width: 720px) {
  .welcome-grid {
    grid-template-columns: 1fr;
  }
}
</style>
