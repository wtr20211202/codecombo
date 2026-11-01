<script setup lang="ts">
import { NButton } from 'naive-ui'
import BrandIcon from '../../common/BrandIcon.vue'
import { useI18n } from '../../../composables/useI18n'
import { openSettingsTab } from '../../../utils/openSettings'

/**
 * dsh 控制台嵌入体（P-20261001-20 从 DshConsoleView 拆出的渲染层）：
 * 提示条（仅本机/证书/降级）+ 令牌引导横幅 + iframe（保活）+ 加载态 + 未运行空态。
 * 探测与启动/重启逻辑在宿主，本组件 props 入 / emits 出。
 */
const { t } = useI18n()

defineProps<{
  /** LAN 浏览器 + 未开放所有 IP：回环代理地址对该浏览器不可达 */
  localOnly: boolean
  /** 「一键开放」进行中 */
  exposing: boolean
  /** https 反代自签证书尚未被接受且未手动关闭 */
  certHintVisible: boolean
  certAcceptUrl: string
  /** 反代监听失败（端口占用等） */
  proxyDegraded: boolean
  /** 令牌失效/未配置：不渲染 iframe，引导居中呈现 */
  tokenNeedsAuth: boolean
  tokenState: string
  activeTargetId: string
  /** 令牌重启动作进行中 */
  restarting: boolean
  /** 启动/重启的提示文案（空串 = 无） */
  launchHint: string
  targetUrl: string
  /** iframe 重载键（手动刷新/重试时递增） */
  iframeKey: number
  loading: boolean
  /** null = 探测中 */
  available: boolean | null
  /** 一键启动进行中 */
  launching: boolean
}>()

const emit = defineEmits<{
  /** 一键开放所有 IP 并重载 iframe（不开新标签） */
  (e: 'expose-and-reload'): void
  (e: 'dismiss-cert-hint'): void
  /** 重启 dsh 进程捕获新令牌（仅本机目标可用） */
  (e: 'restart-for-token'): void
  (e: 'refresh'): void
  /** 一键启动（后端拉起 dsh + 自动捕获令牌） */
  (e: 'launch'): void
  (e: 'iframe-load'): void
}>()
</script>

<template>
  <div class="dsh-body">
    <!-- 仅本机提示：LAN 浏览器 + 未开放所有 IP 时回环代理地址不可达。
         一键开放：调设置接口即时重绑定监听（0.0.0.0）并重载 iframe——
         把「去设置翻开关再回来刷新」收成一步 -->
    <div
      v-if="localOnly"
      class="dsh-hint"
    >
      <span>{{ t('dshConsole.localOnlyHint') }}</span>
      <n-button
        size="tiny"
        type="primary"
        :loading="exposing"
        @click="emit('expose-and-reload')"
      >
        {{ t('dshConsole.exposeAndReload') }}
      </n-button>
    </div>
    <!-- https 反代自签证书：仅在证书尚未被接受（服务端无请求到达）且未被
         手动关闭时显示；iframe 内不显示「继续前往」页，首次使用须在新标签
         打开反代地址手动接受一次 -->
    <div
      v-if="certHintVisible"
      class="dsh-hint"
    >
      <span>{{ t('dshConsole.certHint') }}</span>
      <a
        :href="certAcceptUrl"
        target="_blank"
        rel="noopener"
      >{{ certAcceptUrl }}</a>
      <a
        href="#"
        @click.prevent="emit('dismiss-cert-hint')"
      >{{ t('dshConsole.dismissCertHint') }}</a>
    </div>
    <!-- degraded 提示：反代监听失败（端口占用等），/dsh/url 已报降级 -->
    <div
      v-if="proxyDegraded"
      class="dsh-hint warn"
    >
      {{ t('dshConsole.degradedHint') }}
    </div>
    <!-- 令牌失效/未配置：dsh 鉴权页嵌入后仅有一行英文且无行动入口，
         此处给出可操作引导（一键启动捕获令牌 / 去设置手动填令牌）。
         该状态下不渲染 iframe——dsh 鉴权页是刺眼白底，与暗色主题割裂，
         引导居中呈现（tokenState 由服务端探测，隐藏 iframe 不影响检测） -->
    <div
      v-if="tokenNeedsAuth"
      class="dsh-auth-center"
    >
      <div class="dsh-auth-banner">
        <div class="dsh-auth-text">
          {{ tokenState === 'unset' ? t('dshConsole.tokenUnset') : t('dshConsole.tokenStale') }}
        </div>
        <div class="dsh-auth-actions">
          <n-button
            v-if="!activeTargetId"
            size="tiny"
            type="primary"
            :loading="restarting"
            @click="emit('restart-for-token')"
          >
            {{ t('dshConsole.restartBtn') }}
          </n-button>
          <n-button
            size="tiny"
            quaternary
            @click="openSettingsTab('terminal')"
          >
            {{ t('dshConsole.openDshSettings') }}
          </n-button>
        </div>
        <div
          v-if="launchHint"
          class="dsh-auth-hint"
        >
          {{ launchHint }}
        </div>
      </div>
    </div>
    <iframe
      v-if="targetUrl && !tokenNeedsAuth"
      :key="iframeKey"
      :src="targetUrl"
      class="dsh-frame"
      :class="{ loading }"
      allow="clipboard-read; clipboard-write"
      @load="emit('iframe-load')"
    />
    <div
      v-if="loading"
      class="dsh-loading"
    >
      <span class="dsh-spinner" />
    </div>

    <!-- dsh 未运行：引导空态（探测失败时显示）——一键启动自动捕获 token -->
    <div
      v-if="available === false"
      class="dsh-off"
    >
      <BrandIcon
        name="dsh"
        :size="42"
      />
      <div class="dsh-off-title">
        {{ t('dshConsole.notRunning') }}
      </div>
      <div class="dsh-off-hint">
        {{ t('dshConsole.notRunningHint') }}
      </div>
      <div class="dsh-off-actions">
        <n-button
          v-if="!activeTargetId"
          size="small"
          type="primary"
          :loading="launching"
          @click="emit('launch')"
        >
          {{ launching ? t('dshConsole.launching') : t('dshConsole.launch') }}
        </n-button>
        <n-button
          size="small"
          :disabled="launching"
          @click="emit('refresh')"
        >
          {{ t('dshConsole.retry') }}
        </n-button>
      </div>
      <div
        v-if="launchHint"
        class="dsh-off-hint"
      >
        {{ launchHint }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.dsh-body { flex: 1; min-height: 0; position: relative; }

/* 提示条：仅本机可用 / 反代降级（嵌入体上方，不遮 iframe） */
.dsh-hint {
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--accent-blue) 10%, transparent);
  border-bottom: 1px solid var(--bg-border);
  flex-shrink: 0;
}
.dsh-hint.warn {
  color: var(--accent-orange);
  background: color-mix(in srgb, var(--accent-orange) 10%, transparent);
}

/* 令牌失效/未配置横幅：与提示条同层（嵌入体上方），补行动入口 */
.dsh-auth-banner {
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--accent-orange);
  background: color-mix(in srgb, var(--accent-orange) 10%, transparent);
  border-bottom: 1px solid var(--bg-border);
}

/* 令牌未配置时引导卡居中（替代注定白屏的 dsh 鉴权 iframe）；
   dsh-body 为 block，用 absolute 铺满实现垂直居中（同 dsh-loading 惯例） */
.dsh-auth-center {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.dsh-auth-center .dsh-auth-banner {
  border: 1px solid var(--bg-border);
  border-radius: 8px;
  min-width: 320px;
  max-width: 80%;
  flex-shrink: 0;
}
.dsh-auth-text { line-height: 1.5; }
.dsh-auth-actions { display: flex; align-items: center; gap: 8px; }
.dsh-auth-hint { font-size: 11px; color: var(--text-secondary); line-height: 1.5; white-space: pre-wrap; }

.dsh-frame {
  width: 100%;
  height: 100%;
  border: none;
  background: var(--bg-primary);
}
.dsh-frame.loading { visibility: hidden; }
.dsh-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.dsh-spinner {
  width: 24px; height: 24px;
  border: 3px solid var(--border-default);
  border-top-color: var(--accent-blue);
  border-radius: 50%;
  animation: dsh-spin 0.8s linear infinite;
}
@keyframes dsh-spin { to { transform: rotate(360deg); } }

.dsh-off {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: var(--bg-primary);
}
.dsh-off-title { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.dsh-off-hint { font-size: 12px; color: var(--text-secondary); max-width: 420px; text-align: center; line-height: 1.6; white-space: pre-line; }
.dsh-off-actions { display: flex; gap: 8px; }
</style>
