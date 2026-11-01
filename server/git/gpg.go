package git

// ExecGitConfig 执行 git config 命令（探测语义：读取未配置键返回错误属正常
// 结果，不广播到前端命令台——调用方均为 UI 展示读取，缺键即按默认值处理）
func ExecGitConfig(repoPath string, key string) (string, error) {
	return execGitProbe(repoPath, "config", "--get", key)
}

// SetGitConfig 设置项目级别的 git config
func SetGitConfig(repoPath string, key string, value string) error {
	_, err := execGit(repoPath, "config", "--local", key, value)
	return err
}

// VerifyCommitSignature 验证提交的 GPG 签名
func VerifyCommitSignature(repoPath string, commit string) (string, error) {
	output, err := execGit(repoPath, "log", "--format=%G?|%GG", "-1", commit)
	if err != nil {
		return "", err
	}
	return output, nil
}

// GetCommitSignatureStatus 获取提交签名状态
func GetCommitSignatureStatus(repoPath string, commit string) (string, string, error) {
	output, err := execGit(repoPath, "log", "--format=%G?|%GS|%GK", "-1", commit)
	if err != nil {
		return "", "", err
	}

	// %G?: G=good, B=bad, U=good but expired, X=good but made by CA, Y=good but key expired, E=can't check, N=no signature
	// %GS: signer name
	// %GK: key
	parts := splitFirstN(output, "|", 3)
	status := ""
	signer := ""
	if len(parts) >= 1 {
		status = parts[0]
	}
	if len(parts) >= 2 {
		signer = parts[1]
	}

	return status, signer, nil
}

// SetCommitGpgSign 设置/取消 GPG 签名
func SetCommitGpgSign(repoPath string, enable bool) error {
	val := "false"
	if enable {
		val = "true"
	}
	_, err := execGit(repoPath, "config", "commit.gpgsign", val)
	return err
}

func splitFirstN(s string, sep string, n int) []string {
	var result []string
	remaining := s
	for i := 0; i < n-1; i++ {
		idx := indexOf(remaining, sep)
		if idx < 0 {
			break
		}
		result = append(result, remaining[:idx])
		remaining = remaining[idx+len(sep):]
	}
	result = append(result, remaining)
	return result
}

func indexOf(s, substr string) int {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return i
		}
	}
	return -1
}
