import { createRouter, createWebHistory, createMemoryHistory } from 'vue-router'
import { projectFilesAliasRedirect } from '../utils/presentAtoms'

const router = createRouter({
  // 环境守卫：playwright 装载器下 import.meta.env 未定义（spec 经 store 传递
  // 引入本模块时收集期即炸，P-20261007-15 路由桥接事故）——'/' 与 Vite 缺省同值。
  // window 守卫（P-20261004-117）：P-07-15 只兜了 import.meta.env，而
  // createWebHistory 模块求值即读 window.location——stores/dnd 自 P-20261003-227
  // 起传递引入 notification→router，所有 import stores/dnd 取落盘键常量的 spec
  // 收集期同款全毁。Node 装载语境（typeof window === 'undefined'）改建 memory
  // history 让模块图可加载（spec 只取常量不触路由）；浏览器运行时恒有 window，
  // web history 语义零变化
  history:
    typeof window === 'undefined'
      ? createMemoryHistory(import.meta.env?.BASE_URL ?? '/')
      : createWebHistory(import.meta.env?.BASE_URL ?? '/'),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('../views/home/HomeView.vue'),
    },
    {
      path: '/project',
      // 懒加载：Layout 及其依赖（Monaco Editor 等）仅在首次访问项目时加载
      // 避免首屏加载 5MB Monaco 核心到主 bundle，防止 JS tokenizer 被 Vue 响应式副作用触发
      component: () => import('../views/Layout.vue'),
      children: [
        {
          path: '',
          name: 'project',
          component: { render: () => null },
        },
      ],
    },
    {
      // 防御性路由别名（P-20261022-3，只读重定向幂等安全）：agent 编造的
      // 「自然但不存在的形态」/project/<id>/files?path=<相对路径> 收口为正确
      // 文件深链 /project?file=<path>&project=<id>（line/col 透传）——下次
      // agent 再编也落进正确深链而非 404。仅此一条，不做泛化别名面
      // （防别名面膨胀）；query 换算收口 utils/presentAtoms.projectFilesAliasRedirect
      path: '/project/:id/files',
      redirect: (to) => projectFilesAliasRedirect(to.params as Record<string, string>, to.query as Record<string, unknown>),
    },
    // 远程控制台不再是独立路由：内嵌为项目页主区视图（ActivityBar/TopBar/首页/设置
    // 多入口进入，?view=remote 携参；左侧工具栏保留，随时可切回 IDE 主视图）
    {
      // 值班大屏：独立于 Layout 的全屏卡片墙（无侧栏/顶栏），为第二块显示器/
      // 平板设计的机群监控页；锁定由 App 层 LockScreenOverlay 覆盖（RouterView
      // 之外），卡片数据走既有 /api 鉴权，无需额外路由守卫
      path: '/monitor',
      name: 'monitor',
      component: () => import('../views/monitor/MonitorView.vue'),
    },
  ],
})

export default router
