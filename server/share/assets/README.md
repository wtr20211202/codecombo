# 访客终端页内嵌资产（vendored）

来源（web/node_modules 同版本，头注与官方仓库为准）：

| 文件 | 包 / 来源 | 版本 | 许可 |
| --- | --- | --- | --- |
| `xterm.js` | `@xterm/xterm`（lib UMD 构建） | 6.0.0 | MIT |
| `xterm.css` | `@xterm/xterm`（css） | 6.0.0 | MIT |
| `addon-fit.js` | `@xterm/addon-fit`（lib UMD 构建） | 0.11.0 | MIT |
| `addon-unicode11.js` | `@xterm/addon-unicode11`（lib UMD 构建） | 0.9.0 | MIT |
| `JetBrainsMono-Regular.woff2` / `JetBrainsMono-Bold.woff2` | `web/public/fonts/` 同一份字体文件（JetBrains Mono） | 同 web 侧 | SIL OFL 1.1（`LICENSE-JetBrainsMono.txt`） |

xterm 三个包同出 xterm.js 单仓同一提交（各 package.json 的 `commit` 字段一致），
升级时成组覆盖，不要单件混搭版本。

为何 vendor：分享子服务是独立端口的零外部依赖单文件页（CSP 锁死外部资源，
不能引 CDN），而 `web/node_modules` 不入 git（go:embed 需提交态文件）——
升级 web 侧 xterm 版本时同步覆盖此目录的 xterm 各件并回归三访客页
（直播/定格/回放）。

为何带字体与 unicode11（P-20261107-4 访客页渲染保真）：产品内终端缺省字体是
随前端分发的 JetBrains Mono、宽字符宽度表是 Unicode 11；访客页走系统字体与
xterm 缺省 v6 宽度表时，字宽与 CJK/emoji 列宽都和主机侧不一致，TUI 输出整行
错位。字体与产品同一份文件、按 OFL 保留原名分发，许可文本随目录携带。

许可：xterm 系 MIT（https://github.com/xtermjs/xterm.js）；JetBrains Mono 为
SIL OFL 1.1（https://github.com/JetBrains/JetBrainsMono，Reserved Font Name:
JetBrains Mono）。
