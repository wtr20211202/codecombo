# Pages 发布指南（产品官网：landing + 文档分页族）

> 产品官网随发布拷贝包一起交付：源码在开发仓 `site/` 目录——landing
> （`site/index.html`）与文档分页族 `site/guide/`（P-20261112-10 首期
> getting-started + faq 两页，P-20261115-2-S1 起增 features 全模块指南页，
> 共享侧边导航+顶栏每页静态复制、双语 `data-lang-en/zh` 双份内联）。`bash scripts/release-export.sh` 导出时自动落到
> 发布仓 `docs/` 根——GitHub Pages **main/docs 模式**的站点根就是发布仓的
> `docs/` 目录，配置定死、不靠映射猜。

## 一次发布要做的事

1. **导出**：`bash scripts/release-export.sh`（缺省 `release/public/`；
   P-20261115-3 起导出前自动跑官网双门禁 check-site-styles/content，未过即
   FATAL 拦截，见下「样式防乱纪律」节）。导出树里会看到：
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
  npx serve .          # 仓库根，然后访问 /site/（分页族：/site/guide/getting-started.html、
                       # /site/guide/features.html 与 /site/guide/faq.html）
  ```
- **发布树态**（导出后 `release/public/docs/` 即 Pages 真实形态，guide 页落
  `docs/guide/`）：
  ```bash
  bash scripts/release-export.sh /tmp/pages-preview
  npx serve /tmp/pages-preview/docs   # 分页族：/guide/getting-started.html、/guide/features.html 与 /guide/faq.html
  ```

## 站点内文件约定

| 路径 | 说明 |
| --- | --- |
| `site/index.html` | landing 本体；双语内容双份内联（`data-lang-en/zh`），无 JS 显示英文 |
| `site/guide/` | 文档分页族（getting-started、features、faq，零框架静态多页）；共享侧边导航+顶栏为每页静态复制，双语同 landing 双份内联，独立 title/meta/og |
| `site/assets/site.css` / `site.js` | 样式与少量原生交互（语言切换、平台探测下载；site.css 含 guide-/doc-/faq- 前缀段）。样式取号走 site.css `:root` 四族 token（间距/圆角/字号/代码块，规则体不写新 px 字面值）；共享类增删改先过 site.css 文件头 **SHARED-CLASS REGISTRY** 登记表——shared 类任何改动须全站页走查、页内私有类不外溢（登记表为样式防乱门禁 `scripts/check-site-styles.sh` 程序化对账的事实源，机制见下「样式防乱纪律」节） |
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
导出不报警——features 页两行已按此登记（P-20261115-2-S3）。

## 样式防乱纪律（P-20261115-1-S4）

样式只有一个家：`site/assets/site.css`（`:root` token + 文件头 SHARED-CLASS
REGISTRY 登记表）。**任何 site/ 改动后、导出发布前必跑对账门禁**（agent 代改
官网同样以此作自检）：

```bash
bash scripts/check-site-styles.sh
```

**P-20261115-3 起导出脚本已自动执行本门禁与姊妹件内容门禁**：`release-export.sh`
在 DEST 清空前依次跑两门禁（合计 ~5.5s），任一未过即 FATAL 拦截导出——上面的
手动跑仍保留为改后即时自检，不必等导出才知红绿。近似边界如实注记：门禁查工作树
`site/`，而导出走 git archive 提交树——「已提交红+工作树绿」或 `--ref` 导旧节点
两态判的不是被导出的那棵树；主流程改→门禁→提交→导出下近似可接受，全保真需门禁
支持对导出树跑，属后续独立提案。

门禁三道对账（任一红 = 禁止合入/导出）：

1. **页内 `<style>` 重定义即红**：各页 `<style>` 块的类选择器 × site.css 类
   定义集（程序化提取，非手工清单）求交——页级覆盖会「改一页乱全站」。确属
   合法的页级微调，在脚本 `STYLE_WHITELIST` 开 `页路径:类名` 豁免行并附缘由
   （循 `scripts/duplicates-baseline.json` 渐进先例）；当前全站零 `<style>`，
   白名单为空。
2. **登记表解析契约**：块以含「SHARED-CLASS REGISTRY」的行起、「END
   SHARED-CLASS」行止——契约散文自身引用了标记串，脚本锚**最后一次** END
   行；登记项五字段（class|scope|pages|定义分区|说明）形态、scope 词汇、
   pages 字符集逐项校验，类名重复登记即红。
3. **三方对账**：登记表 × site.css 定义集 × 各页 HTML class 使用集——未登记
   类（CSS 或 HTML 侧）、有名无规则、hook 沾样式（site.css 或页内 `<style>`）、
   state 泄进静态 HTML、pages 字段与实际使用页不符（页内私有类外溢同条拦截）
   都红。页字母映射（L/G/F/E → 四页文件，E=features）钉在脚本 `page_letter()`。

**改样式的必过清单**（防「改 landing 乱 guide」，缺一不合入）：

1. 门禁脚本绿（上）；
2. 全站页走查：landing + getting-started + features + faq，zh/en 各一遍（shared 类改动按
   registry scope 语义取最高标准全站页全过）；
3. 移动端断点：960 / 760 / 640 / 390 逐档过一眼横向溢出（760=命令块注释折下
   与顶栏锚链接收起、640=GitHub 键收起，均 S2/S3 实锚），344px Fold 外屏级
   也过一眼；
4. 截图对比：改动前后 fullPage 截图留档比对（像素 diff 噪声过高时以计算样式
   等值对比替代，S3 先例）；
5. 导出 + 敏感扫描：`bash scripts/release-export.sh` 后 `bash
   scripts/release-scan.sh` 零放行（发布链见上「一次发布要做的事」）。

**新页联动（P-20261115-2 起）**：新页优先复用登记表 shared 组件类
（wrap/site-header/footer/cmd-lines 等），不复制粘贴重写；页内私有类统一
`guide-`/`doc-`/`faq-` 前缀、落 site.css「Docs 模块」段，**先登记后写规则**
（门禁 ③ 拦未登记类）；不私开平行样式体系——第二份 css、页内 `<style>`
重定义共享类都会被门禁拦红。新页还须在门禁脚本 `page_letter()` 登记页字母
映射，并同步 registry 契约散文与相关 shared 类 pages 字段。features 页
（P-20261115-2-S1）已按此联动落地：E=features 已登记、registry 扩四页口径，
零新类零新规则（实勘矩阵 docs/features-page-matrix.md）。

## 内容防断链纪律（P-20261115-2-S3）

双语承载与站内锚点也只有一个对账面：`scripts/check-site-content.sh`（姊妹于
样式门禁）。S1/S2 的人工「双语 121/121 + 锚点实存」静态审计由此程序化——
**任何 site/ 改动后、导出发布前必跑**（agent 代改官网同样以此作自检）：

```bash
bash scripts/check-site-content.sh
```

（P-20261115-3 起导出脚本已自动执行本门禁——手动跑仍保留为改后即时自检；
强制执行形态与「工作树门禁 × 提交树导出」近似边界见上「样式防乱纪律」节。）

门禁两道对账（任一红 = 禁止合入/导出）：

1. **双语 data-lang 配对**：各页 HTML 剥注释后按文档序提取 `data-lang-en` /
   `data-lang-zh` 裸属性标记（实形是「属性存在」形态，不是 `data-lang="en"`
   值形态——后者是 `<html>` 上的运行态切换目标、`data-lang-set` 是按钮态
   属性，两者不入配对面），序列须 en,zh 严格交替、两侧计数相等且 >0——
   「同 PR 双语同改」纪律（单语改动视为半成品）由此程序化；剥注释后仍出现
   未知 `data-lang-*` 兄弟标记也红。
2. **锚点解析**：各页 `id=` 集合 × href 引用对账——`href="#frag"` 的 frag
   必须在本页 id 集；`href="REL#frag"`（REL 剥 `?lang=` 查询串后为站内相对
   HTML 页）目标页必须存在且 frag 必须在目标页 id 集；无 frag 的站内 .html
   页级链接（顶导航/页尾/侧栏）目标页必须存在；页内重复 id 同红。外部
   http(s)/mailto 与非 .html 资产引用不在对账面——img 的源码态/发布树态两
   形态归导出正则改写衔接，一致性靠「一次发布要做的事」的导出树逐引用解析。

## 修改后要过的检查

1. `web/public` 图标（favicon.svg / icons/*）动过 → 跑
   `cd web && npx playwright test e2e/specs/pwa-manifest.spec.ts e2e/specs/title-info.spec.ts`
   （favicon 角标链与 manifest 消费同一资产）。
2. 站点文案改动 → 本地两种落位都过一眼（见上「本地预览」），EN/中文 各一遍；
   guide 页逐页确认侧边导航/顶栏/页脚链接一致（静态复制面易漂移）。
3. 下载按钮平台探测 → `assets/site.js` 的 OS 三路 + 移动端回落 Releases
   页（Chrome UA 不暴露 CPU 架构，保持 OS 维度 + 默认 amd64 + 下拉显式选 ARM）。
4. 任何 site/ 改动（样式/文案/结构）→ `bash scripts/check-site-styles.sh`
   样式防乱对账绿（机制见上「样式防乱纪律」节）；改到 site.css 时再过该节
   「改样式的必过清单」五件套。导出脚本已自动执行（P-20261115-3），此处手动跑
   仍保留为改后即时自检。
5. 任何 site/ 改动（文案/链接/结构）→ `bash scripts/check-site-content.sh`
   内容防断链对账绿（机制见上「内容防断链纪律」节；改 README Details 落点、
   换锚、增删页面时尤其必跑）。导出脚本已自动执行（P-20261115-3），此处手动跑
   仍保留为改后即时自检。
