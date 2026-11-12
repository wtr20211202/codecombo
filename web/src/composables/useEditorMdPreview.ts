import { ref, computed, watch } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { useDebounceFn } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { useEditorMdMode } from './useEditorMdMode'
import type { EditorMdMode } from '../stores/uiState'
import { OPS_OPEN_FILE_AT, type OpenFileAtDetail } from '../utils/opsEvents'
import { resolveMdLinkTarget, resolveMdAnchorTarget } from '../views/editor/mdPreviewLinks'
import { jumpToMdAnchor } from '../views/editor/mdAnchorNav'
import '../utils/markedHeadingIds'

/**
 * Monaco Markdown 模式与预览管线（P-20261003-301 自 MonacoEditor.vue 原样搬运）：
 * source/preview/split 三态显示（本编辑器组实例私有），「上次使用的模式」偏好
 * 在 useEditorMdMode 模块单例（P-20261003-18）；预览 HTML 走 marked + DOMPurify
 * 防抖渲染（150ms 尾沿，GFM/任务列表，input 白名单）+ 预览链接导航分流
 * （P-20261003-108 移植主线增量；打印按钮在 MdModeBar 展示面，打印逻辑在 EditorMdPreviewPane）。
 * 路径与内容经 getter 读取实时 props。
 */

// heading id 生成（P-20261007-7 页内锚点二阶段的渲染侧）：marked 全局 renderer hook
// 收在 utils/markedHeadingIds 模块单点安装（文件头 import，与发布说明渲染链
// utils/changelogRender 共用，P-20261112-2-S1）

export interface EditorMdPreviewDeps {
  /** 当前文件路径（props.path 实时读取） */
  getPath: () => string
  /** 编辑器缓冲内容（props.modelValue 实时读取） */
  getModelValue: () => string
  /** 链接导航前置守卫：路径可折叠为项目相对路径（真实文件且非远程伪路径/未命名草稿） */
  canNavigate: () => boolean
  /** 当前项目 id（OPS_OPEN_FILE_AT 打开链的归属项目） */
  getProjectId: () => string
  /** i18n 直译函数（坏锚点 title 提示等用户可见文案；宿主 setup 传入） */
  t: ReturnType<typeof useI18n>['t']
}

export function useEditorMdPreview(deps: EditorMdPreviewDeps) {
  const { getPath, getModelValue, canNavigate, getProjectId, t } = deps

  // Markdown 模式：source / preview / split(默认，便于同时编辑与预览)。本 ref 是
  // 本编辑器组实例的显示态；跨刷新/跨文件「上次使用的模式」偏好在 useEditorMdMode
  // 模块单例（P-20261003-18），md 文件激活时从偏好恢复
  const mdMode = ref<EditorMdMode>('split')
  const mdPrefs = useEditorMdMode()

  const isMarkdown = computed(() => {
    const ext = getPath().split('.').pop()?.toLowerCase()
    return ext === 'md' || ext === 'markdown'
  })

  /** 用户动作切换（模式按钮 / Ctrl+Shift+M）：落显示态 + 偏好持久化闭环 */
  function changeMdMode(mode: EditorMdMode) {
    mdMode.value = mode
    mdPrefs.setMdMode(mode)
  }

  /** 打开/切到 md 文件恢复上次模式偏好（P-20261003-18）：无记录时 preferredMode
   *  保持 split 初值——原「每次切 md 强制重置 split」改为仅在无记录时生效 */
  function applyMdPreference() {
    if (!isMarkdown.value) return
    mdMode.value = mdPrefs.preferredMode.value
  }

  /** 快捷键入口（mdModeCycle 动作经布局键位链）：source→preview→split 循环；
   *  返回 false = 非 md 文件，布局链据此放行不拦截按键 */
  function cycleMdMode(): boolean {
    if (!isMarkdown.value) return false
    changeMdMode(mdPrefs.cycleMdMode(mdMode.value))
    return true
  }

  const renderedHtml = ref('')

  // 配置 marked：启用 GFM、换行、任务列表
  marked.setOptions({
    gfm: true,
    breaks: true,
  })

  const updateRenderedHtml = useDebounceFn((md: string) => {
    if (!md) { renderedHtml.value = ''; return }
    const raw = marked.parse(md, { async: false }) as string
    // 允许 input 元素以支持 GFM 任务列表。a/target 在允许面（P-20261003-108 复核）：
    // 落盘的 target 属性是惰性的——左键点击被预览容器委托 preventDefault 接管
    // （见 handlePreviewClick），只剩中键新标签语义（现代浏览器对 target=_blank
    // 隐式 noopener，无反向标签泄露面）
    renderedHtml.value = DOMPurify.sanitize(raw, {
      ADD_ATTR: ['target'],
      ADD_TAGS: ['input'],
    })
  }, 150)

  watch(getModelValue, (val) => {
    updateRenderedHtml(val || '')
  }, { immediate: true })

  /**
   * md 预览链接导航（P-20261003-108）+ 页内锚点跳转（P-20261007-7）：预览容器
   * click 委托（v-html 内容绑不了组件事件，只能容器层委托，EditorMdPreviewPane
   * 上抛）。分流：
   * - 相对 / 根相对 .md 链接 = 仓内文档导航——resolveMdLinkTarget 折叠为项目
   *   相对路径后派发 OPS_OPEN_FILE_AT 既有打开链（预览位打开，必要时先切项目），
   *   不新增事件；
   * - http(s) 外链 window.open 新标签（健壮性红线：必带 noopener）；
   * - 页内 #anchor = 预览内导航——resolveMdAnchorTarget 折叠为 fragment 后
   *   jumpToMdAnchor 按渲染侧同源 slug 的 id 精确匹配：命中平滑滚动 + 呼吸
   *   高亮，#top 无同名元素回滚容器顶，坏锚点不炸只 title 提示（诚实边界）。
   *   锚点是纯预览内导航不依赖项目根（远程伪路径/未命名草稿同样可跳），故置于
   *   canNavigate 守卫之前；
   * - 其余（mailto: 等）preventDefault 后忽略——preventDefault 根治「死链点击
   *   把 SPA 整页跳走」的原始问题。
   * 远程伪路径 / 未命名草稿无项目根可折叠，文件链接保持死链不导航（canNavigate 守卫）。
   */
  function handlePreviewClick(e: MouseEvent) {
    const anchor = (e.target as HTMLElement | null)?.closest?.('a')
    if (!anchor) return
    e.preventDefault()
    const href = anchor.getAttribute('href') || ''
    if (/^https?:\/\//i.test(href)) {
      window.open(href, '_blank', 'noopener,noreferrer')
      return
    }
    const frag = resolveMdAnchorTarget(href)
    if (frag !== null) {
      const contentRoot = anchor.closest('.md-preview-content')
      if (contentRoot) {
        jumpToMdAnchor(contentRoot, frag, anchor, t('editor.mdAnchorMiss', { anchor: frag }))
      }
      return
    }
    if (!canNavigate()) return
    const projectId = getProjectId()
    if (!projectId) return
    const target = resolveMdLinkTarget(getPath(), href)
    if (!target) return
    window.dispatchEvent(new CustomEvent<OpenFileAtDetail>(OPS_OPEN_FILE_AT, {
      detail: { path: target, projectId },
    }))
  }

  /** md 模式偏好惰性加载完成后一致化（P-20261003-18，首挂即 md 文件的恢复入口；
   *  uiState 异步——加载完成前以 split 默认先显示，书签装饰同款时序。此后切文件
   *  由 path watcher 同步恢复，ensureLoaded 幂等不再重复拉取） */
  function ensureLoadedThenApply() {
    void mdPrefs.ensureLoaded().then(() => applyMdPreference())
  }

  return {
    mdMode,
    isMarkdown,
    renderedHtml,
    changeMdMode,
    applyMdPreference,
    cycleMdMode,
    handlePreviewClick,
    ensureLoadedThenApply,
  }
}
