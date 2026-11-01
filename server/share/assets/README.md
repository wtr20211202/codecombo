# 访客终端直播页内嵌资产（vendored）

来源（web/node_modules 同版本，MIT License，头注与官方仓库为准）：

| 文件 | 包 | 版本 |
| --- | --- | --- |
| `xterm.js` | `@xterm/xterm`（lib UMD 构建） | 6.0.0 |
| `xterm.css` | `@xterm/xterm`（css） | 6.0.0 |
| `addon-fit.js` | `@xterm/addon-fit`（lib UMD 构建） | 0.11.0 |

为何 vendor：分享子服务是独立端口的零外部依赖单文件页（CSP 锁死外部资源，
不能引 CDN），而 `web/node_modules` 不入 git（go:embed 需提交态文件）——
升级 web 侧 xterm 版本时同步覆盖此目录三件并回归访客直播页。

许可：MIT（https://github.com/xtermjs/xterm.js）。
