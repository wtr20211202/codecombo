# Linux 部署指南（systemd + SELinux）

面向无头 Linux 服务器（RHEL/CentOS/Fedora、Debian 系同样适用）的 Codecombo
部署与升级（P-20261025-1 起运行时标识统一为 codecombo；远程部署子系统装的
是家目录布局 + `codecombo.service`，本篇是 /var/lib 手工布局的等价指南）。重点覆盖三类高频踩坑：首启设密来源限制、数据目录权限、SELinux。

## 1. 构建

```bash
# 在开发机（或服务器）上，仓库根目录
./build.sh          # 产出当前平台二进制 + .sha256/.sig 校验伴随资产
```

Linux 服务器部署取 `dist/` 下 linux-amd64 产物（或在服务器上直接
`./build.sh`，需 Go ≥ 1.25）。

## 2. 安装布局（推荐）

```
/var/lib/codecombo/              # 数据目录（CC_DATA_DIR；显式外部路径不走自动迁移），服务数据的规范去处
/opt/codecombo/bin/              # 二进制
/etc/systemd/system/codecombo.service
```

**二进制不要放家目录**（如 `/home/cld/bin/`），两个原因：

1. SELinux：家目录中的可执行文件没有服务域转换规则，进程落在受限的
   `init_t` 域——不仅写家目录被拒（§5），连自身行为都会被收紧；
2. systemd 沙箱：`ProtectHome=true/read-only` 与家目录里的二进制互斥，
   加固选项直接失效。

`/opt/codecombo` 整个目录属主给服务用户（上面 chown 已覆盖）：应用内置
自更新会**原地替换二进制**，bin 目录必须可写，否则更新报 permission denied。

为什么数据目录不放进用户家目录：手写 systemd 服务从受限上下文启动时，
SELinux 默认拒绝服务进程写 `/home`（保护家目录的策略，非 bug）；`/var/lib`
是服务数据规范位置，不受影响。若坚持放家目录，见 §5 方案 B。

## 3. systemd unit 模板

```ini
# /etc/systemd/system/codecombo.service
[Unit]
Description=Codecombo - Lightweight Coding Platform
After=network-online.target
Wants=network-online.target

[Service]
User=cld
Group=cld
ExecStart=/opt/codecombo/bin/codecombo --serve --port=9999 --host 0.0.0.0
Environment=CC_DATA_DIR=/var/lib/codecombo
Restart=on-failure
RestartSec=3
# 沙箱加固（数据目录在 /var/lib 时与 SELinux/ProtectSystem 无冲突）
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/codecombo
# PrivateTmp 必须关闭：tmux 持久化终端的 socket 落在 /tmp/tmux-<uid>/，
# 私有 tmp 命名空间下服务重启后看不到旧 socket，终端会话恢复必空
PrivateTmp=false
# KillMode=process 只杀主进程：脱管的 tmux server（含其中的智能体进程）
# 随服务重启存活，重启后终端可重新 attach；默认 control-group 会整组清扫，
# "终端会话重启存活"即失效。注意： systemctl stop 不会再杀 tmux 子进程，
# 需彻底清理时执行 tmux -L codecombo kill-server（旧部署是 tmux -L simple-coding）
KillMode=process

[Install]
WantedBy=multi-user.target
```

```bash
sudo mkdir -p /var/lib/codecombo /opt/codecombo/bin
sudo cp dist/codecombo-linux-amd64 /opt/codecombo/bin/codecombo
sudo chown -R cld:cld /var/lib/codecombo /opt/codecombo
sudo systemctl daemon-reload && sudo systemctl enable --now codecombo
```

## 4. 首次设密

- 绑定 `127.0.0.1`：只能从服务器本机设密（安全默认）；
- 绑定 `0.0.0.0`：允许局域网任意机器经 IP 设密（无头部署的常规路径），
  局域网设密与解锁共用同源限流，服务端打显著审计日志；
- 服务默认启用 TLS（见 §4.1）后，本机 curl 走**明文回环辅助端口**（主端口+1，
  仅绑 127.0.0.1）最简单：
  `curl -X POST http://127.0.0.1:10000/api/lock/setup -H 'Content-Type: application/json' -d '{"password":"..."}'`
  （也可 `curl -sk https://127.0.0.1:9999/...` 直连主端口）

## 4.1 TLS（HTTPS / WSS，默认启用）

**默认启用**（配置未显式关闭即开）：服务统一经 HTTPS/WSS 提供服务（**同端口**，
地址栏 `https://host:9999`，所有 WS 连接自动升级 wss，前端零改动）。
证书未配置时自动生成自签证书；首次启动即生效。

```bash
# 显式控制（可选；默认即开）
./codecombo start --tls          # 强制启用（自签自动生成）
./codecombo start --no-tls       # 显式关闭（回退明文 HTTP）
CC_TLS=0 ./codecombo --serve     # 环境变量关闭（e2e/本地调试用；SC_TLS 旧名兼容双读）

# 指定 CA 签发的证书
./codecombo start --tls-cert /etc/codecombo/tls.crt --tls-key /etc/codecombo/tls.key

# 设置页 → 安全 → TLS 子页，切换后重启服务
```

自签证书行为：落在数据目录 `certs/`（ECDSA P-256，10 年有效期，
SAN 覆盖 localhost / 127.0.0.1 / ::1 / 本机网卡 IP / 主机名），重启复用不变；
启动日志输出 SHA-256 指纹，客户端可据此核对（TOFU）。让浏览器免提示的
根治方式是把 `certs/cert.pem` 装入客户端系统信任库：

```bash
# Linux 客户端
sudo cp certs/cert.pem /usr/local/share/ca-certificates/codecombo.crt
sudo update-ca-certificates
# Windows 客户端：certmgr → 受信任的根证书颁发机构 → 导入 cert.pem
```

启用期间的配套行为：

- **明文回环辅助端口**（默认主端口+1，仅绑 127.0.0.1）：AI 助手 Agent 回调
  （CC_BASE_URL 自动指向它）与本机 CLI（stop/restart/status 走 PID 文件第三行）
  继续使用明文 HTTP——自签证书下 curl/fetch 默认拒绝握手，该端口让本机工作流
  零改动，局域网侧无明文暴露；
- **远程实例互联（默认 TLS 下的约定）**：两台都保持默认 TLS 时，实例地址
  直接填 `https://host:port`，**裸 `host:port` 自动按 https 处理**。
  "测试连接"/健康检查带**协议自动发现**：存量 `http://` 地址在对端升级 TLS 后
  会在探测时自动发现并**迁移落盘**（日志留痕），代理/WS 链路随之自愈；
  反向（https 打明文对端）同样自动回退。
  中心实例 TLS、对端显式关闭（`--no-tls`）的混合部署：地址显式写
  `http://host:port`，探测同样自动发现。
  实例间证书校验见 §4.2（默认 TOFU 指纹校验，自签直达免信任库导入）。
- **更新通道**：更新源强制 https 且拒绝指向本机/内网/保留地址（SSRF 防护），
  保存设置时即校验；
- systemd 部署：把 TLS 相关环境/参数写入 unit 的 ExecStart
  （`ExecStart=/opt/codecombo/bin/codecombo --serve --tls ...`）。

## 4.2 实例互联 TLS 证书校验（默认 TOFU 指纹，可选强校验）

实例间的 HTTPS 连接（实例探测/代理/WS 代理/从中心更新）默认使用
**TOFU 指纹校验**（Trust On First Use，SSH known_hosts 同款语义）：

- **首次连接**：自动记录对端自签证书的 SHA-256 指纹（存于本机数据目录
  `peer-certs.json`），**无需导入任何证书到信任库**——添加实例、从中心
  更新、代理管理开箱即用；
- **后续连接**：指纹一致即放行；对端证书**变更即拒**（提示指纹不匹配），
  保留对中间人攻击的防护——这是与"直接跳过校验"的本质区别；
- **重新信任对端**：对端重装/重签证书后，删除本机数据目录下的
  `peer-certs.json` 即可全部重新信任（下次连接重新 TOFU）。

该模式即刻生效、无需重启（策略在每次 TLS 握手时实时读取）。

### 开启强校验（系统信任库模式）

设置 → 安全 → 「实例间 TLS 强校验」开关（默认关闭）。开启后实例间连接
改走**系统信任库严格校验**（信任链 + 主机名/IP 匹配），此时需完成标准的
证书信任导入——保存**即时生效**，无需重启服务：

```bash
# Linux（Debian/Ubuntu 系）
sudo cp <对端数据目录>/certs/cert.pem /usr/local/share/ca-certificates/codecombo.crt
sudo update-ca-certificates

# Linux（RHEL/openEuler 系；两套命令按发行版二选一）
sudo cp <对端数据目录>/certs/cert.pem /etc/pki/ca-trust/source/anchors/codecombo.crt
sudo update-ca-trust extract

# Windows（管理员 PowerShell）
Import-Certificate -FilePath .\cert.pem -CertStoreLocation Cert:\LocalMachine\Root
```

注意事项：

- 导入后需**重启本机的 codecombo 服务**（Go 进程缓存系统信任池）；
- 组网时**双向互信**：A 探测/代理/拉取 B，就需要 A 信任 B 的证书；反向
  亦然。建议两台机器互装对方 `certs/cert.pem`；
- 对端**重签自签证书**（删 `certs/` 重启重新生成）后，需重新分发导入；
- 对端证书 SAN 已覆盖 localhost / 主机名 / 127.0.0.1 / 本机全部网卡 IP，
  用主机名或网卡 IP 访问均可通过主机名校验；
- 公网更新源（GitHub release）下载不受此开关影响，始终严格校验。

## 5. SELinux

**远程部署（推荐路径）已自动处理**：systemd 方式部署时，若目标机 SELinux 为
Enforcing 且检测到针对本服务的拒绝记录，部署流程会**自动生成并安装 audit2allow
白名单模块**（`codecombo-autowhitelist`，仅放行本服务被拒的操作），SELinux
保持 Enforcing 不变；目标机缺少 audit2allow 工具时回退为 Permissive 兜底。
全过程在部署日志中告知（检测到什么、装了什么、如何恢复 Enforcing）。
「直接进程」运行方式无需任何处理（用户域运行，家目录可写）。

手动部署 / 手动排查时的原理与做法如下。

症状：服务日志出现 `permission denied`（写日志/写 lock config），属主与权限
位都正确，`sudo -u <user> touch <数据目录>/test` 也失败。

一锤定音：`sudo setenforce 0` 后重启服务即恢复 → 确认是 SELinux。
**`setenforce 0` 重启即失效且全机裸奔，只用于验证，不要留在生产。**

### 5.1 为什么「属主是 cld 也被拒」——两层权限模型

Linux 的写权限要同时过两道独立的关卡：

1. **传统属主/权限位（DAC）**——`ls -ld` 看到的那层。属主是 cld → 这一关通过；
2. **SELinux 强制访问控制（MAC）**——即使第一关通过，还要看「**进程所在的安全域**
   能否写**文件的类型标签**」。`ls -lZ` 看文件标签，`ps -eZ | grep codecombo`
   看进程域。

踩坑组合：二进制放在家目录（`/home/cld/bin/codecombo`）时，RHEL 系策略
没有为它定义服务域转换，进程落在受限的 `init_t` 域；而家目录文件是
`user_home_t` 标签。**基础策略明确禁止 init_t 写 user_home_t**——这是保护
用户数据不被系统服务篡改的核心规则。所以：`chown` 修的 DAC 层完全正确，
但 MAC 层照样拒绝；`sudo -u cld touch` 走的是普通用户域，反而能成功——
两种现象看似矛盾，其实是两道关卡在分别起作用。

### 5.2 两个根治方案怎么选

- **方案 B（audit2allow 白名单）——数据目录留在家目录时用**：
  `audit2allow` 从审计日志生成一个**只包含「允许当前服务域写这个家目录标签」**
  的最小策略模块。安装后 `setenforce 1` 恢复全机防护。适合你的诉求：
  数据目录留在 `/home/cld/.codecombo`（P-20261025-1 起默认数据目录；旧 `.simple-coding` 由首启自动迁移改名），备份/迁移习惯不变。
  代价：多一个需要自己维护的自定义策略模块（升级系统后一般仍有效）。
- **方案 A（数据目录挪 `/var/lib/codecombo`）——想要零自定义策略时用**：
  `/var/lib` 下的 `var_lib_t` 标签是系统服务数据的标准位置，基础策略天然
  允许服务域写入，**不需要任何自定义模块**，SELinux 保持 Enforcing。
  代价：数据目录位置变了（备份/迁移改用新路径，`cp -a` 后 `restorecon -Rv`
  修正标签即可）。

两个方案安全性等价（都保持 Enforcing），区别只是「自定义一条白名单」还是
「换目录」。**数据目录留在 `.codecombo` 完全合法，用方案 B 即可。**

验证命令：
```bash
ausearch -m avc -ts recent | grep codecombo   # 看被拒记录
ls -lZ /home/cld/.codecombo                    # 文件标签
ps -eZ | grep codecombo                        # 进程域
```

### 5.3 常见疑问：为什么 Claude Code 写家目录没事？

因为**能不能写家目录取决于进程的 SELinux 域，与程序本身和目录属主无关**：

| | 交互式 shell 里跑的 claude | systemd 拉起的 codecombo |
| --- | --- | --- |
| 启动方式 | 用户 SSH/shell 会话内敲命令 | 开机由 systemd 拉起 |
| 进程域 | `unconfined_t`（targeted 策略默认放开登录用户） | `init_t`（无专属策略的服务继承 systemd 域） |
| 写家目录 | ✅ 用户会话写自己家目录，策略放行 | ❌ 服务域写 `user_home_t` 被拒 |

targeted 策略的设计哲学就是「放开登录用户、看住后台服务」。同一个 codecombo，
**手动在服务器上敲命令跑就能写、挂到 systemd 就被拒**——这是域差异的典型指纹
（claude 若也被塞进 systemd unit 跑，会撞上同一堵墙）。解法即上文方案 A/B。

这条规则适用于**一切程序**（dsh、node、python 皆然）：交互式会话里跑 → 用户域 →
家目录可写；systemd 拉起 → 服务域 → 家目录被拒。因此把二进制从家目录挪到
`/usr/local/bin` 只解决「执行」与沙箱冲突，**不改变数据目录（仍在家目录）的
写入判定**——部署流程里的 SELinux 自动放宽（§4）就是为此存在的，请勿移除。

### 5.4 凭据静态加密的边界（如实告知）

凭据（SSH 私钥 / API Token 等）使用 AES-256-GCM 加密存储，但解密用的
master-key（32 字节随机数，0600）与密文**同存于本机数据目录**
（`<数据目录>/data/master-key`）——"复制整个 data 目录即可解密"是刻意的
可移植性设计。

这层加密**防得住**：密文单独泄露（备份外泄、密文被误贴工单/聊天、
`sshkeys/` 目录被单独 scp 走）、顺手 `cat`/`grep` 看到明文。

**防不住**：任何以服务用户身份运行的进程（包括一个恶意 npm/pip 的
postinstall 脚本——它能同时读 master-key 与密文）、root、任何能读整个
数据目录的本地用户。暴露面与**明文 `~/.ssh/id_ed25519` 完全等价**——
codecombo 没有让事情变坏，但也没有变好。

一句话：它防的是"意外泄露"，不是"本机攻击者"。若威胁模型包含后者，
请依赖系统级的进程隔离与审计手段；将主密钥改为口令派生或接入 OS keyring
属于产品级取舍（与无人值守自动重启/更新冲突），暂未实现。

## 6. 升级

```bash
sudo systemctl stop codecombo
sudo cp dist/codecombo-linux-amd64 /opt/codecombo/bin/codecombo
sudo systemctl start codecombo
# 数据目录不动；运行中替换二进制会 Text file busy，必须先停
```

## 6.1 macOS 部署（launchd）

macOS 没有 SELinux（家目录写入不受限），布局沿用同一思路：
二进制放系统位置、数据目录默认即可。

```
/usr/local/codecombo/bin/codecombo   # 二进制
~/Library/Application Support/codecombo/ # 数据目录（CC_DATA_DIR ~/.codecombo 默认亦可；显式指定即不走自动迁移）
~/Library/LaunchAgents/com.codecombo.plist  # 当前用户服务
```

plist 模板（`launchctl load` 生效）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLML 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.codecombo</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/codecombo/bin/codecombo</string>
    <string>--serve</string><string>--port=9999</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

```bash
sudo mkdir -p /usr/local/codecombo/bin
sudo cp dist/codecombo-darwin-arm64 /usr/local/codecombo/bin/codecombo
sudo chown -R $(whoami) /usr/local/codecombo
launchctl load ~/Library/LaunchAgents/com.codecombo.plist
```

注意：Darwin 版本需在 mac 上构建（`./build.sh`）；升级同样先 `launchctl unload`
再替换二进制。

## 7. 故障速查

| 症状 | 含义 | 处置 |
| --- | --- | --- |
| 启动日志 `DATA DIR NOT WRITABLE` | 数据目录不可写（属主/沙箱/SELinux） | 按 §5 排查；新版本启动探针主动打出此条 |
| 设密 500 且提示 permission denied | 同上，setup 落盘失败 | 同上 |
| 设密 403 "only allowed from localhost" | 服务绑定 127.0.0.1，局域网来源被拒 | 改 `-H 0.0.0.0` 启动（有意开放局域网时） |
| 设密 429 | 同 IP 限流中 | 60s 后重试 |
| `Text file busy` | 运行中覆盖二进制 | 先 `systemctl stop` 再替换 |
| `systemctl status` 的 Memory 远大于 `free` 的 used | cgroup 记账含 page cache：tmux/claude 等子进程读写的工作区文件缓存都记在此 cgroup（§3 KillMode=process 下子进程留在组内），并非真实占用 | 正常现象；验证构成：`grep -E '^(anon\|file) ' /sys/fs/cgroup/system.slice/simple-coding.service/memory.stat`，anon=进程真实内存，file=可回收缓存 |

## 8. TLS 慢（深度检测网络）：明文伴随端口

上网行为管理/深度包检测类安全设备会对 TLS 流量做深度检测，表现为
https 首屏加载极慢（静态分包逐个排队、API 小包也要数秒）而 http 正常。
TLS 启用时系统**默认附带一个明文伴随端口**（主端口+3，如 9999 → 10002），
无需额外配置；config.json 可改道或关闭：

```json
{
  "server": {
    "host": "0.0.0.0",
    "httpPort": 8080
  }
}
```

- `httpPort` 三态：未配置 = 默认开启（主端口+3）；正数 = 指定端口；
  `0` = 显式关闭（只要 https 时配 0 即可）
- **该端口凭据明文传输**，仅建议在受信任内网 + 此类深度检测环境使用，
  日志会常驻一条 WARN 留痕
- 相关端口均可配置：`loopbackPort`（本机回环辅助口，默认主端口+1）、
  `sharePort`（文件分享子服务，默认主端口+2）；被网盘/VPN 类软件占用时
  各自改道即可，启动日志的 bind hint 会给出 netstat 定位命令
- 静态资源带内容哈希强缓存（`/assets/*` immutable）与 gzip，升级后
  index.html 以 no-cache 保证入口即时更新

## 9. 终端会话上限按内存调优

单进程终端会话上限默认 50；大内存服务器可放宽、小内存 NAS 可收紧，
config.json 配置（服务端资源项归 config 不进设置页）：

```json
{
  "server": {
    "terminalMaxSessions": 80
  }
}
```

- 未配置 = 默认 50（历史行为不变）；读取端边界：低于 10 收敛到 10（防误配），
  高于 200 截断到 200（软限）
- **内存代价自算**：每个会话固定占用 1.6~16MB 回放缓冲（随 scrollback 行数
  配置放大）+ 若干 goroutine——128G 服务器配 200 从容，16G NAS 建议 30 以内
- 改动需重启服务生效（启动期一次定值）；启动日志输出
  `terminal session limit resolved limit=N configured=M` 可核对生效值；
  超限创建会话时错误信息携带当前上限

## 10. 反向代理 / SSH 隧道与分享链接（P-20261020-2）

分享子服务仍监听独立端口（`sharePort`，默认主端口+2），但**默认分享链接已改为
主应用 origin + `/s/<token>`**：主引擎在锁/令牌中间件之前同源直通 `/s/*` 与
访客页三个 vendored 资产（`/assets/xterm.js`、`/assets/addon-fit.js`、
`/assets/xterm.css`）。因此反代/内置 SSH 反向隧道**只转发主端口**时，分享
链接也能正常打开，无需再暴露第二端口。

反代主端口的最小配置（SSE 直播需要关缓冲）：

```nginx
location / {
    proxy_pass http://127.0.0.1:9999;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;   # /s/<token>/stream（终端直播 SSE）逐帧直出
}
```

- **必须是「主应用入口 + /s/」或「专用分享域名 + /s/」**。只代理主端口时默认
  链接可用；若把分享链接指到**只暴露了主应用静态页、没有转发 /s/** 的入口，
  链接必然 404。
- 想让链接固定为某个专用分享域名：设置 · 通用「分享外发基址」
  （`settings.sharePublicBaseUrl`，或 config.json `server.sharePublicBaseUrl`）。
  该 origin 必须转发（或同源代理）`/s/*` 与上述三个资产路径；否则请改为
  让该域名直接反代 `sharePort`（此时分享服务自身也提供 `/s/*` 与 `/assets/*`，
  但**分享基址必须带 sharePort 端口**，例如 `https://share.example.com:10001`）。
- 未配置分享基址/外部访问地址、且以回环地址打开时，前端回退旧格式
  `http://<当前 host>:<sharePort>/s/<token>`——这种链接要求对端能直达
  `sharePort`（防火墙放行或额外反代）；给同事发链接前先配置分享外发基址，
  界面上的红色「仅本机可达」徽标即此形态的告警。
- **内置 SSH 反向隧道只转发主端口**：同源代理形态开箱可用；若仍要分发旧格式
  链接，需在隧道里额外转发 `sharePort`，否则链接只在服务器本机可达。
- 反代后请把代理来源 IP 填入设置 · 通用「可信代理」（`server.trustedProxies`，
  P-20261020-1），否则访客审计与口令限流只会看到代理 IP；该配置需重启生效。
  未配置时服务端不信任任何转发头（XFF 伪造无效）。
