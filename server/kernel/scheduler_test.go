package kernel

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func TestScheduler_AddTickerRunsAndStops(t *testing.T) {
	s := NewScheduler(nil)
	var n atomic.Int32
	if !s.AddTicker("job", 10*time.Millisecond, func(context.Context) { n.Add(1) }) {
		t.Fatal("AddTicker should succeed")
	}

	deadline := time.Now().Add(2 * time.Second)
	for n.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if n.Load() == 0 {
		t.Fatal("job never ran")
	}

	s.Stop()
	after := n.Load()
	time.Sleep(50 * time.Millisecond)
	if n.Load() != after {
		t.Fatalf("job ran after Stop: %d -> %d", after, n.Load())
	}
	s.Stop() // 幂等
}

func TestScheduler_DuplicateNameRejected(t *testing.T) {
	s := NewScheduler(nil)
	defer s.Stop()
	if !s.AddTicker("dup", time.Hour, func(context.Context) {}) {
		t.Fatal("first AddTicker should succeed")
	}
	if s.AddTicker("dup", time.Hour, func(context.Context) {}) {
		t.Fatal("duplicate AddTicker should be rejected")
	}
}

func TestScheduler_JobPanicDoesNotKillLoop(t *testing.T) {
	s := NewScheduler(nil)
	defer s.Stop()
	var n atomic.Int32
	s.AddTicker("panicky", 10*time.Millisecond, func(context.Context) {
		if n.Add(1) == 1 {
			panic("first run explodes")
		}
	})
	deadline := time.Now().Add(2 * time.Second)
	for n.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if n.Load() < 2 {
		t.Fatalf("job did not survive panic, runs = %d", n.Load())
	}
}

func TestScheduler_ZeroIntervalRejected(t *testing.T) {
	s := NewScheduler(nil)
	defer s.Stop()
	if s.AddTicker("zero", 0, func(context.Context) {}) {
		t.Fatal("zero interval should be rejected")
	}
}

// TestScheduler_JobsSnapshot 清单快照（P-20261003-276）：注册即见（名称升序、
// interval 定格、未到点 lastRun 零值），到点执行后 lastRun 盖章
func TestScheduler_JobsSnapshot(t *testing.T) {
	s := NewScheduler(nil)
	defer s.Stop()
	if !s.AddTicker("zz-cleanup", 24*time.Hour, func(context.Context) {}) {
		t.Fatal("AddTicker zz-cleanup should succeed")
	}
	if !s.AddTicker("aa-watch", 30*time.Second, func(context.Context) {}) {
		t.Fatal("AddTicker aa-watch should succeed")
	}

	jobs := s.Jobs()
	if len(jobs) != 2 {
		t.Fatalf("Jobs() len = %d, want 2", len(jobs))
	}
	// 名称升序——展示层不再各自排序
	if jobs[0].Name != "aa-watch" || jobs[1].Name != "zz-cleanup" {
		t.Fatalf("Jobs() not sorted by name: %q, %q", jobs[0].Name, jobs[1].Name)
	}
	if jobs[0].Interval != 30*time.Second || jobs[1].Interval != 24*time.Hour {
		t.Fatalf("interval not preserved: %v, %v", jobs[0].Interval, jobs[1].Interval)
	}
	// 未到点：lastRun 零值（前端空串哨兵的前提）
	for _, j := range jobs {
		if !j.LastRun.IsZero() {
			t.Errorf("job %q lastRun = %v before first tick, want zero", j.Name, j.LastRun)
		}
	}

	// 到点执行后 lastRun 盖章（触发时刻语义，落在测试窗口内）
	var ran atomic.Bool
	if !s.AddTicker("fast-probe", 5*time.Millisecond, func(context.Context) { ran.Store(true) }) {
		t.Fatal("AddTicker fast-probe should succeed")
	}
	before := time.Now().Add(-time.Second)
	deadline := time.Now().Add(2 * time.Second)
	for !ran.Load() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if !ran.Load() {
		t.Fatal("fast-probe never ran")
	}
	var probe *JobInfo
	snapshot := s.Jobs()
	for i := range snapshot {
		if snapshot[i].Name == "fast-probe" {
			probe = &snapshot[i]
		}
	}
	if probe == nil {
		t.Fatal("fast-probe missing from Jobs()")
	}
	if probe.LastRun.IsZero() {
		t.Fatal("fast-probe lastRun still zero after run")
	}
	if probe.LastRun.Before(before) || probe.LastRun.After(time.Now()) {
		t.Fatalf("lastRun %v outside test window [%v, now]", probe.LastRun, before)
	}
}

// TestScheduler_JobsSnapshotIsCopy 快照是副本：调用方改写返回值不影响注册表
func TestScheduler_JobsSnapshotIsCopy(t *testing.T) {
	s := NewScheduler(nil)
	defer s.Stop()
	if !s.AddTicker("job", time.Hour, func(context.Context) {}) {
		t.Fatal("AddTicker should succeed")
	}
	jobs := s.Jobs()
	jobs[0].Name = "mutated"
	if again := s.Jobs(); again[0].Name != "job" {
		t.Fatalf("snapshot mutation leaked into registry: %q", again[0].Name)
	}
}
