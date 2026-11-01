<script setup lang="ts">
/**
 * 过程实况回放器（P-20261001-15，自研轻量组件，零新依赖）：
 * cast（asciinema v2）按时序喂给 xterm 实例——播放/暂停/倍速 + 进度拖拽 +
 * 既有 OSC 133 命令索引做章节跳转（E→C→D 链解析，复用服务端 shell integration
 * 约定）。固定 cast header 尺寸渲染（忠实实况，不做容器自适应重排）；
 * 事件文本与章节标签均过兜底二次遮蔽（utils/sensitiveMask 模式集，经 utils/recording parseCast 应用）。
 * 录制态（status=recording）显示实况徽标 + 手动刷新（重取 cast 重放）。
 * 「存为运行书」（P-20261005-3）：复用同一 OSC133 命令索引把命令序列映射为
 * 运行书草稿（相邻重复折叠/失败标注），经 runbookDraft store 直达交付
 * RunbookPanel 新建表单（生成物是草稿非直入库，人工过目后落库）；
 * 无命令索引（裸 sh 环境，同章节跳转判定）时入口隐藏。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { NButton, NIcon, NSlider, NSpin, NTag } from 'naive-ui'
import { Terminal } from '@xterm/xterm'
import {
  BookOutline,
  PlayOutline,
  PauseOutline,
  PlaySkipForwardOutline,
  RefreshOutline,
} from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { recordingApi, type RecordingMeta } from '../../api/domains/recording'
import {
  castChaptersToSteps,
  formatClock,
  parseCast,
  type CastChapter,
  type CastEvent,
} from '../../utils/recording'
import { useRunbookDraftStore } from '../../stores/runbookDraft'
import { useTerminalThemeStore } from '../../stores/terminal-theme'
import { useFontStore } from '../../stores/font'

const props = defineProps<{ recording: RecordingMeta }>()

const emit = defineEmits<{ (e: 'drafted'): void }>()

const { t } = useI18n()
const themeStore = useTerminalThemeStore()
const fontStore = useFontStore()

// ============== 回放状态 ==============
const container = ref<HTMLElement | null>(null)
const loading = ref(false)
const playing = ref(false)
const speed = ref(1)
const elapsed = ref(0)
const duration = ref(0)
const events = ref<CastEvent[]>([])
const chapters = ref<CastChapter[]>([])
const dims = ref<{ cols: number; rows: number }>({ cols: 80, rows: 24 })
const activeChapter = ref(-1)

const SPEEDS = [0.5, 1, 2, 4, 8]
const TICK_MS = 100

let term: import('@xterm/xterm').Terminal | null = null
let timer: ReturnType<typeof setInterval> | null = null
let cursor = 0

async function loadCast(): Promise<void> {
  loading.value = true
  pause()
  try {
    const buf = (await recordingApi.cast(props.recording.id)) as unknown as ArrayBuffer
    const parsed = parseCast(new TextDecoder('utf-8', { fatal: false }).decode(buf))
    events.value = parsed.events
    chapters.value = parsed.chapters
    duration.value = parsed.events.length ? parsed.events[parsed.events.length - 1]!.t : 0
    dims.value = {
      cols: parsed.header.width ?? 80,
      rows: parsed.header.height ?? 24,
    }
    await nextTick()
    ensureTerm()
    seekTo(0)
  } finally {
    loading.value = false
  }
}

// ============== xterm 实例（回放专用，禁输入） ==============
function ensureTerm(): void {
  if (term || !container.value) return
  term = new Terminal({
    cols: dims.value.cols,
    rows: dims.value.rows,
    disableStdin: true,
    cursorBlink: false,
    scrollback: 2000,
    fontSize: fontStore.sizes.terminal,
    fontFamily: themeStore.currentFontStack,
    theme: themeStore.currentThemeDef.colors,
  })
  term.open(container.value)
}

// ============== 播放引擎 ==============
function drain(): void {
  if (!term) return
  while (cursor < events.value.length && events.value[cursor]!.t <= elapsed.value) {
    term.write(events.value[cursor]!.text)
    cursor++
  }
  syncActiveChapter()
}

function syncActiveChapter(): void {
  let idx = -1
  for (let i = 0; i < chapters.value.length; i++) {
    if (chapters.value[i]!.t <= elapsed.value) idx = i
    else break
  }
  activeChapter.value = idx
}

function tick(): void {
  elapsed.value = Math.min(duration.value, elapsed.value + (TICK_MS / 1000) * speed.value)
  drain()
  if (elapsed.value >= duration.value) pause()
}

function play(): void {
  if (playing.value || duration.value === 0) return
  if (elapsed.value >= duration.value) seekTo(0)
  playing.value = true
  timer = setInterval(tick, TICK_MS)
}

function pause(): void {
  playing.value = false
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function seekTo(t: number): void {
  if (!term) return
  term.reset()
  cursor = 0
  elapsed.value = t
  drain()
}

function toggle(): void {
  if (playing.value) pause()
  else play()
}

function onSeek(v: number): void {
  pause()
  seekTo(v)
}

async function refresh(): Promise<void> {
  await loadCast()
  play()
}

// ============== 存为运行书（P-20261005-3）==============
const draftStore = useRunbookDraftStore()

/** 草稿标题的日期段（本地时区 YYYY-MM-DD；不依赖 toLocaleDateString 的平台差异） */
function todayLabel(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 命令索引 → 运行书草稿（onFailure 沿面板新建默认 continue；失败命令照录，
 *  步骤说明标注「录制时失败（exit N）」供人工删改）并直达运行书面板；
 *  drafted 通知宿主收起弹层（下一步的过目确认在面板新建表单里） */
function saveAsRunbook(): void {
  if (!chapters.value.length) return
  draftStore.openInPanel({
    title: t('recording.runbookTitle', { date: todayLabel() }),
    onFailure: 'continue',
    steps: castChaptersToSteps(chapters.value).map((s) => ({
      command: s.command,
      description:
        s.exitCode !== undefined && s.exitCode !== 0
          ? t('recording.runbookFailNote', { code: s.exitCode })
          : undefined,
    })),
    fromRecording: true,
  })
  emit('drafted')
}

// ============== 生命周期 ==============
watch(
  () => props.recording.id,
  () => {
    loadCast()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  pause()
  term?.dispose()
  term = null
})

const live = computed(() => props.recording.status === 'recording')
</script>

<template>
  <div class="cr-root">
    <div class="cr-toolbar">
      <n-button
        size="tiny"
        :disabled="duration === 0"
        @click="toggle"
      >
        <n-icon size="13">
          <PauseOutline v-if="playing" />
          <PlayOutline v-else />
        </n-icon>
        {{ playing ? t('recording.pause') : t('recording.play') }}
      </n-button>
      <n-button
        size="tiny"
        quaternary
        :disabled="duration === 0"
        :title="t('recording.replay')"
        @click="seekTo(0); play()"
      >
        <n-icon size="13">
          <PlaySkipForwardOutline />
        </n-icon>
      </n-button>
      <div class="cr-btns">
        <n-button
          v-for="s in SPEEDS"
          :key="s"
          size="tiny"
          :quaternary="speed !== s"
          :type="speed === s ? 'primary' : 'default'"
          @click="speed = s"
        >
          {{ s }}×
        </n-button>
      </div>
      <n-slider
        class="cr-slider"
        :value="elapsed"
        :max="Math.max(duration, 0.1)"
        :step="0.1"
        :disabled="duration === 0"
        :format-tooltip="(v: number) => formatClock(v)"
        @update:value="onSeek"
      />
      <span class="cr-clock">{{ formatClock(elapsed) }} / {{ formatClock(duration) }}</span>
      <!-- 存为运行书（P-20261005-3）：入口降级与章节列表同判定——无 OSC133 索引（裸 sh）即隐藏 -->
      <n-button
        v-if="chapters.length"
        size="tiny"
        quaternary
        :title="t('recording.saveAsRunbookHint')"
        @click="saveAsRunbook"
      >
        <n-icon size="13">
          <BookOutline />
        </n-icon>
        {{ t('recording.saveAsRunbook') }}
      </n-button>
      <n-tag
        v-if="live"
        size="small"
        type="warning"
        round
      >
        {{ t('recording.liveBadge') }}
      </n-tag>
      <n-button
        v-if="live"
        size="tiny"
        quaternary
        :title="t('recording.refresh')"
        @click="refresh"
      >
        <n-icon size="13">
          <RefreshOutline />
        </n-icon>
      </n-button>
    </div>

    <n-spin
      :show="loading"
      size="small"
    >
      <div class="cr-screen-wrap">
        <div
          ref="container"
          class="cr-screen"
        />
      </div>
    </n-spin>

    <div
      v-if="chapters.length"
      class="cr-chapters"
    >
      <div class="cr-chapters-title">
        {{ t('recording.chapters') }}
      </div>
      <div class="cr-chapter-list">
        <button
          v-for="(c, i) in chapters"
          :key="i"
          class="cr-chapter"
          :class="{ 'is-active': i === activeChapter }"
          :title="c.label"
          @click="onSeek(c.t); play()"
        >
          <span class="cr-chapter-time">{{ formatClock(c.t) }}</span>
          <span class="cr-chapter-label">{{ c.label }}</span>
          <span
            v-if="c.exitCode !== undefined"
            class="cr-chapter-exit"
            :class="{ 'is-fail': c.exitCode !== 0 }"
          >exit {{ c.exitCode }}</span>
        </button>
      </div>
    </div>
    <div
      v-else
      class="cr-no-chapters"
    >
      {{ t('recording.noChapters') }}
    </div>
  </div>
</template>

<style scoped>
.cr-root { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.cr-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cr-btns { display: flex; gap: 2px; }
.cr-slider { flex: 1; min-width: 120px; }
.cr-clock { font-size: 0.75em; color: var(--text-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.cr-screen-wrap { border: 1px solid var(--border-default); border-radius: 8px; overflow: auto; background: var(--bg-primary); }
.cr-screen { padding: 6px; }
.cr-chapters-title { font-size: 0.78em; color: var(--text-secondary); margin-bottom: 4px; }
.cr-chapter-list { display: flex; flex-direction: column; gap: 2px; max-height: 140px; overflow-y: auto; }
.cr-chapter {
  display: flex; align-items: center; gap: 8px; text-align: left;
  border: none; background: transparent; color: var(--text-primary);
  font-size: 0.78em; padding: 4px 6px; border-radius: 4px; cursor: pointer;
}
.cr-chapter:hover { background: var(--bg-hover, rgba(128, 128, 128, 0.15)); }
.cr-chapter.is-active { background: var(--bg-active, rgba(128, 128, 128, 0.25)); }
.cr-chapter-time { color: var(--text-muted); font-variant-numeric: tabular-nums; flex-shrink: 0; }
.cr-chapter-label { font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cr-chapter-exit { margin-left: auto; color: var(--text-muted); flex-shrink: 0; }
.cr-chapter-exit.is-fail { color: var(--danger, #e05561); }
.cr-no-chapters { font-size: 0.78em; color: var(--text-muted); }
</style>
