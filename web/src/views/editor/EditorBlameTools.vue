<script setup lang="ts">
import { ref } from 'vue'
import { NDropdown, NPopover } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { formatDateTime } from '../../utils/git'
import type { BlameEntry, BlameTraceState } from '../../composables/useEditorBlame'
import type { ClaudeSessionInfo } from '../../api/domains/claude'

/**
 * Monaco 编辑器 Blame 工具条（P-20261003-301 自 MonacoEditor.vue 模板按域拆出）：
 * Blame 开关按钮 + 上一版视图面包屑（P-20261002-65）+ 悬停提交摘要卡
 * （P-20261003-318 移植主线增量，含 P-20261007-11 溯源区）+ 徽标右键菜单
 * （看上一版/定位提交/询问此行来历 P-20261004-40）。状态与数据在 useEditorBlame
 * （宿主持有），本组件纯展示：
 * 动作上抛，装饰不经此。挂在 .editor-with-blame 定位上下文内，绝对定位于编辑器
 * 右上/左上；摘要卡与菜单手动定位跟随鼠标（teleport 到 body 不受挂载点影响）。
 */
defineProps<{
  /** 展示条件（非 md preview 态且非远程伪路径/未命名草稿）由宿主计算 */
  visible: boolean
  active: boolean
  loading: boolean
  /** 上一版视图 ref 标记（'' = 工作树当前态，不渲染面包屑） */
  crumbRef: string
  /** 悬停摘要卡（P-20261003-318）：显示开关与定位坐标/条目数据 */
  popShow: boolean
  popX: number
  popY: number
  popEntry: BlameEntry | null
  /** 溯源区（P-20261007-11）：可见性（行提交时刻有效）与查询状态
   *  （undefined = 尚未开始查询） */
  traceVisible: boolean
  traceState?: BlameTraceState
  /** 徽标右键菜单（P-20261002-65）：手动定位状态（show/x/y/options）聚合 */
  menu: { show: boolean; x: number; y: number; options: { key: string; label: string }[] }
}>()
const emit = defineEmits<{
  (e: 'toggle'): void
  (e: 'back'): void
  (e: 'menu-select', key: string): void
  (e: 'menu-close'): void
  (e: 'trace-replay', session: ClaudeSessionInfo): void
  (e: 'pop-hide'): void
}>()
const { t } = useI18n()

// 悬停卡元素（tele 到 body 后 editor mouseleave 的落点守卫依据，宿主经
// defineExpose 迟后取用；v-if 挂在卡上，隐藏期取到 null 属预期）
const popCard = ref<HTMLElement | null>(null)

// n-dropdown select 事件的 key 为 string | number（菜单表全 string 键），归一后上抛
function onMenuSelect(key: string | number) {
  emit('menu-select', String(key))
}
defineExpose({ popEl: popCard })
</script>

<template>
  <!-- Blame 切换按钮（远程伪路径/未命名草稿无项目 Git 域，不提供） -->
  <button
    v-if="visible"
    class="blame-toggle-btn"
    :class="{ active }"
    :title="t('editor.toggleBlame')"
    :disabled="loading"
    @click="emit('toggle')"
  >
    <span v-if="loading">…</span>
    <span v-else>{{ t('editor.blame') }}</span>
  </button>
  <!-- 上一版视图标记（P-20261002-65）：面包屑可退回当前态 -->
  <div
    v-if="active && crumbRef"
    class="blame-prev-crumb"
  >
    <span class="blame-prev-ref">{{ t('blame.prev.view', { ref: crumbRef }) }}</span>
    <button
      class="blame-prev-back"
      :title="t('blame.prev.back')"
      @click="emit('back')"
    >
      ✕
    </button>
  </div>

  <!-- blame 悬停提交摘要卡（P-20261003-318）：Summary + 完整时间戳 + 作者 +
       溯源区（P-20261007-11 该时段活跃会话，可点击直达回放）。
       手动定位先例 = CommitsPanel 提交悬浮层；卡自身 mouseleave 收口（pop-hide
       上抛）——指针从编辑器移入卡内时 editor mouseleave 的落点守卫放行
       （useEditorBlame.handleEditorMouseLeave），溯源条目因此可点 -->
  <n-popover
    trigger="manual"
    placement="bottom-start"
    :show="popShow"
    :x="popX"
    :y="popY"
    :show-arrow="false"
    :delay="0"
    raw
  >
    <div
      v-if="popEntry"
      ref="popCard"
      data-testid="blame-pop"
      class="blame-pop"
      @mouseleave="emit('pop-hide')"
    >
      <div class="blame-pop-summary">{{ popEntry.summary || popEntry.hash }}</div>
      <div class="blame-pop-meta">
        <span class="blame-pop-author">{{ popEntry.author }}</span>
        <span class="blame-pop-time">{{ formatDateTime(popEntry.rawDate) }}</span>
        <span class="blame-pop-hash">{{ popEntry.hash }}</span>
      </div>
      <!-- 溯源区（P-20261007-11）：行提交时刻 × 会话时间窗。诚实边界注记恒显——
           时段关联非因果确证，并行会话全部列出由人判断 -->
      <div
        v-if="traceVisible && traceState"
        data-testid="blame-trace"
        class="blame-trace"
      >
        <div
          v-if="traceState.loading"
          class="blame-trace-state"
        >
          {{ t('blame.trace.loading') }}
        </div>
        <template v-else>
          <div class="blame-trace-head">
            {{ t('blame.trace.title', { n: traceState.payload?.total ?? 0 }) }}
          </div>
          <div
            v-if="traceState.failed"
            class="blame-trace-state"
          >
            {{ t('blame.trace.failed') }}
          </div>
          <div
            v-else-if="!traceState.payload || traceState.payload.total === 0"
            class="blame-trace-state"
            data-testid="blame-trace-empty"
          >
            {{ t('blame.trace.empty') }}
          </div>
          <template v-else>
            <ul class="blame-trace-list">
              <li
                v-for="s in traceState.payload.sessions"
                :key="s.id"
              >
                <button
                  type="button"
                  class="blame-trace-item"
                  data-testid="blame-trace-item"
                  :title="t('blame.trace.openReplay')"
                  @click="emit('trace-replay', s)"
                >
                  <span class="blame-trace-item-title">{{ s.starred ? '★ ' : '' }}{{ s.title }}</span>
                  <span class="blame-trace-item-time">{{ formatDateTime(s.firstAt) }} ~ {{ formatDateTime(s.lastAt) }}</span>
                </button>
              </li>
            </ul>
            <div
              v-if="traceState.payload.truncated"
              class="blame-trace-state"
            >
              {{ t('blame.trace.truncated', { total: traceState.payload.total, shown: traceState.payload.sessions.length }) }}
            </div>
          </template>
          <div class="blame-trace-note">
            {{ t('blame.trace.note') }}
          </div>
        </template>
      </div>
    </div>
  </n-popover>

  <!-- blame 徽标右键菜单（P-20261002-65）：看上一版 / 定位提交 -->
  <n-dropdown
    trigger="manual"
    :show="menu.show"
    :options="menu.options"
    placement="bottom-start"
    :x="menu.x"
    :y="menu.y"
    @select="onMenuSelect"
    @clickoutside="emit('menu-close')"
  />
</template>

<style scoped>
/* Blame 切换按钮 */
.blame-toggle-btn {
  position: absolute;
  top: 6px;
  right: 12px;
  z-index: 10;
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-secondary);
  padding: 2px 10px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--motion-base);
  letter-spacing: 0.5px;
}
.blame-toggle-btn:hover:not(:disabled) {
  border-color: var(--brand-accent);
  color: var(--brand-accent);
}
.blame-toggle-btn.active {
  background: var(--brand-accent-soft);
  color: var(--brand-accent);
  border-color: var(--brand-accent);
}
.blame-toggle-btn:disabled { opacity: 0.6; cursor: wait; }

/* 上一版视图面包屑（P-20261002-65）：与 Blame 按钮同行，靠左 */
.blame-prev-crumb {
  position: absolute;
  top: 6px;
  left: 12px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border: 1px solid var(--brand-accent);
  border-radius: 4px;
  background: var(--brand-accent-soft);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  color: var(--brand-accent);
}
.blame-prev-back {
  border: none;
  background: transparent;
  color: var(--brand-accent);
  font-size: 10px;
  line-height: 1;
  padding: 0;
  cursor: pointer;
}
.blame-prev-back:hover { color: var(--text-primary); }

/* blame 悬停提交摘要卡（P-20261003-318）：与提交悬浮层（CommitsPanel
 * commit-pop）同族形态；NPopover raw 内容仍在组件模板内（带 scoped data-v），
 * tele 到 body 后样式照常命中 */
.blame-pop {
  max-width: 420px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  box-shadow: var(--shadow-strong);
  padding: 8px 10px;
}
.blame-pop-summary {
  font-family: var(--font-mono);
  font-size: 0.9em;
  line-height: 1.5;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}
.blame-pop-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 0.8em;
  color: var(--text-secondary);
}
.blame-pop-author {
  color: var(--accent-blue-light);
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.blame-pop-time { font-family: var(--font-mono); }
.blame-pop-hash { font-family: var(--font-mono); color: var(--accent-blue); }

/* blame 溯源区（P-20261007-11）：时段活跃会话候选清单 + 诚实边界注记。
 * 主题适配全走主题变量（与 blame-pop 同族形态），条目行内两段式（标题 + 窗口） */
.blame-trace {
  margin-top: 4px;
  padding-top: 6px;
  border-top: 1px solid var(--border-default);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.blame-trace-head {
  font-size: 0.78em;
  font-weight: 600;
  color: var(--text-primary);
}
.blame-trace-state {
  font-size: 0.78em;
  color: var(--text-secondary);
}
.blame-trace-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 180px;
  overflow-y: auto;
}
.blame-trace-item {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 3px 6px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}
.blame-trace-item:hover {
  background: var(--bg-hover);
  border-color: var(--border-default);
}
.blame-trace-item-title {
  font-size: 0.8em;
  line-height: 1.4;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.blame-trace-item-time {
  font-size: 0.72em;
  font-family: var(--font-mono);
  color: var(--text-secondary);
}
.blame-trace-note {
  font-size: 0.72em;
  color: var(--text-secondary);
  opacity: 0.85;
}
</style>
