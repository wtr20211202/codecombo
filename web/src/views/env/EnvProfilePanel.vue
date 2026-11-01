<script setup lang="ts">
// 项目环境画像面板（P-20261007-14）：「这个项目跑起来需要什么」一页简历——
// dev 端口观测（探测/上报登记面）+ 可见输出哨兵规则 + 部署目标摘要。
// 数据经 useEnvProfile 单一取数口（服务端 /projects/:id/env-profile 聚合，
// 源级降级键缺席有独立提示）；MVP 不轮询——登记面随观测增量变化，手动刷新
// 同径重拉（诚实边界注记见 i18n boundaryNote）
import { computed, onMounted, watch } from 'vue'
import { NButton, NIcon, NSpin } from 'naive-ui'
import { RefreshOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useEnvProfile } from '../../composables/useEnvProfile'
import { useProjectStore } from '../../stores/project'
import { relativeTimeParts } from '../../utils/relative-time'
import type { EnvProfileDevPort } from '../../api/domains/envprofile'

const { t } = useI18n()
const projectStore = useProjectStore()
const { profile, loading, loadFailed, degraded, refresh } = useEnvProfile()

onMounted(refresh)
// 侧栏容器是 v-show（SidePanel）：面板隐藏不卸载——项目切换即重拉（画像
// 归属随项目走），隐藏期间不做无观测价值的后台请求
watch(() => projectStore.currentProjectId, () => { void refresh() })

const devPorts = computed(() => profile.value?.devPorts ?? [])
const sentinels = computed(() => profile.value?.sentinels ?? [])
const deployTargets = computed(() => profile.value?.deployTargets ?? [])

// lastSeen 相对时效（复用终端「最近活动」文案切片——SessionTimeline.relText
// 同款跨域复用先例）；无观测/解析失败回落空串不出行内时间
function lastSeenLabel(iso: string): string {
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return ''
  const { key, n } = relativeTimeParts(ts)
  return t(`agentTerminal.${key}`, { n })
}

// 哨兵级别徽标语义色（既有 token，无新色）：error=红 / warning=橙 / info=蓝
function levelClass(level: string): string {
  if (level === 'error') return 'is-error'
  if (level === 'warning') return 'is-warning'
  return 'is-info'
}

// 端口来源徽标：detected=被动探测 / reported=主动上报（与 payload source 同词表）
function sourceLabel(source: string): string {
  return source === 'reported' ? t('envProfile.sourceReported') : t('envProfile.sourceDetected')
}

// 哨兵作用域标签：global=全部会话 / 本项目（空 scope 服务端按 global 存量兼容）
function scopeLabel(scope: string): string {
  return scope === 'global' || scope === '' ? t('envProfile.scopeGlobal') : t('envProfile.scopeProject')
}

function portAria(p: EnvProfileDevPort): string {
  return `${p.port} ${p.label || sourceLabel(p.source)}`
}
</script>

<template>
  <div
    class="env-panel"
    data-testid="env-profile-panel"
  >
    <div class="evp-header">
      <span class="evp-title">{{ t('envProfile.title') }}</span>
      <span
        v-if="loadFailed && profile"
        class="evp-stale"
        data-testid="env-profile-stale"
      >{{ t('envProfile.staleHint') }}</span>
      <NButton
        quaternary
        size="tiny"
        class="evp-refresh"
        :title="t('common.refresh')"
        :aria-label="t('common.refresh')"
        data-testid="env-profile-refresh"
        @click="refresh()"
      >
        <template #icon>
          <NIcon><RefreshOutline /></NIcon>
        </template>
      </NButton>
    </div>
    <NSpin
      :show="loading && !profile"
      size="small"
      class="evp-spin"
    >
      <div class="evp-body">
        <div
          v-if="loadFailed && !profile"
          class="evp-failed"
          data-testid="env-profile-failed"
        >
          {{ t('envProfile.loadFailed') }}
        </div>
        <template v-else-if="profile">
          <!-- Dev 端口观测（登记面=探测/上报面，空是诚实值） -->
          <section class="evp-section">
            <h3 class="evp-section-title">
              {{ t('envProfile.portsTitle') }}
              <span class="evp-count">{{ devPorts.length }}</span>
            </h3>
            <ul
              v-if="devPorts.length > 0"
              class="evp-list"
              data-testid="env-profile-ports"
            >
              <li
                v-for="p in devPorts"
                :key="p.port"
                class="evp-row"
                :aria-label="portAria(p)"
              >
                <div class="evp-row-main">
                  <span class="evp-port">:{{ p.port }}</span>
                  <span
                    v-if="p.label"
                    class="evp-label"
                    :title="p.label"
                  >{{ p.label }}</span>
                  <span
                    class="evp-badge"
                    :class="p.source === 'reported' ? 'is-info' : 'is-neutral'"
                  >{{ sourceLabel(p.source) }}</span>
                </div>
                <div class="evp-row-sub">
                  <span
                    v-if="p.sessionName"
                    class="evp-session"
                    :title="p.sessionName"
                  >{{ p.sessionName }}</span>
                  <span
                    v-if="lastSeenLabel(p.lastSeen)"
                    class="evp-time"
                  >{{ lastSeenLabel(p.lastSeen) }}</span>
                </div>
              </li>
            </ul>
            <p
              v-else
              class="evp-empty"
              data-testid="env-profile-ports-empty"
            >
              {{ t('envProfile.portEmpty') }}
            </p>
          </section>

          <!-- 输出哨兵（可见规则；键缺席=源降级） -->
          <section class="evp-section">
            <h3 class="evp-section-title">
              {{ t('envProfile.sentinelsTitle') }}
              <span class="evp-count">{{ sentinels.length }}</span>
            </h3>
            <p
              v-if="degraded.sentinels"
              class="evp-degraded"
              data-testid="env-profile-sentinels-degraded"
            >
              {{ t('envProfile.degradedHint') }}
            </p>
            <ul
              v-else-if="sentinels.length > 0"
              class="evp-list"
              data-testid="env-profile-sentinels"
            >
              <li
                v-for="s in sentinels"
                :key="s.id"
                class="evp-row"
              >
                <div class="evp-row-main">
                  <span
                    class="evp-label"
                    :title="s.name"
                  >{{ s.name }}</span>
                  <span
                    class="evp-badge"
                    :class="levelClass(s.level)"
                  >{{ s.level }}</span>
                </div>
                <div class="evp-row-sub">
                  <span class="evp-scope">{{ scopeLabel(s.scope) }}</span>
                </div>
              </li>
            </ul>
            <p
              v-else
              class="evp-empty"
              data-testid="env-profile-sentinels-empty"
            >
              {{ t('envProfile.sentinelEmpty') }}
            </p>
          </section>

          <!-- 部署目标（摘要：名称/协议/认证形态，地址不出） -->
          <section class="evp-section">
            <h3 class="evp-section-title">
              {{ t('envProfile.targetsTitle') }}
              <span class="evp-count">{{ deployTargets.length }}</span>
            </h3>
            <p
              v-if="degraded.deployTargets"
              class="evp-degraded"
              data-testid="env-profile-targets-degraded"
            >
              {{ t('envProfile.degradedHint') }}
            </p>
            <ul
              v-else-if="deployTargets.length > 0"
              class="evp-list"
              data-testid="env-profile-targets"
            >
              <li
                v-for="h in deployTargets"
                :key="h.id"
                class="evp-row"
              >
                <div class="evp-row-main">
                  <span
                    class="evp-label"
                    :title="h.name"
                  >{{ h.name }}</span>
                  <span class="evp-badge is-neutral">{{ h.protocol }}</span>
                </div>
                <div class="evp-row-sub">
                  <span class="evp-scope">{{ h.authType }}</span>
                </div>
              </li>
            </ul>
            <p
              v-else
              class="evp-empty"
              data-testid="env-profile-targets-empty"
            >
              {{ t('envProfile.targetEmpty') }}
            </p>
          </section>

          <p class="evp-note">
            {{ t('envProfile.boundaryNote') }}
          </p>
        </template>
      </div>
    </NSpin>
  </div>
</template>

<style scoped>
.env-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.evp-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px 6px;
  flex-shrink: 0;
}
.evp-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}
.evp-refresh {
  margin-left: auto;
}
.evp-stale {
  font-size: 10px;
  color: var(--accent-yellow-warm);
}
.evp-spin {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.evp-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 12px 10px;
}
.evp-failed,
.evp-empty {
  padding: 8px 0;
  font-size: 12px;
  color: var(--text-secondary);
}
.evp-failed {
  color: var(--accent-orange);
}
.evp-degraded {
  padding: 2px 0;
  font-size: 11px;
  color: var(--accent-yellow-warm);
}
.evp-section {
  padding: 6px 0 2px;
}
.evp-section + .evp-section {
  border-top: 1px solid var(--border-default);
  margin-top: 6px;
}
.evp-section-title {
  margin: 0 0 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: 6px;
}
.evp-count {
  font-weight: 400;
  color: var(--text-secondary);
}
.evp-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.evp-row {
  padding: 4px 0;
}
.evp-row + .evp-row {
  border-top: 1px dashed var(--border-default);
}
.evp-row-main {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.evp-row-sub {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-left: 2px;
  margin-top: 1px;
  font-size: 11px;
  color: var(--text-secondary);
  min-width: 0;
}
.evp-port {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-primary);
  flex-shrink: 0;
}
.evp-label {
  font-size: 12px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.evp-badge {
  flex-shrink: 0;
  font-size: 10px;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 3px;
  border: 1px solid var(--border-default);
  color: var(--text-secondary);
}
.evp-badge.is-neutral {
  color: var(--text-secondary);
}
.evp-badge.is-info {
  color: var(--accent-blue);
  border-color: color-mix(in srgb, var(--accent-blue) 45%, transparent);
}
.evp-badge.is-warning {
  color: var(--accent-orange);
  border-color: color-mix(in srgb, var(--accent-orange) 45%, transparent);
}
.evp-badge.is-error {
  color: var(--accent-red);
  border-color: color-mix(in srgb, var(--accent-red) 45%, transparent);
}
.evp-session,
.evp-scope {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.evp-time {
  margin-left: auto;
  flex-shrink: 0;
}
.evp-note {
  margin: 10px 0 0;
  padding-top: 6px;
  border-top: 1px solid var(--border-default);
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
}
</style>
