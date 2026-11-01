<script setup lang="ts">
// 首跑浏览器语言建议条（P-20261002-113）：首页顶栏下的细横条。显隐与一次性
// 记忆由 useLocaleSuggest 管控（首跑判定 = 无 locale 存储 + 默认 zh 生效 +
// 浏览器主语言非 zh）；「切换」走 locale store 既有 setLocale 链路，「保持
// 中文」写 safeStorage 永不再现。组件自包含（动作不经装配点转发）。
import { useI18n } from '../../composables/useI18n'
import { useLocaleSuggest } from '../../composables/useLocaleSuggest'

const { t } = useI18n()
const { visible, dismiss, accept } = useLocaleSuggest()
</script>

<template>
  <Transition name="locale-suggest">
    <div
      v-if="visible"
      class="locale-suggest-bar"
      data-testid="locale-suggest-bar"
      role="status"
    >
      <span
        class="locale-suggest-dot"
        aria-hidden="true"
      />
      <span class="locale-suggest-text">{{ t('localeSuggest.message') }}</span>
      <span class="locale-suggest-spacer" />
      <button
        type="button"
        class="locale-suggest-action locale-suggest-primary"
        data-testid="locale-suggest-switch"
        @click="accept"
      >
        {{ t('localeSuggest.switch') }}
      </button>
      <button
        type="button"
        class="locale-suggest-action"
        data-testid="locale-suggest-dismiss"
        @click="dismiss"
      >
        {{ t('localeSuggest.keep') }}
      </button>
    </div>
  </Transition>
</template>

<style scoped>
/* 视觉对齐 layout.css 的 .http-warning-bar（P-20261002-30）细横条形态，色系
   用中性面板底 + accent 蓝点：本条是友好的一次性建议（非安全警示），不抢
   首屏注意力；出现在 .home-header 与 .home-content 之间随 flex 自然排布 */
.locale-suggest-bar {
  flex-shrink: 0;
  height: 28px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 28px;
  font-size: var(--fs-small);
  color: var(--text-secondary);
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-default);
}

.locale-suggest-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent-blue);
}

.locale-suggest-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 左侧消息与右侧动作之间弹性撑开：窄窗口时优先保动作按钮完整可见 */
.locale-suggest-spacer {
  flex: 1;
}

.locale-suggest-action {
  flex-shrink: 0;
  border: none;
  background: none;
  padding: 0 2px;
  font-size: var(--fs-small);
  color: var(--text-muted);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
  opacity: 0.85;
}

.locale-suggest-action:hover {
  opacity: 1;
}

.locale-suggest-primary {
  color: var(--accent-blue);
  font-weight: 500;
}

/* 出现/消失淡入淡出（同 .http-bar 节奏） */
.locale-suggest-enter-active,
.locale-suggest-leave-active {
  transition: opacity var(--motion-slow) ease;
}
.locale-suggest-enter-from,
.locale-suggest-leave-to {
  opacity: 0;
}
</style>
