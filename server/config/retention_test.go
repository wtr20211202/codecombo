package config

import "testing"

// 保留期可配（P-20261003-123）：默认兼容（旧配置缺字段 = 现行为 30/15）、
// 显式值读取、越界/负值读取侧收敛默认、写入端边界函数

func TestRetentionDaysOrDefault(t *testing.T) {
	// 存量兼容：零值（旧配置文件缺字段）= 可配化前的硬编码现值
	zero := ServerConfig{}
	if got := zero.AuditRetentionDaysOrDefault(); got != 30 {
		t.Fatalf("zero auditRetentionDays = %d, want 30", got)
	}
	if got := zero.LogRetentionDaysOrDefault(); got != 15 {
		t.Fatalf("zero logRetentionDays = %d, want 15", got)
	}

	// 显式配置生效（合规调长 / 磁盘紧张调短双向）
	long := ServerConfig{AuditRetentionDays: 365, LogRetentionDays: 90}
	if got := long.AuditRetentionDaysOrDefault(); got != 365 {
		t.Fatalf("auditRetentionDays = %d, want 365", got)
	}
	if got := long.LogRetentionDaysOrDefault(); got != 90 {
		t.Fatalf("logRetentionDays = %d, want 90", got)
	}

	// 越界/负值读取侧收敛默认（不做白名单拒绝，UIDensityOrDefault 同款）
	bad := ServerConfig{AuditRetentionDays: -1, LogRetentionDays: MaxRetentionDays + 1}
	if got := bad.AuditRetentionDaysOrDefault(); got != 30 {
		t.Fatalf("negative auditRetentionDays = %d, want default 30", got)
	}
	if got := bad.LogRetentionDaysOrDefault(); got != 15 {
		t.Fatalf("overflow logRetentionDays = %d, want default 15", got)
	}
}

func TestRetentionDaysValid(t *testing.T) {
	valid := []int{0, 1, 15, 30, 365, MaxRetentionDays}
	for _, d := range valid {
		if !RetentionDaysValid(d) {
			t.Errorf("RetentionDaysValid(%d) = false, want true", d)
		}
	}
	invalid := []int{-1, MaxRetentionDays + 1, 9999}
	for _, d := range invalid {
		if RetentionDaysValid(d) {
			t.Errorf("RetentionDaysValid(%d) = true, want false", d)
		}
	}
}
