# 设计令牌三轴（圆角 / 间距 / 字重）

> P-20261019-8 落地记录。令牌定义单一事实源 = `web/src/assets/main.css` 的 `:root`；
> 只读审计脚本 = `web/scripts/check-design-tokens.mjs`（`npm run check:design-tokens`）。

## 1. 令牌表

| 轴 | 令牌 | 值 | 用途 |
|---|---|---|---|
| 圆角 | `--radius-sm` | 4px | 小控件、徽标、输入内嵌块、图标按钮 |
| 圆角 | `--radius-md` | 6px | 常规按钮、菜单项、侧栏导航项 |
| 圆角 | `--radius-lg` | 10px | 卡片、浮层、弹窗、气泡 |
| 间距 | `--space-1` | 4px | 紧邻元素、图标与文字、行内微间隔 |
| 间距 | `--space-2` | 8px | 控件组、常规内容间隔 |
| 间距 | `--space-3` | 12px | 区块内边距、分组间距 |
| 间距 | `--space-4` | 16px | 区块外边距、弹窗内容内边距 |
| 字重 | `--fw-regular` | 400 | 正文（默认继承） |
| 字重 | `--fw-medium` | 500 | 次级强调、可交互选项 |
| 字重 | `--fw-semibold` | 600 | 标题、分区标签、关键状态 |

使用方式：`border-radius: var(--radius-md);`、`gap: var(--space-2);`、
`font-weight: var(--fw-semibold);`。不要在令牌外再定义同轴同义变量。

## 2. 首批落地域（P-20261019-8）

按提案「先高频面、不做全局大爆炸」执行，以下域已完成可令牌化值的替换
（`4/8/12/16px` 间距、`3/4/5/6/7/8/10/12px` 组件圆角按最近档收敛、
`400/500/600/700` 字重按三档收敛）：

- Git 面板：`web/src/views/git/`（含 `commit-panel.css`、`commits-panel.css`）
- Git 子组件：`web/src/components/git/`
- 设置面：`web/src/components/settings/`（含 `settings-modal.css`、`security-settings.css`）
- 活动栏 / 顶栏 / 状态栏：`ActivityBar.vue`、`TopBar.vue`、`StatusBar.vue`

其余域按批次渐进替换；审计脚本的高频面分组可量化剩余进度。

## 3. 例外与存量债务（诚实登记）

审计脚本把命中分为四类；只有 `off-scale` 是治理目标，`micro` / `shape` / `on-scale`
不计入 off-scale：

| 类别 | 例子 | 处置 |
|---|---|---|
| `shape` | `border-radius: 50%`（头像/状态点）、`999px`（胶囊）、`0` | 结构性豁免，不进刻度 |
| `micro` | 间距 `1/2/3px`、圆角 `1/2px` | 密集面板的刻意压缩与指示线；不判错，随面板改版逐批评估 |
| `on-scale` | 未令牌化的 `4/8/12/16px`、`400/500/600` | 应改为 `var(--space-*)` / `var(--fw-*)`；脚本统计其数量 |
| `off-scale` | 间距 `5/6/7/10/14/18/20/24px`、圆角 `3/5/7/8/12/13px`、字重 `700` | 渐进收敛目标，脚本输出清单 |

明确例外：

- **1~2px 圆角 / 指示线**：滚动条 thumb（`base.css` 4px 已入档）、拖拽插入线、
  分支图连线、热力条等，形状由线宽决定，令牌化无意义。
- **方向性圆角**（如 `border-radius: 0 2px 2px 0`）：局部方向语义，不拆成四角令牌。
- **13px 圆角**：顶栏搜索触发器（高 26px）与分支胶囊是「半高胶囊」；
  胶囊形态用 `999px` 亦可，但现有值与其渲染等价，保留字面量并在此登记。
- **12px 弹窗圆角**：按提案归入 `--radius-lg`（10px），不单列例外——设置弹窗
  `.settings-card` 已改为 `var(--radius-lg)`。
- **密集面板 6/10px 间距**：Git/设置高频面尚存大量 `6px`/`10px` 节奏（脚本可量化）。
  它们来自历史紧凑布局，直接改 4/8/12/16 会改变面板密度与换行行为，
  故按域分批验证，不在本提案一次性替换。
- **模板内联 `style="font-weight: ..."`**：与 `check-motion`/`check-hardcoded-colors`
  同口径，审计只覆盖 `<style>` 段与 `.css`；内联样式属动态/局部逻辑域，后续按域清理。
- **Monaco / xterm 内部样式**：第三方渲染层不消费本套 CSS 令牌。

## 4. 只读审计脚本

```bash
# 在 web/ 下
npm run check:design-tokens                    # 只读报告，退出码 0，不阻断构建
# 仓库根执行（等价直调）
node web/scripts/check-design-tokens.mjs --verbose # 逐条 file:line 明细
node web/scripts/check-design-tokens.mjs --strict  # 有 off-scale 时退出码 1（未来门禁转正）
node web/scripts/check-design-tokens.mjs --self-test
```

- 默认**不挂进** `npm run check` 链：存量 1675 处 off-scale（2026-10-20 基线）
  尚在渐进收敛，硬门禁会阻断所有提交。
- 令牌定义缺失或数值偏离预期（`main.css` 被改坏）时脚本退出 1——这是契约破坏，
  不是存量债务。
- 扫描面：`src/**/*.{vue,css}` 的 `<style>` 段与 `.css` 全文；CSS 注释忽略；
  `width/height/font-size/line-height` 等尺寸轴不混入。
- `--self-test` 锁定扫描器行为（on-scale / micro / off-scale / 注释 / 非目标属性），
  改动脚本后先跑它。

## 5. 验证面

- 单测 `web/src/__tests__/design-tokens.test.ts`：令牌定义数值 + 高频面代表文件
  必须引用三轴令牌（防回退字面量）。
- e2e `web/e2e/specs/design-tokens.spec.ts`：设置弹窗、Git 面板、顶栏、活动栏的
  计算样式等于令牌解析值（含 `font-weight` 与两档边界），并断言
  「高频面可令牌化 on-scale = 0」的源码契约由单测守护。
