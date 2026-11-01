package system

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"codecombo/server/config"
	"codecombo/server/notification"
	"codecombo/server/store"
	"codecombo/server/sysinfo"
)

// 磁盘水位档位线（P-20261002-12）：健康端点的 level 字段与巡检通知同一套
// 判定——>warn% 黄、>crit% 红，单一出处，前端只认 level 不再自带阈值
const (
	diskWarnPercent = 80.0
	diskCritPercent = 90.0

	// diskWatchInterval 巡检周期（低频：水位变化以小时计，5 分钟足够）
	diskWatchInterval = 5 * time.Minute
)

// 卷角色标识：健康端点 JSON、前端 i18n 标签、通知文案键三处共用
const (
	diskRoleData = "data"
	diskRoleSys  = "sys"
)

// diskVolume 健康端点的单卷水位。容量用 MB（与内存指标同口径，JS number 安全）
type diskVolume struct {
	Role        string  `json:"role"` // data / sys
	Path        string  `json:"path"` // 观测锚点路径（提示用户哪块盘）
	UsedMB      uint64  `json:"usedMB"`
	TotalMB     uint64  `json:"totalMB"`
	UsedPercent float64 `json:"usedPercent"`
	Level       string  `json:"level"` // ok / warn / crit
}

// sysDiskPath 系统盘观测路径：SC_SYS_DISK_PATH 可指到其他卷（数据与仓库
// 分盘的机器），默认与数据盘同卷——同卷时端点去重、巡检只盯数据盘
func sysDiskPath() string {
	p := strings.TrimSpace(os.Getenv("CC_SYS_DISK_PATH"))
	if p == "" {
		p = strings.TrimSpace(os.Getenv("SC_SYS_DISK_PATH")) // 旧名兼容双读（P-20261025-1）
	}
	if p != "" {
		return p
	}
	return config.DataDir()
}

// diskLevelOf 水位档位：ok / warn（>80%）/ crit（>90%）
func diskLevelOf(pct float64) string {
	switch {
	case pct > diskCritPercent:
		return "crit"
	case pct > diskWarnPercent:
		return "warn"
	default:
		return "ok"
	}
}

// diskVolumes 数据盘（DataDir 所在卷）+ 系统盘水位清单，同卷去重。
// 单卷采集失败静默跳过：挂载抖动/权限问题不该把健康检查拖成 degraded，
// 巡检侧同样跳过该卷（下一轮再试）
func diskVolumes() []diskVolume {
	dataPath := config.DataDir()
	sysPath := sysDiskPath()

	var volumes []diskVolume
	if du, err := sysinfo.Usage(dataPath); err == nil {
		volumes = append(volumes, newDiskVolume(diskRoleData, dataPath, du))
	}
	// 同卷去重：系统盘与数据盘同卷时只报数据盘一条（数据盘才是吃盘主体）
	if sysPath != dataPath && !sysinfo.SameVolume(dataPath, sysPath) {
		if du, err := sysinfo.Usage(sysPath); err == nil {
			volumes = append(volumes, newDiskVolume(diskRoleSys, sysPath, du))
		}
	}
	return volumes
}

func newDiskVolume(role, path string, du sysinfo.DiskUsage) diskVolume {
	return diskVolume{
		Role:        role,
		Path:        path,
		UsedMB:      du.Used() / 1024 / 1024,
		TotalMB:     du.Total / 1024 / 1024,
		UsedPercent: du.UsedPercent(),
		Level:       diskLevelOf(du.UsedPercent()),
	}
}

// humanMB 语言中立容量格式（通知 Body 明细用，1024 进制与面板 humanMB 同基）
func humanMB(mb uint64) string {
	switch {
	case mb >= 1024*1024:
		return fmt.Sprintf("%.2f TB", float64(mb)/(1024*1024))
	case mb >= 1024:
		return fmt.Sprintf("%.2f GB", float64(mb)/1024)
	default:
		return fmt.Sprintf("%d MB", mb)
	}
}

// diskWatchdog 磁盘水位巡检器：跨阈值一次性入账通知中心（Category system），
// 水位回落到 warn 线以下重新武装（迟滞防刷屏——warn↔crit 间抖动不重复打扰，
// 只有真正恢复才重置）。采集与投递均可注入：单测造水位数据断言通知构造
// （80%+ 的真实磁盘在测试环境造不出来）
type diskWatchdog struct {
	mu    sync.Mutex
	notfy map[string]string // 卷角色 -> 已通知档位（warn/crit）；缺省 = 已武装

	volumesFn func() []diskVolume
	addFn     func(notification.Notification)
}

func newDiskWatchdog(volumesFn func() []diskVolume, addFn func(notification.Notification)) *diskWatchdog {
	return &diskWatchdog{
		notfy:     map[string]string{},
		volumesFn: volumesFn,
		addFn:     addFn,
	}
}

// reset 停机时清空武装状态（进程内状态，重启即重建；Stop→Start 循环下
// 不携带旧档位）
func (w *diskWatchdog) reset() {
	w.mu.Lock()
	w.notfy = map[string]string{}
	w.mu.Unlock()
}

// patrol 单轮巡检：逐卷判档、跨阈值入账。通知走 store 统一投递口
// （类别偏好过滤/出站广播在 store.Notification.Add 内），未装配时静默跳过
func (w *diskWatchdog) patrol() {
	volumesFn := w.volumesFn
	if volumesFn == nil {
		volumesFn = diskVolumes
	}
	add := w.addFn
	if add == nil {
		if store.Get() == nil {
			return
		}
		add = store.Get().Notification.Add
	}
	for _, v := range volumesFn() {
		w.cross(v, add)
	}
}

// cross 单卷档位变迁判定：首跨或升级才入账，回线恢复重新武装
func (w *diskWatchdog) cross(v diskVolume, add func(notification.Notification)) {
	w.mu.Lock()
	if v.Level != "warn" && v.Level != "crit" {
		delete(w.notfy, v.Role) // 回到 warn 线以下：重新武装，下次跨阈值再报
		w.mu.Unlock()
		return
	}
	prev, notified := w.notfy[v.Role]
	if !notified || diskLevelRank(v.Level) > diskLevelRank(prev) {
		w.notfy[v.Role] = v.Level // 首跨或升级：入账并记档
		w.mu.Unlock()
		add(diskNotification(v))
		return
	}
	w.mu.Unlock()
	// 同档已报 / 降档不打扰（仍在线内，防抖动刷屏）
}

// diskLevelRank 档位严重度序（warn=1 / crit=2，ok 不参与比较）
func diskLevelRank(level string) int {
	if level == "crit" {
		return 2
	}
	return 1
}

// diskNotifyTitle 中文兜底标题（桌面通知等非模板消费方）：
// 「{数据盘|系统盘}」×「水位超 80%|空间告急」
var diskNotifyTitles = map[string]string{
	diskRoleData + "warn": "数据盘空间水位超 80%",
	diskRoleData + "crit": "数据盘空间告急",
	diskRoleSys + "warn":  "系统盘空间水位超 80%",
	diskRoleSys + "crit":  "系统盘空间告急",
}

// diskNotification 跨阈值通知构造：titleKey 随角色×档位走 i18n 模板
// （monitor.disk.notify.*），Body 承载语言中立明细（占用/剩余/路径），
// 与日报/定时任务通知同惯例
func diskNotification(v diskVolume) notification.Notification {
	ntype := "warning"
	if v.Level == "crit" {
		ntype = "error"
	}
	levelTitle := "Warn"
	if v.Level == "crit" {
		levelTitle = "Crit"
	}
	return notification.Notification{
		Type:     ntype,
		Category: notification.CategorySystem,
		TitleKey: "monitor.disk.notify." + v.Role + levelTitle,
		BodyKey:  "monitor.disk.notify." + v.Level + "Body",
		Title:    diskNotifyTitles[v.Role+v.Level],
		Body: fmt.Sprintf("used %.1f%%, free %s (%s)",
			v.UsedPercent, humanMB(v.TotalMB-v.UsedMB), v.Path),
		MsgParams: map[string]any{
			"pct":  fmt.Sprintf("%.1f%%", v.UsedPercent),
			"free": humanMB(v.TotalMB - v.UsedMB),
		},
	}
}
