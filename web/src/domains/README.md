# 前端领域目录约定（roadmap M3.2）

> 新代码强制按本约定组织；存量代码「触碰即迁」——改到哪个文件就把哪个文件
> 归位，不搞一次性大搬家。

## 目录规则

新功能按「全栈垂直领域」组织，前端侧目录结构：

```
src/domains/<domain>/
├── views/        # 领域页面/主区视图
├── components/   # 领域组件
└── stores/       # 领域 Pinia store（可选，跨领域共享的仍放 src/stores/）
```

- `domain` 命名与后端 kernel.Module 名对齐（见 docs/EXTENSION_POINTS.md），
  如 `search`、`notifications`、`ai`、`git`——前后端领域一一对应，插件化时
  一个领域目录 + 一个后端模块即一个未来插件。
- 领域组件只允许被：同领域、`components/layout/`（装配宿主）、
  `App.vue`（全局挂载）引用。领域之间不横向 import 组件，跨领域复用下沉
  `components/common/`。

## 现状（迁移进度）

组件层已按领域归拢到 `src/components/<domain>/`（M3.3 完成）：

| 目录 | 领域 |
|---|---|
| `components/common/` | 跨领域基础件（AppLogo/ToolButton/Breadcrumb） |
| `components/search/` | 快速导航与搜索覆盖层（CommandPalette/ProjectSearch/OutlinePopover） |
| `components/notifications/` | 通知中心 |
| `components/settings/` | 设置（SettingsModal + 各分区） |
| `components/ai/` | AI 助手与智能操作通道 |
| `components/console/` | 控制台与任务运行器 |
| `components/git/` | Git 面板子组件 |
| `components/home/` | 首页 |
| `components/editor/` | 编辑器领域（欢迎页等） |
| `components/lock/` | 全局锁定 |
| `components/layout/` | 装配宿主（ActivityBar/TopBar/EditorArea/BottomPanel/StatusBar/GlobalOverlays） |

新建 `src/domains/<domain>/` 的时机：该领域第一次需要同时新增 views + stores
（纯组件增量直接进 `components/<domain>/` 即可，不为建目录而建目录）。

## 面板挂载

主区/侧栏/底部的可切换面板一律走 `src/panels/registry.ts` 注册表
（单一入口，e2e 守护见 `e2e/specs/panel-registry.spec.ts`），
禁止在 ActivityBar/BottomPanel 手写面板装配。
