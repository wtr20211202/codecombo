// Package proc 进程存活探测的平台抽象。
//
// 为什么存在：数据目录迁移（server/config datamigrate）在 rename 前需要预检
// 旧实例是否存活——该判定逻辑原本只活在 package main（isProcessAlive），
// config 包不能反向 import main，故收敛为可复用的平台分支实现。
// 语义三平台显式一致：pid<=0 恒 false；探测失败保守按「不可判定=不存活」，
// 调用方（迁移预检）据此放行并在错误信息里附 pid 让用户自行复核（PID 复用
// 的误判面由「拒绝迁移 + 明示 pid」的保守策略兜底，不会误删数据）。
package proc
