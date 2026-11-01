package metrics

import (
	"strings"
	"testing"
)

func TestCounterAndGauge(t *testing.T) {
	ResetForTesting()

	IncCounter("sc_test_total", "method", "GET", "status", "200")
	IncCounter("sc_test_total", "method", "GET", "status", "200")
	IncCounter("sc_test_total", "method", "GET", "status", "500")
	AddCounter("sc_test_duration_us_total", 1500, "route", "/ping")

	SetGauge("sc_test_connections", 3, "endpoint", "ops-channel")
	AddGauge("sc_test_connections", -1, "endpoint", "ops-channel")

	out := Render()
	for _, want := range []string{
		`# TYPE sc_test_total counter`,
		`sc_test_total{method="GET",status="200"} 2`,
		`sc_test_total{method="GET",status="500"} 1`,
		`sc_test_duration_us_total{route="/ping"} 1500`,
		`# TYPE sc_test_connections gauge`,
		`sc_test_connections{endpoint="ops-channel"} 2`,
		"sc_process_goroutines ",
		"sc_process_uptime_seconds ",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("render missing %q\n---\n%s", want, out)
		}
	}
}

func TestLabelsSortedStable(t *testing.T) {
	ResetForTesting()

	// 同一序列不同插入顺序的标签应归并为同一条
	AddCounter("sc_order_total", 1, "b", "2", "a", "1")
	AddCounter("sc_order_total", 1, "a", "1", "b", "2")

	out := Render()
	if !strings.Contains(out, `sc_order_total{a="1",b="2"} 2`) {
		t.Errorf("expected merged sorted series, got:\n%s", out)
	}
}

func TestProcessSectionAlwaysPresent(t *testing.T) {
	ResetForTesting()
	out := Render()
	if !strings.Contains(out, "# TYPE sc_process_heap_alloc_bytes gauge") {
		t.Error("expected process metrics section in render")
	}
}
