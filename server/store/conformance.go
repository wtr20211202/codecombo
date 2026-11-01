package store

// DocumentStore conformance 套件：把接口的全部语义契约钉死为可执行用例。
//
// 用途（docs/PERSISTENCE_LANES.md「何时换 SQLite」前置条件）：未来任何
// DocumentStore 新实现（SQLite 等）的验收方式 = 同一 suite 对拍——
// 新实现的测试里调 RunConformance(t, factory)，全绿即语义兼容，
// 20 个 repo 层无需逐个回归。
//
// 契约要点（本文件同时是接口的规格说明）：
//   - 错误语义用哨兵错误标识（errors.Is）：Create 重复 → ErrAlreadyExists，
//     Update/Delete/Patch 缺失 → ErrNotFound；
//   - Patch/PatchBatch 是 JSON 顶层键合并（非递归深合并）；
//   - Match 是反序列化后的值相等（数值以 JSON 解码类型 float64 为准），
//     且任何写操作后必须即时失效 Match 缓存；
//   - List 键序默认字典升序；total = 过滤后、分页前的总数；
//   - 键/kind 校验黑名单（路径分隔符、冒号、点前缀、.. 段、空值、>256）
//     任何实现都必须拒绝。

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// RunConformance 对给定 factory 产出的 DocumentStore 实例跑全部契约用例。
// factory 每次调用必须返回互不隔离的全新实例（filestore 传 t.TempDir()）。
func RunConformance(t *testing.T, factory func(t *testing.T) DocumentStore) {
	t.Run("CRUD 基本语义与哨兵错误", func(t *testing.T) {
		s := factory(t)
		doc := []byte(`{"name":"a","n":1}`)

		if _, err := s.Get("conf", "k1"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("Get missing: want ErrNotFound, got %v", err)
		}
		if has, err := s.Has("conf", "k1"); err != nil || has {
			t.Fatalf("Has missing: want false,nil got %v,%v", has, err)
		}
		if err := s.Create("conf", "k1", doc); err != nil {
			t.Fatalf("Create: %v", err)
		}
		if err := s.Create("conf", "k1", doc); !errors.Is(err, ErrAlreadyExists) {
			t.Fatalf("Create duplicate: want ErrAlreadyExists, got %v", err)
		}
		got, err := s.Get("conf", "k1")
		if err != nil || string(got) != string(doc) {
			t.Fatalf("Get after create: %q, %v", got, err)
		}
		if has, err := s.Has("conf", "k1"); err != nil || !has {
			t.Fatalf("Has after create: want true,nil got %v,%v", has, err)
		}

		upd := []byte(`{"name":"a2","n":2}`)
		if err := s.Update("conf", "k1", upd); err != nil {
			t.Fatalf("Update: %v", err)
		}
		if err := s.Update("conf", "nope", upd); !errors.Is(err, ErrNotFound) {
			t.Fatalf("Update missing: want ErrNotFound, got %v", err)
		}

		if err := s.Delete("conf", "nope"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("Delete missing: want ErrNotFound, got %v", err)
		}
		if err := s.Delete("conf", "k1"); err != nil {
			t.Fatalf("Delete: %v", err)
		}
		if _, err := s.Get("conf", "k1"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("Get after delete: want ErrNotFound, got %v", err)
		}
	})

	t.Run("Upsert 存在即更/否即建", func(t *testing.T) {
		s := factory(t)
		// 缺失 → Create 语义：写入成功且可读回
		if err := s.Upsert("conf", "u1", []byte(`{"v":1}`)); err != nil {
			t.Fatalf("Upsert missing: %v", err)
		}
		if got, err := s.Get("conf", "u1"); err != nil || string(got) != `{"v":1}` {
			t.Fatalf("Get after upsert-create: %q, %v", got, err)
		}
		// 存在 → Update 语义：整体替换（非 Patch 合并）
		if err := s.Upsert("conf", "u1", []byte(`{"v":2}`)); err != nil {
			t.Fatalf("Upsert existing: %v", err)
		}
		if got, err := s.Get("conf", "u1"); err != nil || string(got) != `{"v":2}` {
			t.Fatalf("Get after upsert-update: %q, %v", got, err)
		}
		// 非法 key：Has 的键校验错误按不存在处理落 Create（接口契约——历史
		// 样板 has, _ := 语义原样收编），Create 的键校验必须让错误冒出，
		// 不得静默丢写
		if err := s.Upsert("conf", "../evil", []byte(`{}`)); err == nil {
			t.Fatal("Upsert invalid key: want error, got nil")
		}
	})

	t.Run("Patch 顶层合并语义", func(t *testing.T) {
		s := factory(t)
		if err := s.Create("conf", "p1", []byte(`{"a":1,"b":{"x":1},"keep":true}`)); err != nil {
			t.Fatal(err)
		}
		// b 整体被替换（非深合并），a/keep 保留
		if err := s.Patch("conf", "p1", map[string]any{"b": map[string]any{"y": 2}, "c": "z"}); err != nil {
			t.Fatal(err)
		}
		got, _ := s.Get("conf", "p1")
		var doc map[string]any
		if err := json.Unmarshal(got, &doc); err != nil {
			t.Fatal(err)
		}
		if v, ok := doc["a"].(float64); !ok || v != 1 {
			t.Fatalf("patch must keep untouched top-level keys: %v", doc)
		}
		b, _ := doc["b"].(map[string]any)
		if b == nil || b["x"] != nil || b["y"] != float64(2) {
			t.Fatalf("patch replaces top-level value (no deep merge): %v", doc)
		}
		if doc["c"] != "z" || doc["keep"] != true {
			t.Fatalf("patch adds new keys: %v", doc)
		}
		if err := s.Patch("conf", "missing", map[string]any{"a": 1}); !errors.Is(err, ErrNotFound) {
			t.Fatalf("Patch missing: want ErrNotFound, got %v", err)
		}
	})

	t.Run("批量操作", func(t *testing.T) {
		s := factory(t)
		if err := s.CreateBatch("conf", map[string][]byte{
			"b1": []byte(`{"v":1}`), "b2": []byte(`{"v":2}`),
		}); err != nil {
			t.Fatal(err)
		}
		// CreateBatch 与 Create 同语义：重复键拒绝，不得静默覆盖
		if err := s.CreateBatch("conf", map[string][]byte{"b1": []byte(`{"v":9}`)}); !errors.Is(err, ErrAlreadyExists) {
			t.Fatalf("CreateBatch duplicate: want ErrAlreadyExists, got %v", err)
		}
		if got, err := s.Get("conf", "b1"); err != nil || string(got) != `{"v":1}` {
			t.Fatalf("CreateBatch duplicate must not overwrite: %q %v", got, err)
		}

		// GetBatch：只返回存在的键
		m, err := s.GetBatch("conf", []string{"b1", "b2", "missing"})
		if err != nil || len(m) != 2 || string(m["b2"]) != `{"v":2}` {
			t.Fatalf("GetBatch: %v %v", m, err)
		}

		if err := s.UpdateBatch("conf", map[string][]byte{"b1": []byte(`{"v":10}`), "missing": []byte(`{}`)}); !errors.Is(err, ErrNotFound) {
			t.Fatalf("UpdateBatch missing: want ErrNotFound, got %v", err)
		}

		if err := s.PatchBatch("conf", map[string]map[string]any{"missing": {"a": 1}}); !errors.Is(err, ErrNotFound) {
			t.Fatalf("PatchBatch missing: want ErrNotFound, got %v", err)
		}
		if err := s.PatchBatch("conf", map[string]map[string]any{"b1": {"v": 11}}); err != nil {
			t.Fatal(err)
		}
		if got, _ := s.Get("conf", "b1"); !strings.Contains(string(got), `"v":11`) {
			t.Fatalf("PatchBatch not applied: %s", got)
		}

		// DeleteBatch：缺失键静默忽略
		if err := s.DeleteBatch("conf", []string{"b1", "missing"}); err != nil {
			t.Fatalf("DeleteBatch ignores missing: %v", err)
		}
		keys, total, _ := s.List("conf", ListOpts{})
		if total != 1 || len(keys) != 1 || keys[0] != "b2" {
			t.Fatalf("after DeleteBatch want [b2], got %v (total %d)", keys, total)
		}

		if err := s.Clear("conf"); err != nil {
			t.Fatal(err)
		}
		if keys, total, _ := s.List("conf", ListOpts{}); total != 0 || len(keys) != 0 {
			t.Fatalf("Clear must empty the kind, got %v", keys)
		}
	})

	t.Run("List 键序/前缀/分页", func(t *testing.T) {
		s := factory(t)
		for _, k := range []string{"a", "b", "c", "d"} {
			if err := s.Create("conf", k, []byte(`{"v":1}`)); err != nil {
				t.Fatal(err)
			}
		}
		keys, total, err := s.List("conf", ListOpts{})
		if err != nil || total != 4 || strings.Join(keys, ",") != "a,b,c,d" {
			t.Fatalf("default order: %v %d %v", keys, total, err)
		}
		keys, _, _ = s.List("conf", ListOpts{Sort: SortOrder{Descending: true}})
		if strings.Join(keys, ",") != "d,c,b,a" {
			t.Fatalf("descending: %v", keys)
		}
		// total 始终是过滤后全量数；Offset 越界返回空但 total 保留
		keys, total, _ = s.List("conf", ListOpts{Offset: 1, Limit: 2})
		if total != 4 || strings.Join(keys, ",") != "b,c" {
			t.Fatalf("offset/limit: %v total=%d", keys, total)
		}
		if keys, total, _ = s.List("conf", ListOpts{Offset: 99}); total != 4 || len(keys) != 0 {
			t.Fatalf("offset beyond: %v total=%d", keys, total)
		}
		// 不存在的 kind：空结果而非错误
		if keys, total, err := s.List("nosuchkind", ListOpts{}); err != nil || total != 0 || keys != nil {
			t.Fatalf("missing kind: %v %d %v", keys, total, err)
		}
	})

	t.Run("Prefix 过滤", func(t *testing.T) {
		s := factory(t)
		for _, k := range []string{"p1a", "p1b", "p2", "q1"} {
			_ = s.Create("conf", k, []byte(`{}`))
		}
		keys, total, _ := s.List("conf", ListOpts{Prefix: "p1"})
		if total != 2 || strings.Join(keys, ",") != "p1a,p1b" {
			t.Fatalf("prefix: %v %d", keys, total)
		}
		if n, _ := s.Count("conf", ListOpts{Prefix: "p1"}); n != 2 {
			t.Fatalf("count prefix: %d", n)
		}
		if n, _ := s.Count("conf", ListOpts{}); n != 4 {
			t.Fatalf("count all: %d", n)
		}
	})

	t.Run("Match 反序列化等值 + 写后失效", func(t *testing.T) {
		s := factory(t)
		_ = s.Create("conf", "m1", []byte(`{"status":"pending","n":1,"ok":true}`))
		_ = s.Create("conf", "m2", []byte(`{"status":"done","n":1,"ok":false}`))
		_ = s.Create("conf", "m3", []byte(`{"status":"pending","n":2,"ok":false}`))

		// 字符串 / 布尔 / 数值（float64）等值过滤
		keys, total, _ := s.List("conf", ListOpts{Match: map[string]any{"status": "pending"}})
		if total != 2 || strings.Join(keys, ",") != "m1,m3" {
			t.Fatalf("match string: %v %d", keys, total)
		}
		if keys, _, _ = s.List("conf", ListOpts{Match: map[string]any{"ok": true}}); strings.Join(keys, ",") != "m1" {
			t.Fatalf("match bool: %v", keys)
		}
		if keys, _, _ = s.List("conf", ListOpts{Match: map[string]any{"n": float64(1), "status": "pending"}}); strings.Join(keys, ",") != "m1" {
			t.Fatalf("match multi/number: %v", keys)
		}
		// 缺字段 = 不匹配
		if keys, _, _ = s.List("conf", ListOpts{Match: map[string]any{"ghost": "x"}}); len(keys) != 0 {
			t.Fatalf("missing field must not match: %v", keys)
		}

		// 写后即时失效缓存：m1 改 status 后不再命中 pending
		_ = s.Update("conf", "m1", []byte(`{"status":"done","n":1,"ok":true}`))
		if keys, total, _ = s.List("conf", ListOpts{Match: map[string]any{"status": "pending"}}); total != 1 || strings.Join(keys, ",") != "m3" {
			t.Fatalf("match must reflect writes immediately: %v %d", keys, total)
		}
		if err := s.Delete("conf", "m3"); err != nil {
			t.Fatal(err)
		}
		if keys, total, _ = s.List("conf", ListOpts{Match: map[string]any{"status": "pending"}}); total != 0 || len(keys) != 0 {
			t.Fatalf("match must reflect deletes immediately: %v %d", keys, total)
		}
	})

	t.Run("键/kind 黑名单校验", func(t *testing.T) {
		s := factory(t)
		bad := []string{"", "a/b", `a\b`, "a:b", ".", "..", "a..b", strings.Repeat("x", 257)}
		for _, k := range bad {
			if err := s.Create("conf", k, []byte(`{}`)); err == nil {
				t.Fatalf("key %q must be rejected", k)
			}
		}
		for _, kind := range bad {
			if err := s.Create(kind, "k", []byte(`{}`)); err == nil {
				t.Fatalf("kind %q must be rejected", kind)
			}
		}
		// 合法形态：中文/空格/下划线/连字符/合法长度。
		// 长度下限取 128（可移植层）：文件实现受 OS 路径总长限制（Windows
		// MAX_PATH 260，key 还要叠加数据目录与 .json/.tmp 后缀），
		// >128 的超长 key 是否接受由实现定义
		for _, k := range []string{"模板 一", "sc_ap_uuid", "a-b_c", strings.Repeat("x", 128)} {
			if err := s.Create("conf", k, []byte(`{}`)); err != nil {
				t.Fatalf("key %q must be accepted: %v", k, err)
			}
		}
	})
}
