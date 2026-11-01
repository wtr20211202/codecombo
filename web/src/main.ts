import './assets/main.css'
import './styles/terminal-effects.css'
// md 预览打印 / 导出 PDF（P-20261003-244）：@media print 规则经 html.md-printing
// 标记类门控（打印按钮挂载），常态零生效
import './styles/md-print.css'
// 编辑器选区拖拽到 agent 侧栏（P-20261003-162）：拖影挂 body 无组件 scope，
// 落点高亮是跨组件全局类，样式集中在此
import './styles/selection-drag.css'
// 打包品牌字体（SIL OFL 1.1，可自由分发）：拉丁字形本地渲染保证跨机器一致，
// 中文回落系统字体栈（微软雅黑/苹方）。按需字重控制体积
import '@fontsource/geist-sans/400.css'
import '@fontsource/geist-sans/500.css'
import '@fontsource/geist-sans/600.css'
import '@fontsource/geist-sans/700.css'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
// Monaco 官方语言包注入已迁入懒加载链（EditorArea → ensureMonacoNls）：
// 语言包仅在打开编辑器前按需加载，首屏不再等待（历史为顶层 await 阻塞启动）

import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import i18n from './i18n'
import { applyThemeEarly } from './themes/early-init'
import { useErrorLogStore } from './stores/errorLog'
import { installClipboardHistoryCapture } from './stores/clipboardHistory'

// 在 mount 前同步应用主题 CSS 变量，避免首屏 var(--bg-primary) 缺失导致背景透明
applyThemeEarly()

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(i18n)
app.use(router)

// 多剪贴板历史（P-20261002-149）：全局 copy 事件捕获启动即装（幂等）——
// 原生 Ctrl/Cmd+C 不经任何组件，必须 document 级监听才能入史
installClipboardHistoryCapture()

// 渲染兜底①（P-20261002-26）：全局 errorHandler 入账错误中心（错误面板可见）。
// App.vue 的 onErrorCaptured 未达熔断阈值时放行到这里（渲染层错误 + 不经组件
// 链的 App 自身错误都落到此）；达阈值时被 App 层 return false 阻断并在该处
// 自行入账，两端不重复。Promise 异常不走此链（仍由 axios 拦截器体系处理）
app.config.errorHandler = (err, _instance, info) => {
  // 保留原生 console 输出：开发调试与 devtools 现场不丢
  console.error('[errorHandler]', err, info)
  useErrorLogStore(pinia).add({
    category: 'client',
    method: 'VUE',
    url: `vue:${info}`,
    status: 0,
    rawMessage: err instanceof Error ? err.message : String(err),
    userMessage: i18n.global.t('app.crash.logUserMessage'),
  })
}

// 触发 Vite 重新编译整个 module graph（fs.watch 在 Windows 下偶发失效）
app.mount('#app')
