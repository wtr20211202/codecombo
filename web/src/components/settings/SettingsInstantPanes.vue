<script setup lang="ts">
import { useI18n } from '../../composables/useI18n'
import AgentCronSettings from './AgentCronSettings.vue'
import SentinelSettings from './SentinelSettings.vue'
import SystemMonitorPanel from './SystemMonitorPanel.vue'
import ServerLogsSection from './ServerLogsSection.vue'
import KeymapSettings from './KeymapSettings.vue'
import RemoteDeploySettings from './RemoteDeploySettings.vue'
import RemoteAccessSettings from './RemoteAccessSettings.vue'
import type { SettingsTabKey } from '../../utils/settingsSearch'

/**
 * 设置弹窗「即时生效」分区组（P-20261003-301 自 SettingsModal.vue 按域拆出）：
 * 定时任务/输出哨兵/系统监控/快捷键/远程部署/远程接入六个无暂存、无保存按钮
 * 的分区（各分区内部即时操作或纯只读），合并渲染减少弹窗装配面。带引用
 * （save/isDirty/exit 契约）的分区仍留在 SettingsModal（appearance/terminal/
 * git/remote/security/notifications），关闭护栏与保存链不经本组件。
 * 纯搬运不改逻辑。
 */
defineProps<{
  /** 当前展示的分区键：六个 pane 均 v-show 常驻（锚点定位依赖 DOM 常驻） */
  activeTab: SettingsTabKey
  /** 透传给 keymap/deploy 等需要感知弹窗开合的子分区 */
  show: boolean
}>()
const { t } = useI18n()
</script>

<template>
  <!-- 定时任务（P-20261002-43）：周期性 agent 任务 CRUD + 启停 +
       下次运行预览 + 立即试跑，即时生效无保存按钮 -->
  <div
    v-show="activeTab === 'agentcron'"
    class="content-pane"
    data-testid="settings-pane-agentcron"
  >
    <h3 class="pane-title">
      {{ t('settingsTabs.agentcron') }}
    </h3>
    <AgentCronSettings />
  </div>

  <!-- 输出哨兵（P-20261004-8）：终端输出模式订阅规则 CRUD，即时生效无保存按钮 -->
  <div
    v-show="activeTab === 'sentinel'"
    class="content-pane"
    data-testid="settings-pane-sentinel"
  >
    <h3 class="pane-title">
      {{ t('settingsTabs.sentinel') }}
    </h3>
    <SentinelSettings />
  </div>

  <!-- 远程部署 -->
  <div
    v-show="activeTab === 'deploy'"
    class="content-pane"
    data-testid="settings-pane-deploy"
  >
    <h3 class="pane-title">
      {{ t('settingsTabs.deploy') }}
    </h3>
    <RemoteDeploySettings
      :show="show"
      :pane-active="activeTab === 'deploy'"
    />
  </div>

  <!-- 远程接入（P-20261019-11）：用户自带 VPS 中继的 SSH 反向隧道——
       多档案 + 单活 + 一键切换，预检/状态/公网 URL 复制 + 二维码 -->
  <div
    v-show="activeTab === 'remoteaccess'"
    class="content-pane"
    data-testid="settings-pane-remoteaccess"
  >
    <h3 class="pane-title">
      {{ t('settingsTabs.remoteaccess') }}
    </h3>
    <RemoteAccessSettings
      :show="show"
      :pane-active="activeTab === 'remoteaccess'"
    />
  </div>

  <!-- 系统监控（决策门 M5.2 观测侧用户入口；新指标在此 tab 内扩展） -->
  <div
    v-show="activeTab === 'monitor'"
    class="content-pane"
    data-testid="settings-pane-monitor"
  >
    <h3 class="pane-title">
      {{ t('settingsTabs.monitor') }}
    </h3>
    <SystemMonitorPanel />
    <!-- 服务日志（P-20261008-15）：本机服务自身运行日志的只读查看面——
         诊断分区内「能看指标也能看原文」，服务异常免登机 tail -->
    <ServerLogsSection />
  </div>

  <!-- 快捷键（P-20261002-28）：全局布局键位改绑，即时生效无保存按钮 -->
  <div
    v-show="activeTab === 'keymap'"
    class="content-pane"
    data-testid="settings-pane-keymap"
  >
    <h3 class="pane-title">
      {{ t('settingsTabs.keymap') }}
    </h3>
    <KeymapSettings :show="show" />
  </div>
</template>

<style scoped>
.pane-title {
  font-size: 13px;
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
  margin-bottom: 14px;
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--border-subtle);
}
</style>
