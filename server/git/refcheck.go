package git

import (
	"fmt"
	"strings"
)

// validateRef 校验用户可控的 git 引用名（分支/标签/commit-ish）。
// A6 防护：以 "-" 开头的引用会被 git 解析为命令行选项（argument injection），
// 例如 branch 名传 "-D x" 可叠加删除标志、传 "--exec" 类选项无意义但 "-o" 等扩展
// 选项在部分子命令下有副作用。引用统一走参数数组执行（无 shell 注入），
// 这里只需拒绝"长得像选项"的名字。
// 合法引用可能包含 "/"（origin/main）、"."（v1.0）等，均不拦截。
func validateRef(refs ...string) error {
	for _, r := range refs {
		trimmed := strings.TrimSpace(r)
		if trimmed == "" {
			return fmt.Errorf("ref name is required")
		}
		if strings.HasPrefix(trimmed, "-") {
			return fmt.Errorf("invalid ref name: %q (must not start with '-')", trimmed)
		}
	}
	return nil
}
