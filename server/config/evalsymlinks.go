package config

import (
	"path/filepath"
)

// EvalSymlinksNormalized 路径真实化：目标存在直接 EvalSymlinks；不存在
//（未创建的目标文件/rename 目的地/missing 目录）解析最近存在的祖先并把尾部
// 拼回。裸 EvalSymlinks 是不对称展开（存在侧展开、缺失侧保持原形态），Windows
// 短名（8.3）环境下「缺失目标的短名 vs 已解析 root 的长名」曾误判 traversal
//（GitHub windows runner 的 TMP=C:\Users\RUNNER~1\... 实锚）。
//
// DataDir() 消费本函数做同型归一：runner 短名 TMP 下 LocalSystem 服务的
// DataDir 曾落 systemprofile 空目录（deployLogDir mkdir PATH_NOT_FOUND 实锚）。
// 原实现历史：server/api/files（边界校验主实现）、server/git/commit_template
// （同值互锁）、server/api/terminal（引 files 版）——底层化后各消费方逐步
// 收敛到本包单点
func EvalSymlinksNormalized(absPath string) string {
	if real, err := filepath.EvalSymlinks(absPath); err == nil {
		return real
	}
	p := absPath
	for {
		parent := filepath.Dir(p)
		if parent == p {
			return absPath // 到根仍失败：原样返回
		}
		if real, err := filepath.EvalSymlinks(parent); err == nil {
			// 尾段 = absPath 相对 parent 的部分（parent 是字符串级 Dir(absPath)，
			// 前缀关系成立）；更深缺失段在继续上溯时经 p 更新保持正确拼接。
			// Clean 防拼接错位：大小写不敏感盘（WSL1）上不存在的祖先可能被
			// 解析到形态不同的真实路径，直拼会产生 "//" 冗余
			return filepath.Clean(real + absPath[len(parent):])
		}
		p = parent
	}
}

// dataDirNormalized DataDir 的归一形态：短名（runner TMP=RUNNER~1）展开为
// 长名真实路径——服务（LocalSystem）/交互用户两种上下文下形态一致，避免
// mkdir/stat 在短名路径上的非确定行为
func dataDirNormalized(dir string) string {
	if dir == "" {
		return dir
	}
	return EvalSymlinksNormalized(dir)
}
