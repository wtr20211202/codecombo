# 远程接入（SSH 反向隧道，自带 VPS 中继）

> P-20261019-11。把本实例经**用户自有的 VPS** 呈现在任意网络：实例主动连出
> VPS，请求 VPS 监听一个端口（SSH `tcpip-forward`），入站连接经隧道回到本机
> 主服务。不需要公网 IP、不需要路由器端口映射，天然穿透 CGNAT；中继掌握在
> 用户自己手里，产品零中继成本。

## 形态

- **多档案 + 单活 + 一键切换**：每套 VPS 配置是一个档案；同一时刻只有一条隧道
  在线。切换档案 = 停当前 → 起目标（秒级中断）。
- **自动重连**：在线后连接断开进入指数退避重连（1s→2s→…→30s），keepalive
  探测半开连接；首次建立失败不自动重试（避免错误凭据连续撞 sshd 触发
  fail2ban），修好后手动重试。
- **认证**：复用既有 SSH 密钥库（`sshkey`）或 VPS 登录密码（`password`，
  落盘 `enc:` 加密，读取面永不回传）。
- **主机密钥**：默认 TOFU 钉扎（与远程主机同表），变更拒绝并发通知；VPS
  重装/换钥后在「设置 · 远程接入」点「重置主机指纹」重新首录。

## VPS 侧配置

### 1. sshd 允许 TCP 转发

```sshconfig
# /etc/ssh/sshd_config
AllowTcpForwarding yes
```

公网直连形态（远端绑定 `0.0.0.0`）还必须允许客户端指定绑定地址：

```sshconfig
GatewayPorts clientspecified
```

改完 reload：

```bash
sudo systemctl reload sshd     # Debian/Ubuntu
sudo systemctl reload ssh      # RHEL 系
```

> `GatewayPorts no`（默认）下 sshd 会把 `0.0.0.0:port` 的监听强行改绑回环，
> 隧道本身显示在线但公网 IP 连不上——预检的「公网可达性」步骤会给出该提示。

### 2. 防火墙放行远端端口

```bash
# 以 ufw 为例（远端端口 22022）
sudo ufw allow 22022/tcp
```

云厂商（阿里云/腾讯云/AWS 等）的安全组同样需要放行。

### 3. 建议使用专用低权限用户

```bash
sudo useradd -m -s /bin/bash relay
sudo -u relay ssh-keygen -t ed25519 -N '' -f /home/relay/.ssh/id_ed25519
# 把公钥加入 relay 的 authorized_keys（或在本产品设置·安全导入私钥）
```

隧道只需要 SSH 登录与端口转发权限，给一个最小权限账号即可；如使用 root，
至少禁用密码登录（`PasswordAuthentication no` + 密钥）。

## TLS 三种终态与信任边界

> **反代信任边界（P-20261020-1）**：反代形态由 VPS 终结 TLS——VPS 内存中
> 可见完整明文（登录令牌、终端输出、文件内容）。**VPS 不可信时不要用反代
> 形态**：改用 `0.0.0.0` 直连 + 应用受信证书（TLS 端到端，VPS 只见密文），
> 或在 VPS 上用 nginx `stream` SNI 透传（下节）。VPS 只做 TCP 搬运时，
> 明文只存在于你自己的实例与手机之间。

| 形态 | 做法 | 适用 |
|---|---|---|
| **应用自签直连** | 远端绑定 `0.0.0.0:22022`，手机访问 `https://<VPS>:22022`。应用 TLS 默认开启，自签证书首次访问需在手机信任（浏览器会警告） | 个人自用、快速验证 |
| **VPS 反代受信证书** | 远端绑定 `127.0.0.1:22022`，VPS 上 nginx/caddy 监听 443 反代到 `https://127.0.0.1:22022`（后端自签需 `proxy_ssl_verify off`），对外使用受信证书域名 | 长期使用、手机不装证书；**VPS 内存可见明文** |
| **VPS stream 透传** | 远端绑定 `127.0.0.1:22022`，VPS 上 nginx `stream` 只转发 TCP，TLS 在应用终结（应用需配置该域名的受信证书） | VPS 不完全可信、要端到端加密 |

nginx 反代片段（VPS 终结 TLS）：

```nginx
server {
    listen 443 ssl http2;
    server_name work.example.com;
    ssl_certificate     /etc/letsencrypt/live/work.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/work.example.com/privkey.pem;
    location / {
        proxy_pass https://127.0.0.1:22022;
        proxy_ssl_verify off;            # 后端是应用自签证书
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        # 真实客户端 IP / 对外 scheme（需在应用中配置 server.trustedProxies
        # 才被采信，见下节）；覆盖而非追加，避免最左值被客户端伪造
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_read_timeout 3600s;        # 终端 WebSocket 长连接
    }
}
```

反代形态下档案「可选域名」填 `work.example.com`，公网 URL 即
`https://work.example.com`（不带端口）。**应用自身 TLS 不要关闭**：nginx 到
应用的这一段仍是 TLS（自签），关闭应用 TLS 会让 nginx 与实例之间变成明文。

### nginx stream SNI 透传（TLS 端到端）

VPS 只转发 TCP，不持有明文，也不需要 `proxy_ssl_verify off`：

```nginx
# /etc/nginx/nginx.conf 顶层（与 http {} 平级）
stream {
    server {
        listen 443;
        proxy_pass 127.0.0.1:22022;   # 隧道回环端口
        ssl_preread on;               # 多域名按 SNI 分流时可配 map
        proxy_timeout 3600s;          # WebSocket/长连接
    }
}
```

应用侧需为该域名配置受信证书（Let's Encrypt 等，可用 DNS-01 签发后填入
`tlsCertFile`/`tlsKeyFile`），否则手机仍会看到自签警告。该形态下 VPS 的
nginx 看不到 HTTP 头，也无需 `trustedProxies`/X-Forwarded-* 配置；应用看到
的直连对端是隧道末端（回环），审计 IP 即回环地址——需要真实客户端 IP 时
只能用反代形态（并接受 VPS 可见明文）。

## 可信代理配置（反代形态必配）

`server.trustedProxies` 默认**空 = 不信任任何转发头**（P-20261020-1 安全
收紧：Gin 默认信任所有代理，直连客户端可伪造 `X-Forwarded-For` 绕过「每 IP
每分钟 10 次失败」的解锁限流并伪造审计 IP）。反代形态必须显式声明哪些
**直连对端**是可信代理：

```json
{
  "server": {
    "trustedProxies": ["127.0.0.1", "::1"]
  }
}
```

或经设置 API（同样需重启生效）：

```bash
curl -X PUT http://127.0.0.1:9999/api/settings \
  -H "Authorization: Bearer sc_xxx" -H 'Content-Type: application/json' \
  -d '{"trustedProxies":["127.0.0.1","::1"]}'
```

- 同机反代填回环 `127.0.0.1` / `::1`；独立反代填反代服务器的实际出口
  IP 或网段（如 `10.0.0.0/24`）。**不要填 `0.0.0.0/0` / `::/0`**——那等于
  退回「信任所有代理」。
- 采信后 `c.ClientIP()` 按 X-Forwarded-For 自右向左取第一个非可信跳（追加
  式 `$proxy_add_x_forwarded_for` 的最左伪造值不会被采信）；`RequestBaseURL`
  的 X-Forwarded-Proto/Host 也仅在直连对端可信时生效。
- **升级说明**：这是对既有反代部署的安全收紧。升级后未配置的用户会看到
  解锁限流按代理 IP 计数、审计 IP 为代理地址；反代用户请按本节补配并重启。
- 配置非法（非 IP/CIDR、超长、超 32 条）时启动期按「不信任任何转发头」
  降级并打警告日志；设置 API 写入时直接 400，避免带病配置静默降级。

## 安全建议

1. **必须先启用系统锁定并设置密码**：未启用锁定时所有 `/api` 路由免鉴权，
   公网隧道等于把控制面直接交出（服务端硬拒绝启动）。
2. **公网暴露前改掉默认密码 `admin`**（设置·安全）；仍在使用默认密码时 UI
   会持续红字提示。
3. **TLS 必开**：TLS 未启用会强警示并要求显式确认，确认动作入审计
   （`remoteaccess.tls_insecure`）；非 TLS 形态下登录令牌与内容明文过公网。
   反代形态还要注意 VPS 终结 TLS 即 VPS 可见明文（见本节开头的边界告警）。
4. **首次连接后人工核对主机指纹**（TOFU 不阻断）：状态卡会显示已钉扎的
   `SHA256:...` 指纹，登录 VPS 执行
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`（或
   `/etc/ssh/ssh_host_*_key.pub` 逐个核对）比对；不一致立即停止隧道——
   首次连接被中间人顶替时，pin 住的正是攻击者密钥。合法换钥后按需
   「重置主机指纹」。
5. **专用低权限 SSH 用户**：隧道只需要 SSH 登录与端口转发权限，不要用
   root/日常账号（示例见上文 VPS 侧配置）。至少禁用密码登录
   （`PasswordAuthentication no` + 密钥）。
6. **OpenSSH ≥ 9.0 用 `PermitListen` 限定转发目标**（把隧道权限收窄到
   唯一端口，即使凭据泄露也不能借 sshd 转发到任意地址）：

   ```sshconfig
   # /etc/ssh/sshd_config（按用户/组限定更佳）
   Match User relay
       AllowTcpForwarding remote
       PermitListen 127.0.0.1:22022       # 反代/stream 形态
       # PermitListen 0.0.0.0:22022       # 公网直连形态，二选一
       PermitOpen none                    # 隧道场景不需要本地 -L 转发
   ```

7. **安全组 + fail2ban**：云厂商安全组只放行 SSH 端口与远端隧道端口，来源
   尽量限制为常用网络；VPS 上为 sshd 配 fail2ban（`sshd` jail）阻断爆破，
   与本产品「首次失败不自动重试」的防封禁策略互补。
8. 只放行一个远端端口，不要复用 22/80/443 等敏感端口；VPS 上仅个人使用。
9. **不用即停**：手机/桌面用完点「停止隧道」（agent 也可自主 stop）；长期
   挂着的公网入口是持续攻击面。
10. 公网 URL 泄露 = 任何人可访问登录页；建议配合强密码、失败锁定限流与
    TLS。
11. 中继主机指纹变更默认拒绝；非合法迁移时不要重置指纹。
12. 反代形态在 VPS 上启用 `X-Forwarded-For` 覆盖式注入并配置
    `server.trustedProxies`（见「可信代理配置」），否则限流与审计只能看到
    代理 IP。

## 预检与自诊断

「测试连接」按序检查并给出可行动建议（`POST /api/remoteaccess/tunnel/test`）：

| step | 含义 | 常见修复 |
|---|---|---|
| `local-target` | 本机主服务端口可达 | 核对服务端口；隧道只转发到回环主端口 |
| `ssh-reachable` | VPS SSH 端口 TCP 可达 | 地址/端口、安全组、防火墙 |
| `host-key` | TOFU 主机指纹一致 | 合法迁移后重置指纹；否则停止 |
| `auth` | 用户名/密码/密钥可登录 | 核对凭据与 sshd 认证策略（root 密码登录常被禁） |
| `port-free` | 远端端口未被其他服务占用 | 换端口或停占用者 |
| `tcp-forward` | sshd 允许远端转发并成功绑定 | `AllowTcpForwarding yes`；端口占用 |
| `gateway-ports` | 从本实例回拨公网地址可达 | `GatewayPorts clientspecified`、防火墙、改回环+反代 |

## 智能体操作面

```
GET  /api/remoteaccess/tunnel                  状态 + lockReady/tlsEnabled/hostKey
POST /api/remoteaccess/tunnel                  {"action":"start|stop",...}
POST /api/remoteaccess/tunnel/test             {"profileId"} / {"profile":{...}}
POST /api/remoteaccess/tunnel/hostkey/reset    {"profileId"}
```

**审批边界（P-20261020-1）**：`POST /api/remoteaccess/tunnel` 已纳入 AgentGuard
高危路由表——持 `sca_` 智能体令牌调用 `action=start`（含切换档案，切换即
start 另一 profileId）必须走审批（428 + approvalId，轮询/重试语义同其他
高危端点）；`action=stop` 是降险动作，直过不审批。缺失/未知 action 按
start 处理（失败闭合）。档案 CRUD 仍走 `GET/PUT /api/settings` 的
`remoteAccess` 字段，但运行态启动必须过审批——agent 无法私自把实例推到公网。
事件 `remoteaccess.status` 每次状态迁移广播（`sc-ops:remoteaccess.status`），
agent 可监听感知在线/重连/失败，不必轮询。审计动作：
`remoteaccess.tunnel.start` / `remoteaccess.tunnel.stop` /
`remoteaccess.tunnel.fail` / `remoteaccess.tls_insecure`；AgentGuard 裁决另落
`agentguard.*` 审计（`route=/api/remoteaccess/tunnel`）。

可信代理清单经既有设置面读写：`GET /api/settings` 的 `trustedProxies` 只读
投影，`PUT /api/settings` 同字段写入（数组，空数组 = 不信任；重启生效）。
