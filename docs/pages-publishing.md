# Pages 发布指南（产品官网：landing + 文档分页族）

> 产品官网随发布拷贝包一起交付：源码在开发仓 `site/` 目录——landing
> （`site/index.html`）与文档分页族 `site/guide/`（P-20261112-10 首期
> getting-started + faq 两页，共享侧边导航+顶栏每页静态复制、双语
> `data-lang-en/zh` 双份内联）。`bash scripts/release-export.sh` 导出时自动落到
> 发布仓 `docs/` 根——GitHub Pages **main/docs 模式**的站点根就是发布仓的
> `docs/` 目录，配置定死、不靠映射猜。

## 一次发布要做的事

1. **导出**：`bash scripts/release-export.sh`（缺省 `release/public/`）。
   导出树里会看到：
   - `site/` —— 官网源码原样一份（发布仓内可审阅、可改；含 landing 与
     `site/guide/` 文档分页族）
   - `docs/index.html` + `docs/assets/` + `docs/guide/` —— site 内容的 Pages 落位
     （landing 的 `../docs/img/` 引用自动改写为 `img/`；guide 子目录页的
     `../../docs/img/` 经同一改写正则尾段命中产出 `../img/`——恰为 `docs/guide/`
     页的正确相对路径，2026-11-12 导出树逐引用解析实测零断链）
   - `docs/img/*.png` —— 截图（README 与官网共用的事实源，导出白名单自动带上）
2. **敏感扫描**：`bash scripts/release-scan.sh`（零放行，PNG 二进制自动跳过，
   但站点 HTML 文本必进扫描——扫描对导出树全文本面 grep，landing 与
   `site/guide/` 分页族 HTML 一视同仁无豁免；**站点文案改动后必须重跑**，
   guide 页双语两份内联文本同样算文案）。
3. **拷贝**：把 `release/public/` 整体拷入 GitHub 检出目录，提交并推送
   `main`（发布拷贝包纪律见 CLAUDE.md「发布拷贝包纪律」节）。

## 开启 Pages（只需一次）

GitHub 仓 → **Settings → Pages** → Source 选 **Deploy from a branch** →
Branch 选 **main**、目录选 **/docs** → Save。

- 站点地址：`https://<user>.github.io/<repo>/`（docs/index.html 即站点根）。
- 无需自定义 workflow、无需 Actions 配置——纯静态 main/docs 模式。

## 域名（可选，DNS 归用户）

自定义域名（如 `codecombo.dev`）：

1. DNS 侧加 CNAME 记录指向 `<user>.github.io`（apex 也可用 A/AAAA 记录，
   见 GitHub Docs「About custom domains」）。
2. 发布仓 `docs/CNAME` 文件写入域名（一行）并随拷贝包提交；或在 Settings →
   Pages → Custom domain 里填（效果等同，会生成同一文件）。
3. 勾选 Enforce HTTPS。
4. 启用自定义域名后，建议把 `site/index.html` 里 `og:image` 由相对路径改为
   绝对路径（`https://<域名>/assets/og-image.png`），部分抓取器对绝对 URL
   更稳；改源在 `site/`，重跑导出即可。

## 本地预览

- **源码态**（landing 引用 `../docs/img/`、guide 页引用 `../../docs/img/`，
  必须在仓库根起服务）：
  ```bash
  npx serve .          # 仓库根，然后访问 /site/（分页族：/site/guide/getting-started.html
                       # 与 /site/guide/faq.html）
  ```
- **发布树态**（导出后 `release/public/docs/` 即 Pages 真实形态，guide 页落
  `docs/guide/`）：
  ```bash
  bash scripts/release-export.sh /tmp/pages-preview
  npx serve /tmp/pages-preview/docs   # 分页族：/guide/getting-started.html 与 /guide/faq.html
  ```

## 站点内文件约定

| 路径 | 说明 |
| --- | --- |
| `site/index.html` | landing 本体；双语内容双份内联（`data-lang-en/zh`），无 JS 显示英文 |
| `site/guide/` | 文档分页族（getting-started、faq，零框架静态多页）；共享侧边导航+顶栏为每页静态复制，双语同 landing 双份内联，独立 title/meta/og |
| `site/assets/site.css` / `site.js` | 样式与少量原生交互（语言切换、平台探测下载；site.css 含 guide-/doc-/faq- 前缀段） |
| `site/assets/logo/` | 品牌图标（自动亮暗适配 + 显式亮/暗版 + tile + 横排 lockup） |
| `site/assets/og-image.svg` / `.png` | 社交分享卡设计源与栅格产物（1200×630） |
| `site/assets/fonts/` | Geist Sans woff2（SIL OFL 1.1）+ 许可文件 |
| `web/scripts/site-assets-gen.mjs` | SVG 设计源 → PNG/ICO 派生器（favicon/icons/og-image） |
| `web/scripts/site-screenshots.mjs` | 截图矩阵重摄脚本（docs/img 唯一事实源） |

改站点文案前先读 `site/index.html` 各内容块头注——**文案源 = README 对应小节，
改先改 README**（双维护纪律）。guide 分页族另守两条成文于各页页头注记的纪律：
**「同 PR 双语同改」**（单语改动视为半成品不许合入）与**侧边导航/顶栏为静态复制，
改导航须 guide/ 全页同 PR 同改**。新增 guide 页 = 新 HTML 落 `site/guide/` + 全族
侧边导航补项即可自动导出，并在 `release-export.sh` 骨架自检 must-list 补登记两行
（site 侧 + docs 侧，同 getting-started/faq 两行的登记形态），漏登记的页缺失时
导出不报警。

## 修改后要过的检查

1. `web/public` 图标（favicon.svg / icons/*）动过 → 跑
   `cd web && npx playwright test e2e/specs/pwa-manifest.spec.ts e2e/specs/title-info.spec.ts`
   （favicon 角标链与 manifest 消费同一资产）。
2. 站点文案改动 → 本地两种落位都过一眼（见上「本地预览」），EN/中文 各一遍；
   guide 页逐页确认侧边导航/顶栏/页脚链接一致（静态复制面易漂移）。
3. 下载按钮平台探测 → `assets/site.js` 的 OS 三路 + 移动端回落 Releases
   页（Chrome UA 不暴露 CPU 架构，保持 OS 维度 + 默认 amd64 + 下拉显式选 ARM）。
