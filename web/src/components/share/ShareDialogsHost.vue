<script setup lang="ts">
// 分享族弹层宿主（P-20261108-1）：结果卡 ShareResultDialog / 文件分享创建
// ShareCreateDialog / 终端输出分享选项 ShareTermOptionsDialog / 文本片段
// ShareSnippetDialog 四件的全局唯一挂载点，App 层挂一份（RouterView 之外）。
//
// 为什么在 App 层而不是 Layout：四件都是 useShareDialog / useTermShareDialog /
// useSnippetShare 模块级单例状态的纯消费者——入口只把状态置 open，渲染全靠宿主。
// 而入口不只在项目页：首页 `/`（HomeView 的终端会话管理 overlay：会话行/终端
// 右键「直播分享」「分享输出快照」「分享选中文本」）与值班大屏 `/monitor`（录制浏览
// 「分享回放」）都不经 Layout——宿主只挂 Layout 时这些入口静默失效（状态已 open、
// 无人渲染，无报错无提示）。四件已审计无 Layout provide/inject 依赖
// （ShareResultDialog 用的 usePanelLayout 亦为模块级共享状态），故上提 App 层
// 一次覆盖全部路由；Layout 不再重复挂载——单例状态下双宿主 = 同屏两份弹层。
//
// 约束：须位于 NMessageProvider 内（各件 useMessage）；App 侧经 safeAsync 懒加载，
// 不进首屏入口 chunk（DiagnoseDialog 等全局弹窗同款）。inheritAttrs:false——App
// 透传的 @retry 只供加载失败卡（AsyncLoadError）用，本组件是多根片段不承接。
import ShareResultDialog from './ShareResultDialog.vue'
import ShareCreateDialog from './ShareCreateDialog.vue'
import ShareTermOptionsDialog from './ShareTermOptionsDialog.vue'
import ShareSnippetDialog from './ShareSnippetDialog.vue'

defineOptions({ inheritAttrs: false })
</script>

<template>
  <!-- 分享短链结果卡（任意入口创建成功后弹出） -->
  <ShareResultDialog />
  <!-- 分享创建弹层（文件分享模式选择 live/frozen，P-20261003-320） -->
  <ShareCreateDialog />
  <!-- 终端输出分享选项弹层（直播/输出快照：敏感值遮蔽 + 水印，P-20261106-9） -->
  <ShareTermOptionsDialog />
  <!-- 文本片段分享弹窗（终端右键/编辑器右键/命令面板三入口） -->
  <ShareSnippetDialog />
</template>
