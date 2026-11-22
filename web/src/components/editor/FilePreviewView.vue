<script setup lang="ts">
// 统一预览视图（P-20261119-4 S3）：tab「原文件 | 预览」双态的预览半边。
// 渲染分支按服务端 file-preview 注册表 kind 分流（pvKind）：
//   markdown → 前端 marked+DOMPurify 单一管线（utils/mdRender，必改2a——
//              与编辑器侧栏实时预览同源，后端 md 渲染零新增）；
//   text     → 只读文本态（代码族统一双视图的预览半边，GitHub 惯例）；
//   html     → htmlview 沙箱 iframe（默认零脚本；显式 opt-in「运行脚本
//              （隔离）」两层同步只加 allow-scripts，绝不 allow-same-origin
//              ——父页登录态使 same-origin 泄露面比分享访客更敏感，
//              PreviewPanel SANDBOX_TOKEN 先例同构硬红线）；
//   csv/sheet/docx → S2 服务端净化 payload（懒加载：本组件只在预览态挂载，
//              大 docx/xlsx 首屏成本顺延到切预览那一刻）；
//   pdf      → raw 同源 iframe（浏览器原生查看器承接 Range/拖动进度条）；
//   image/av → raw 直出（img/video/audio）。
// 组件级复用与 EditorMdPreviewPane 的关系：侧栏保留（编辑时实时预览），
// 本组件是整幅预览态，md 渲染经 mdRender 单点不漂移。
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NIcon } from 'naive-ui'
import { DownloadOutline, WarningOutline } from '@vicons/ionicons5'
import { useI18n } from '@/composables/useI18n'
import { confirmDialog } from '@/composables/useDialog'
import { renderMdPreviewHtml } from '@/utils/mdRender'
import { closeMdLightbox, openMdLightbox } from '@/utils/mdLightbox'
import { fileDownloadURL, fileHtmlViewURL, fileRawURL, filePreviewURL } from '@/utils/filePreviewURL'
import type { OpenFile } from '@/composables/useOpenFiles'

const props = defineProps<{
  file: OpenFile
  projectId: string
  /** 视图语言（渲染端点占位块文案，评审必改3c lang 参数化） */
  lang?: string
}>()

const { t } = useI18n()

const kind = computed(() => props.file.pvKind || '')

// ── md：前端管线整幅渲染（缓冲即真值，渲染零网络） ──
const mdHtml = computed(() => (kind.value === 'markdown' ? renderMdPreviewHtml(props.file.content) : ''))

// ── md 渲染面图片灯箱（P-20261120-3）：v-html 内容绑不了组件事件，容器层
// click 委托（useEditorMdPreview.handlePreviewClick 的 mdPreviewLinks 分流
// 邻位同构）。a 包裹图（[![alt](img)](link) 惯例）让链接语义优先不进灯箱；
// md 与服务端 payload 两个渲染面（同挂 md-preview-content）共用本委托 ──
function handleMdContentClick(e: MouseEvent) {
  const target = e.target as HTMLElement | null
  const img = target?.closest?.('img')
  if (img && !img.closest('a') && img.getAttribute('src')) {
    e.preventDefault()
    openMdLightbox(img.src)
  }
}

// 灯箱挂 body 不随本组件 v-if 摘除，预览关闭/切文件时主动收口
onBeforeUnmount(closeMdLightbox)

// ── 服务端 payload（csv/sheet/docx）：懒加载——组件挂载即拉一次（本组件
// 只在预览态渲染，切到预览才付首屏成本）；同一文件只拉一次，切走再切回
// 不重复请求。失败/超限回落信息卡+下载（与分享侧错误卡同语义） ──
const payloadHtml = ref('')
const payloadState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
let loadedFor = ''

async function loadPayload() {
  if (!props.projectId || payloadState.value === 'loading') return
  if (loadedFor === props.file.path && payloadState.value === 'ready') return
  payloadState.value = 'loading'
  try {
    const res = await fetch(filePreviewURL(props.projectId, props.file.path) + `&lang=${props.lang || 'zh'}`)
    if (!res.ok) throw new Error(String(res.status))
    const body = await res.json() as { data?: { html?: string; previewError?: string } }
    payloadHtml.value = body.data?.html || ''
    payloadState.value = body.data?.previewError || !payloadHtml.value ? 'error' : 'ready'
    loadedFor = props.file.path
  } catch {
    payloadState.value = 'error'
  }
}

watch(
  () => [props.file.path, kind.value] as const,
  () => {
    if (kind.value === 'csv' || kind.value === 'sheet' || kind.value === 'docx') void loadPayload()
    else { payloadState.value = 'idle'; payloadHtml.value = ''; loadedFor = '' }
  },
  { immediate: true },
)

// 文件被改写（保存/外部变更重载）后 payload 过期：content 变更时失效缓存
watch(() => props.file.content, () => {
  if (payloadState.value === 'ready') { payloadState.value = 'idle'; loadedFor = '' }
})

// ── html 沙箱：默认零脚本；opt-in 两段确认（风险文案如实说明仍可发网络
// 请求），iframe attr 与响应 CSP 两层同步、绝不 allow-same-origin ──
const htmlScriptsOn = ref(false)
const htmlFrameURL = computed(() =>
  kind.value === 'html' ? fileHtmlViewURL(props.projectId, props.file.path, htmlScriptsOn.value) : '')
// sandbox attr：静态档空串（零能力）；脚本档只放开呈现类 token——与
// htmlview 响应 CSP（sandbox allow-scripts）取交集后即 allow-scripts 一档
const htmlSandboxAttr = computed(() => (htmlScriptsOn.value ? 'allow-scripts allow-fullscreen' : ''))

async function runHtmlScripts() {
  const ok = await confirmDialog({
    type: 'warning',
    title: t('editor.pvHtmlConfirmTitle'),
    content: t('editor.pvHtmlConfirmBody'),
  })
  if (ok) htmlScriptsOn.value = true
}

const rawURL = computed(() =>
  kind.value === 'pdf' || kind.value === 'image' || kind.value === 'video' || kind.value === 'audio'
    ? fileRawURL(props.projectId, props.file.path)
    : '')
const downloadURL = computed(() =>
  props.projectId ? fileDownloadURL(props.projectId, props.file.path) : '')

const needsPayload = computed(() => kind.value === 'csv' || kind.value === 'sheet' || kind.value === 'docx')
</script>

<template>
  <div
    class="file-preview-view"
    data-testid="file-preview-view"
  >
    <!-- markdown：整幅渲染（与侧栏实时预览同一管线产物）。v-html 内容经
         utils/mdRender marked+DOMPurify 净化（与编辑器侧栏同源，净化不可省）；
         vue/no-v-html 为 warn 级容忍（报点在属性行，禁注释压不住——EditorMdPreviewPane 同实况） -->
    <div
      v-if="kind === 'markdown'"
      class="fpv-md md-preview-content"
      @click="handleMdContentClick"
      v-html="mdHtml"
    />
    <!-- 只读文本态（代码族/纯文本的预览半边） -->
    <pre
      v-else-if="kind === 'text'"
      class="fpv-text"
    >{{ file.content }}</pre>
    <!-- html 沙箱 iframe + 两级 opt-in 与常驻风险提示 -->
    <template v-else-if="kind === 'html'">
      <div
        class="fpv-html-bar"
        data-testid="fpv-html-bar"
      >
        <span
          class="fpv-html-note"
          data-testid="fpv-html-note"
        >{{ htmlScriptsOn ? t('editor.pvHtmlScriptsOn') : t('editor.pvHtmlNote') }}</span>
        <button
          v-if="!htmlScriptsOn"
          class="fpv-html-btn"
          data-testid="fpv-html-run-scripts"
          @click="runHtmlScripts"
        >
          {{ t('editor.pvHtmlRunScripts') }}
        </button>
        <button
          v-else
          class="fpv-html-btn"
          data-testid="fpv-html-stop-scripts"
          @click="htmlScriptsOn = false"
        >
          {{ t('editor.pvHtmlStopScripts') }}
        </button>
      </div>
      <iframe
        class="fpv-frame"
        :src="htmlFrameURL"
        :sandbox="htmlSandboxAttr"
        :title="file.name"
      />
    </template>
    <!-- 服务端净化 payload（csv/sheet/docx）：懒加载 + 失败信息卡 -->
    <template v-else-if="needsPayload">
      <div
        v-if="payloadState === 'loading' || payloadState === 'idle'"
        class="fpv-loading"
      >
        {{ t('editor.pvLoading') }}
      </div>
      <div
        v-else-if="payloadState === 'error'"
        class="fpv-error"
        data-testid="fpv-error"
      >
        <n-icon
          size="30"
          class="fpv-error-icon"
        >
          <WarningOutline />
        </n-icon>
        <div class="fpv-error-text">
          {{ t('editor.pvFailed') }}
        </div>
        <a
          class="fpv-error-dl"
          data-testid="fpv-download"
          :href="downloadURL"
        >{{ t('editor.pvDownload') }}</a>
      </div>
      <!-- payload 为服务端净化产物（bluemonday/结构化转义），v-html 安全出口。
           eslint-disable-next-line 对 v-html 属性行不生效（vue/no-v-html 报点在
           属性行、注释只能贴元素行——仓内 BrandIcon/HelpCenter 同此实况，warn
           级容忍；净化来源见上注） -->
      <!-- 表格类（csv/sheet）解除 800px 阅读列宽上限——与分享访客页
           `.md-article.csv{max-width:none}` 同口径，宽屏下表格吃满内容区 -->
      <div
        v-else
        class="fpv-md md-preview-content"
        :class="{ 'fpv-payload-wide': kind === 'csv' || kind === 'sheet' }"
        data-testid="fpv-payload"
        @click="handleMdContentClick"
        v-html="payloadHtml"
      />
    </template>
    <!-- pdf：原生查看器 iframe（响应端 CSP sandbox 已禁脚本） -->
    <iframe
      v-else-if="kind === 'pdf'"
      class="fpv-frame"
      :src="rawURL"
      :title="file.name"
    />
    <!-- 图片 -->
    <div
      v-else-if="kind === 'image'"
      class="fpv-media-wrap"
    >
      <img
        class="fpv-img"
        :src="rawURL"
        :alt="file.name"
      >
    </div>
    <!-- 音视频（原生控件承接 seek） -->
    <div
      v-else-if="kind === 'video'"
      class="fpv-media-wrap"
    >
      <video
        class="fpv-video"
        :src="rawURL"
        controls
      />
    </div>
    <div
      v-else-if="kind === 'audio'"
      class="fpv-media-wrap"
    >
      <audio
        class="fpv-audio"
        :src="rawURL"
        controls
      />
    </div>
    <!-- 兜底：kind 缺席/未注册（不应到达——开关可见性已按 pvPreviewable 收口） -->
    <div
      v-else
      class="fpv-error"
    >
      <n-icon
        size="30"
        class="fpv-error-icon"
      >
        <DownloadOutline />
      </n-icon>
      <div class="fpv-error-text">
        {{ t('editor.pvFailed') }}
      </div>
      <a
        class="fpv-error-dl"
        :href="downloadURL"
      >{{ t('editor.pvDownload') }}</a>
    </div>
  </div>
</template>

<style scoped>
.file-preview-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: auto;
  background: var(--bg-primary);
}

/* md / 服务端净化 payload：复用 .md-preview-content 全局排版（与侧栏
 * 预览同一渲染面），容器层只管滚动与内衬 */
.fpv-md {
  padding: 20px 24px;
  overflow-wrap: break-word;
}

/* 表格类 payload（csv/sheet）解除阅读列宽上限：宽表在 1920 下不该只占
 * 800px 一条（分享访客页 .md-article.csv 同口径）；docx/md 维持阅读列宽 */
.fpv-payload-wide { max-width: none; }

.fpv-text {
  margin: 0;
  padding: 16px 20px;
  font-family: var(--font-mono);
  font-size: 0.92em;
  line-height: 1.6;
  color: var(--text-body);
  white-space: pre-wrap;
  word-break: break-word;
}

/* html/pdf iframe：全幅承托（htmlview 顶栏提示条占首行，iframe 吃余幅）。
 * 底色用主题变量而非 #fff：iframe 文档自带画布底色（浏览器默认白），
 * 元素底色只影响加载前的空白期——跟随主题避免暗色下白闪（主题适配红线） */
.fpv-frame {
  flex: 1;
  min-height: 0;
  width: 100%;
  border: 0;
  background: var(--bg-primary);
}

.fpv-html-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px 12px;
  border-bottom: 1px solid var(--border-default);
  background: color-mix(in srgb, var(--accent-orange) 8%, var(--bg-panel));
  font-size: var(--fs-tiny);
  color: var(--text-secondary);
  flex-shrink: 0;
}

.fpv-html-note {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fpv-html-btn {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
  color: var(--text-body);
  font-size: var(--fs-tiny);
  padding: 2px 10px;
  cursor: pointer;
  white-space: nowrap;
  transition: all var(--motion-base);
}

.fpv-html-btn:hover {
  border-color: var(--accent-orange);
  color: var(--accent-orange);
}

.fpv-loading {
  padding: 32px;
  color: var(--text-dim);
  font-size: 0.92em;
}

.fpv-error {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  color: var(--text-secondary);
  text-align: center;
}

.fpv-error-icon { color: var(--text-dim); }
.fpv-error-text { font-size: 0.9em; max-width: 420px; line-height: 1.6; }

.fpv-error-dl {
  color: var(--accent-blue);
  font-size: 0.9em;
  text-decoration: none;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: 4px 14px;
  transition: all var(--motion-base);
}

.fpv-error-dl:hover {
  border-color: var(--accent-blue);
}

.fpv-media-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  min-height: 0;
}

.fpv-img {
  max-width: 100%;
  max-height: 100%;
  /* height:auto 与 md-preview.css .md-preview-content img 同步补（P-20261120-3
   * 双处同修防 scoped 层漏网）：属性 width/height 在身的 img 元素被 height
   * 属性钉死高度时同形翻车 */
  height: auto;
  object-fit: contain;
}

.fpv-video {
  max-width: 100%;
  max-height: 100%;
}

.fpv-audio {
  width: min(480px, 100%);
}
</style>
