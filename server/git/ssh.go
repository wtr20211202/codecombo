package git

import "fmt"

// BuildSSHCommand 返回 GIT_SSH_COMMAND 值，指定私钥路径 + 安全选项。
// IdentitiesOnly=yes 避免与系统 ssh-agent 冲突；
// StrictHostKeyChecking=accept-new 首次连接自动信任。
func BuildSSHCommand(privateKeyPath string) string {
	return fmt.Sprintf("ssh -i \"%s\" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new", privateKeyPath)
}
