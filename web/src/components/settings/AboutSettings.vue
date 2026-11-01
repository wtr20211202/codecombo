<script setup lang="ts">
// 关于分区（P-20261003-265 自 SettingsModal 拆出）：产品标识 + 构建信息
// （VersionPanel）。buildInfo 随 GET /settings 一并返回——自加载走 SecuritySettings
// 同款「onMounted if show + watch show」双保险（n-modal 默认 display-directive="if"
// 内容随开关重建），每次打开设置即刷新版本快照，与拆分前加载时机一致
import { ref, watch, onMounted } from 'vue'
import { settingsApi } from '../../api/client'
import AppLogo from '../common/AppLogo.vue'
import VersionPanel from '../home/VersionPanel.vue'

const props = defineProps<{ show: boolean }>()

const buildInfo = ref<{ version: string; commit: string; buildTime: string; goVersion: string; platform: string } | null>(null)

async function load() {
  try {
    const res: any = await settingsApi.get()
    buildInfo.value = {
      version: res.data?.version || 'dev',
      commit: res.data?.commit || 'none',
      buildTime: res.data?.buildTime || 'unknown',
      goVersion: res.data?.goVersion || '',
      platform: res.data?.platform || '',
    }
  } catch { /* silent */ }
}

onMounted(() => {
  if (props.show) void load()
})
watch(() => props.show, (val) => {
  if (val) void load()
})
</script>

<template>
  <div
    v-if="buildInfo"
    class="about-card"
  >
    <div class="about-header">
      <AppLogo
        :size="40"
        :animated="true"
      />
      <div class="about-meta">
        <div class="about-name">
          Codecombo
        </div>
      </div>
    </div>
    <div class="about-panel">
      <VersionPanel :build-info="buildInfo" />
    </div>
  </div>
</template>

<style scoped>
/* 关于 */
.about-panel { margin-top: var(--space-3); }
.about-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.about-header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  background: var(--bg-canvas);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-subtle);
}
.about-meta { display: flex; flex-direction: column; gap: 2px; }
.about-name { font-size: 16px; font-weight: var(--fw-semibold); color: var(--text-primary); font-family: var(--font-display); }
</style>
