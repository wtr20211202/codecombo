package remote

import (
	"fmt"

	"codecombo/server/config"
	"codecombo/server/sshclient"
	"codecombo/server/store"
)

// ResolveRemoteHostAuth 解析远程主机凭据：sshkey 引用（SshKeyID）→ 就地填充 PemContent 私钥
// 其余认证方式（password / pem 直填）无需解析直接通过
// remotehost_exec / remotehost_diag / deploy TestConnection / deploy_task / 远程终端 Dialer 共用
//
// 解密失败检测：store 层解密失败时原样返回 enc: 密文（不中断列表/编辑流），
// 本函数在拨号前拦截这种密文——否则密文会被当密码发出，只报一句难懂的
// "unable to authenticate"，用户无从知道该重新录入凭据（master-key 换过/数据目录迁移）
func ResolveRemoteHostAuth(rh *config.RemoteHost) error {
	if config.IsEncrypted(rh.Password) || config.IsEncrypted(rh.PemContent) {
		return fmt.Errorf("credential decrypt failed: master-key mismatch (data dir migrated or reinstalled); re-enter the password/key by editing this host")
	}
	if rh.AuthType != sshclient.AuthTypeSshKey || rh.SshKeyID == "" {
		return nil
	}
	pem, err := store.Get().SshKey.GetPrivatePem(rh.SshKeyID)
	if err != nil {
		return fmt.Errorf("resolve ssh key failed: %w", err)
	}
	rh.PemContent = pem
	return nil
}
