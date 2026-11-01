package deploy

import "codecombo/server/store"

// defaultManager 全局 Manager 单例（deploy 模块 Init 装配、Stop 卸载；
// M2.1：原 SetDefaultManager setter 已消除，装配收敛到本包模块内）
var defaultManager *Manager

// DefaultManager 取全局 Manager（handler 用；模块未启动时返回 nil）
func DefaultManager() *Manager { return defaultManager }

// InitDefault 初始化默认 Manager（兼容入口：等价模块 Init 的装配动作）
func InitDefault() *Manager {
	m := NewManager(store.Get().DeployTask)
	defaultManager = m
	return m
}
