// 远程接入档案编辑态（P-20261019-11）：设置·远程接入分区的父子组件共享
// 类型与提交形态转换。密码留空语义 = 服务端保持原密文（GET 不回密码）。
import type { RemoteAccessProfileInput } from '../../api/client'

export interface RemoteAccessEditorState {
  id: string
  name: string
  host: string
  port: number
  user: string
  authType: 'password' | 'sshkey'
  sshKeyId: string
  password: string
  hasPassword: boolean
  remoteBindHost: string
  remotePort: number
  domain: string
}

/** 新建档案默认值（远端端口建议 22022，公网绑定） */
export function emptyRemoteAccessEditor(): RemoteAccessEditorState {
  return {
    id: '', name: '', host: '', port: 22, user: '', authType: 'password', sshKeyId: '',
    password: '', hasPassword: false, remoteBindHost: '0.0.0.0', remotePort: 22022, domain: '',
  }
}

/** 编辑态 → 保存/预检提交形态（password 空 = 不携带，服务端保持原密文） */
export function remoteAccessEditorInput(e: RemoteAccessEditorState): RemoteAccessProfileInput {
  return {
    id: e.id || undefined,
    name: e.name.trim(),
    host: e.host.trim(),
    port: Number(e.port) || 22,
    user: e.user.trim(),
    authType: e.authType,
    sshKeyId: e.authType === 'sshkey' ? e.sshKeyId : undefined,
    password: e.authType === 'password' && e.password ? e.password : undefined,
    remoteBindHost: e.remoteBindHost,
    remotePort: Number(e.remotePort) || 22022,
    domain: e.domain.trim(),
  }
}
