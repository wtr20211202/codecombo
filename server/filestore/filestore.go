package filestore

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"codecombo/server/store"
)

type fileDocStore struct {
	dir string
	mu  sync.Map // kind → *sync.RWMutex
	// matchDocs kind → *matchDocsCache：List(Match) 的全量文档缓存。
	// 历史实现每次 Match 查询都读取+反序列化 kind 目录下全部文档
	//（通知/会话/实例等列表接口的每次轮询都是 O(N) 磁盘读）。
	// TTL 3s + 任何写操作即时失效；一致性语义与各 Repo 的 TTL 缓存一致
	matchDocs sync.Map
	// matchFill kind → *sync.Mutex：并发未命中时同一 kind 只有一个 goroutine
	// 做全量回填（double-check 后复用），避免并发 miss 重复整扫
	matchFill sync.Map
}

// matchDocsTTL Match 文档缓存窗口
const matchDocsTTL = 3 * time.Second

type matchDocsCache struct {
	at   time.Time
	docs map[string]map[string]any // key → 反序列化文档
}

// invalidateMatchDocs 任一写操作成功后使该 kind 的 Match 缓存失效
func (s *fileDocStore) invalidateMatchDocs(kind string) {
	s.matchDocs.Delete(kind)
}

// New 创建文件系统实现的 DocumentStore，并清理残留的 .tmp 文件
func New(dir string) store.DocumentStore {
	s := &fileDocStore{dir: dir}
	s.cleanupTmpFiles()
	return s
}

// cleanupTmpFiles 清理所有 kind 子目录中的 .tmp 残留文件
func (s *fileDocStore) cleanupTmpFiles() {
	dataDir := filepath.Join(s.dir, "data")
	entries, err := os.ReadDir(dataDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		kindDir := filepath.Join(dataDir, e.Name())
		files, err := os.ReadDir(kindDir)
		if err != nil {
			continue
		}
		for _, f := range files {
			if strings.HasSuffix(f.Name(), ".tmp") {
				_ = os.Remove(filepath.Join(kindDir, f.Name()))
			}
		}
	}
}

// kindDir 返回 kind 对应的子目录
func (s *fileDocStore) kindDir(kind string) string {
	return filepath.Join(s.dir, "data", kind)
}

// kindMu 返回 kind 对应的读写锁
func (s *fileDocStore) kindMu(kind string) *sync.RWMutex {
	mu := &sync.RWMutex{}
	actual, _ := s.mu.LoadOrStore(kind, mu)
	return actual.(*sync.RWMutex)
}

// validKey 校验文档 key/kind（黑名单语义）：拒绝路径分隔符（/ \）、
// Windows 盘符与 NTFS 流（:）、点开头（隐藏文件/相对段）、连续点（.. 穿越段）、
// 空值与超长（>256）。其余字符一律放行——模板名允许中文/空格，故不用白名单。
func validKey(key string) bool {
	if key == "" || len(key) > 256 {
		return false
	}
	if strings.ContainsAny(key, `/\:`) {
		return false
	}
	if strings.HasPrefix(key, ".") || strings.Contains(key, "..") {
		return false
	}
	return true
}

// keyPath 返回 key 对应的 JSON 文件路径，key/kind 非法时返回错误
func (s *fileDocStore) keyPath(kind, key string) (string, error) {
	if !validKey(kind) || !validKey(key) {
		return "", fmt.Errorf("invalid document kind %q or key %q", kind, key)
	}
	return filepath.Join(s.kindDir(kind), key+".json"), nil
}

// ── 单条操作 ──

func (s *fileDocStore) Create(kind, key string, data []byte) error {
	mu := s.kindMu(kind)
	mu.Lock()
	defer mu.Unlock()
	defer s.lockKindDir(kind)()

	path, err := s.keyPath(kind, key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(s.kindDir(kind), 0755); err != nil {
		return err
	}
	if _, err := os.Stat(path); err == nil {
		return store.ErrAlreadyExists
	}
	if err := atomicWrite(path, data); err != nil {
		return err
	}
	s.invalidateMatchDocs(kind)
	return nil
}

func (s *fileDocStore) Update(kind, key string, data []byte) error {
	mu := s.kindMu(kind)
	mu.Lock()
	defer mu.Unlock()
	defer s.lockKindDir(kind)()

	path, err := s.keyPath(kind, key)
	if err != nil {
		return err
	}
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return store.ErrNotFound
	}
	if err := atomicWrite(path, data); err != nil {
		return err
	}
	s.invalidateMatchDocs(kind)
	return nil
}

func (s *fileDocStore) Patch(kind, key string, patch map[string]any) error {
	mu := s.kindMu(kind)
	mu.Lock()
	defer mu.Unlock()
	defer s.lockKindDir(kind)()

	path, err := s.keyPath(kind, key)
	if err != nil {
		return err
	}
	existing, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return store.ErrNotFound
		}
		return err
	}
	var doc map[string]any
	if err := json.Unmarshal(existing, &doc); err != nil {
		// 损坏文档统一隔离：本就持写锁，就地改名留证后按 ErrNotFound 回落
		// （与 Patch 缺失同语义）；改名失败降级为既有行为（解析错误上抛）
		if s.quarantineInPlace(kind, key, path, "patch") {
			return store.ErrNotFound
		}
		return err
	}
	for k, v := range patch {
		doc[k] = v
	}
	newData, err := json.Marshal(doc)
	if err != nil {
		return err
	}
	if err := atomicWrite(path, newData); err != nil {
		return err
	}
	s.invalidateMatchDocs(kind)
	return nil
}

func (s *fileDocStore) Get(kind, key string) ([]byte, error) {
	data, err := s.readDoc(kind, key)
	if err != nil {
		return nil, err
	}
	if !json.Valid(data) {
		// 损坏文档统一隔离：升写锁改名留证后按 ErrNotFound 回落，与文档缺失
		// 同语义（quarantine.go）；改名失败降级为原样返回坏字节——与既有行为
		// 一致，调用方解析时自会报错。json.Valid 是 O(len) 纯语法扫描且无分配，
		// 文档均为 KB 量级，相对磁盘读可忽略
		if s.quarantineCorrupt(kind, key, "get") {
			return nil, store.ErrNotFound
		}
	}
	return data, nil
}

// readDoc RLock 下读单个文档原始字节（隔离升写锁前须先释放 RLock，故拆出）
func (s *fileDocStore) readDoc(kind, key string) ([]byte, error) {
	mu := s.kindMu(kind)
	mu.RLock()
	defer mu.RUnlock()

	path, err := s.keyPath(kind, key)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, store.ErrNotFound
		}
		return nil, err
	}
	return data, nil
}

func (s *fileDocStore) Delete(kind, key string) error {
	mu := s.kindMu(kind)
	mu.Lock()
	defer mu.Unlock()
	defer s.lockKindDir(kind)()

	path, err := s.keyPath(kind, key)
	if err != nil {
		return err
	}
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return store.ErrNotFound
	}
	if err := os.Remove(path); err != nil {
		return err
	}
	s.invalidateMatchDocs(kind)
	return nil
}

func (s *fileDocStore) Has(kind, key string) (bool, error) {
	mu := s.kindMu(kind)
	mu.RLock()
	defer mu.RUnlock()

	path, err := s.keyPath(kind, key)
	if err != nil {
		return false, err
	}
	_, err = os.Stat(path)
	if err == nil {
		return true, nil
	}
	if os.IsNotExist(err) {
		return false, nil
	}
	return false, err
}

// Upsert 存在即 Update 否则 Create：repo 层三步 upsert 样板的单方法收口
// （P-20261006-42）。复用 Has/Update/Create 原样分派而非单锁直写——Has 的
// error 按不存在处理与被收编样板 has, _ := 语义逐字一致（接口契约，见
// store.DocumentStore.Upsert），非法 kind/key 的键校验错误从 Create/Update
// 冒出，不静默丢写；各 repo 自持互斥锁，这里的 Has/写两段间无并发窗口
func (s *fileDocStore) Upsert(kind, key string, data []byte) error {
	has, _ := s.Has(kind, key)
	if has {
		return s.Update(kind, key, data)
	}
	return s.Create(kind, key, data)
}

// ── 批量操作 ──

func (s *fileDocStore) GetBatch(kind string, keys []string) (map[string][]byte, error) {
	result, corrupt, err := s.getBatchScan(kind, keys)
	if err != nil {
		return nil, err
	}
	if len(corrupt) > 0 {
		corruptKeys := make([]string, 0, len(corrupt))
		for key := range corrupt {
			corruptKeys = append(corruptKeys, key)
		}
		// 损坏文档统一隔离（成功者从结果剔除=not-found 回落）；改名失败者
		// 原样回填坏字节——与既有行为一致，不因隔离失败阻断读
		quarantined := s.quarantineBatch(kind, corruptKeys, "get-batch")
		for key, data := range corrupt {
			if !quarantined[key] {
				result[key] = data
			}
		}
	}
	return result, nil
}

// getBatchScan RLock 下批量读原始字节；非法 JSON 者从结果剔除并随 corrupt
// 返回待隔离（升写锁前须先释放 RLock，故与隔离分两步）
func (s *fileDocStore) getBatchScan(kind string, keys []string) (result map[string][]byte, corrupt map[string][]byte, err error) {
	mu := s.kindMu(kind)
	mu.RLock()
	defer mu.RUnlock()

	result = make(map[string][]byte, len(keys))
	for _, key := range keys {
		path, err := s.keyPath(kind, key)
		if err != nil {
			return nil, nil, err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		if !json.Valid(data) {
			if corrupt == nil {
				corrupt = make(map[string][]byte)
			}
			corrupt[key] = data
			continue
		}
		result[key] = data
	}
	return result, corrupt, nil
}

func (s *fileDocStore) CreateBatch(kind string, items map[string][]byte) error {
	mu := s.kindMu(kind)
	mu.Lock()
	defer mu.Unlock()
	defer s.lockKindDir(kind)()

	// 先校验全部 key 再建目录写文件，避免非法 key 中途失败留下空 kind 目录
	paths := make(map[string]string, len(items))
	for key := range items {
		path, err := s.keyPath(kind, key)
		if err != nil {
			return err
		}
		paths[key] = path
	}
	if err := os.MkdirAll(s.kindDir(kind), 0755); err != nil {
		return err
	}
	for key, data := range items {
		// 与 Create 同语义：已存在即拒绝，不静默覆盖（conformance 契约）
		if _, err := os.Stat(paths[key]); err == nil {
			return store.ErrAlreadyExists
		}
		if err := atomicWrite(paths[key], data); err != nil {
			return err
		}
	}
	s.invalidateMatchDocs(kind)
	return nil
}

func (s *fileDocStore) UpdateBatch(kind string, items map[string][]byte) error {
	mu := s.kindMu(kind)
	mu.Lock()
	defer mu.Unlock()
	defer s.lockKindDir(kind)()

	for key, data := range items {
		path, err := s.keyPath(kind, key)
		if err != nil {
			return err
		}
		if _, err := os.Stat(path); os.IsNotExist(err) {
			return store.ErrNotFound
		}
		if err := atomicWrite(path, data); err != nil {
			return err
		}
	}
	s.invalidateMatchDocs(kind)
	return nil
}

func (s *fileDocStore) PatchBatch(kind string, patches map[string]map[string]any) error {
	mu := s.kindMu(kind)
	mu.Lock()
	defer mu.Unlock()
	defer s.lockKindDir(kind)()

	for key, patch := range patches {
		path, err := s.keyPath(kind, key)
		if err != nil {
			return err
		}
		if err := s.patchFile(kind, key, path, patch); err != nil {
			return err
		}
	}
	s.invalidateMatchDocs(kind)
	return nil
}

func (s *fileDocStore) DeleteBatch(kind string, keys []string) error {
	mu := s.kindMu(kind)
	mu.Lock()
	defer mu.Unlock()
	defer s.lockKindDir(kind)()

	for _, key := range keys {
		path, err := s.keyPath(kind, key)
		if err != nil {
			return err
		}
		os.Remove(path) // 忽略不存在错误
	}
	s.invalidateMatchDocs(kind)
	return nil
}

func (s *fileDocStore) Clear(kind string) error {
	if !validKey(kind) {
		return fmt.Errorf("invalid document kind: %q", kind)
	}
	mu := s.kindMu(kind)
	mu.Lock()
	defer mu.Unlock()
	defer s.lockKindDir(kind)()

	if err := os.RemoveAll(s.kindDir(kind)); err != nil {
		return err
	}
	s.invalidateMatchDocs(kind)
	return nil
}

// ── 查询操作 ──

func (s *fileDocStore) List(kind string, opts store.ListOpts) ([]string, int, error) {
	if !validKey(kind) {
		return nil, 0, fmt.Errorf("invalid document kind: %q", kind)
	}
	keys, corrupt, err := s.listScan(kind, opts)
	if err != nil {
		return nil, 0, err
	}
	// 损坏文档统一隔离：扫描阶段只跳过（既有语义），升写锁后整批改名留证 +
	// 一条汇总 Warn（quarantine.go）——扫描持 RLock、改名须写锁，不能原地升锁
	if len(corrupt) > 0 {
		s.quarantineBatch(kind, corrupt, "list")
	}

	// total = 过滤后、分页前的总数（既有契约）
	total := len(keys)

	// Sort：默认按 key 字母序
	sort.Strings(keys)
	if opts.Sort.Descending {
		sort.Sort(sort.Reverse(sort.StringSlice(keys)))
	}

	// Offset/Limit
	if opts.Offset > 0 {
		if opts.Offset >= len(keys) {
			return nil, total, nil
		}
		keys = keys[opts.Offset:]
	}
	if opts.Limit > 0 && opts.Limit < len(keys) {
		keys = keys[:opts.Limit]
	}

	return keys, total, nil
}

// listScan RLock 下枚举 + Prefix/Match 过滤（损坏文档只跳过不隔离——改名须写锁，
// 收集后交由调用方在锁外整批 quarantineBatch），返回过滤后键集与损坏 key 列表
func (s *fileDocStore) listScan(kind string, opts store.ListOpts) (keys []string, corrupt []string, _ error) {
	mu := s.kindMu(kind)
	mu.RLock()
	defer mu.RUnlock()

	entries, err := os.ReadDir(s.kindDir(kind))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil, nil
		}
		return nil, nil, err
	}

	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		key := strings.TrimSuffix(e.Name(), ".json")
		keys = append(keys, key)
	}

	// Prefix 过滤
	if opts.Prefix != "" {
		filtered := keys[:0]
		for _, k := range keys {
			if strings.HasPrefix(k, opts.Prefix) {
				filtered = append(filtered, k)
			}
		}
		keys = filtered
	}

	// Match 过滤（内存扫描）：命中缓存时零磁盘读；未命中经 per-kind 填充锁
	// 收敛并发未命中（double-check 后单 goroutine 回填），其余直接复用
	if len(opts.Match) > 0 {
		docs := func() map[string]map[string]any {
			if c, ok := s.matchDocs.Load(kind); ok {
				if cache := c.(*matchDocsCache); time.Since(cache.at) < matchDocsTTL {
					return cache.docs
				}
			}
			fill, _ := s.matchFill.LoadOrStore(kind, &sync.Mutex{})
			fill.(*sync.Mutex).Lock()
			defer fill.(*sync.Mutex).Unlock()
			// 双检：等锁期间可能已被并发回填
			if c, ok := s.matchDocs.Load(kind); ok {
				if cache := c.(*matchDocsCache); time.Since(cache.at) < matchDocsTTL {
					return cache.docs
				}
			}
			fresh := make(map[string]map[string]any, len(keys))
			for _, k := range keys {
				path, err := s.keyPath(kind, k)
				if err != nil {
					continue
				}
				data, err := os.ReadFile(path)
				if err != nil {
					continue
				}
				var doc map[string]any
				if err := json.Unmarshal(data, &doc); err != nil {
					// 损坏文档：跳过（既有语义=不参与 Match），收集待隔离
					corrupt = append(corrupt, k)
					continue
				}
				fresh[k] = doc
			}
			s.matchDocs.Store(kind, &matchDocsCache{at: time.Now(), docs: fresh})
			return fresh
		}()

		filtered := keys[:0]
		for _, k := range keys {
			doc, ok := docs[k]
			if !ok {
				continue
			}
			match := true
			for field, want := range opts.Match {
				if doc[field] != want {
					match = false
					break
				}
			}
			if match {
				filtered = append(filtered, k)
			}
		}
		keys = filtered
	}

	return keys, corrupt, nil
}

func (s *fileDocStore) Count(kind string, opts store.ListOpts) (int, error) {
	if !validKey(kind) {
		return 0, fmt.Errorf("invalid document kind: %q", kind)
	}
	mu := s.kindMu(kind)
	mu.RLock()
	defer mu.RUnlock()

	entries, err := os.ReadDir(s.kindDir(kind))
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}

	count := 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		if opts.Prefix != "" && !strings.HasPrefix(strings.TrimSuffix(e.Name(), ".json"), opts.Prefix) {
			continue
		}
		count++
	}
	return count, nil
}

// ── 工具函数 ──

// atomicWrite tmp+rename 原子替换。rename 前对 tmp fsync：无 fsync 时文件
// 系统可能先持久化目录项（rename）后持久化数据块，崩溃恢复后目标文档存在
// 但内容截断为空；fsync 保证 rename 可见时数据已落盘
func atomicWrite(path string, data []byte) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

func (s *fileDocStore) patchFile(kind, key, path string, patch map[string]any) error {
	existing, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return store.ErrNotFound
		}
		return err
	}
	var doc map[string]any
	if err := json.Unmarshal(existing, &doc); err != nil {
		// 损坏文档统一隔离：同 Patch，本就持写锁，就地改名留证后按 ErrNotFound
		// 回落（与 PatchBatch 缺失同语义）；改名失败降级为既有行为
		if s.quarantineInPlace(kind, key, path, "patch-batch") {
			return store.ErrNotFound
		}
		return err
	}
	for k, v := range patch {
		doc[k] = v
	}
	newData, err := json.Marshal(doc)
	if err != nil {
		return err
	}
	return atomicWrite(path, newData)
}
