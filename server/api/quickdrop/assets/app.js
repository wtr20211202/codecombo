/*!
 * Codecombo 快投递访客页脚本（P-20261117-2-S2）
 *
 * 交付形态：外链同源静态 JS（/drop/assets/app.js，主引擎精确名路由伺服）——
 * 投递页 enforcing CSP `script-src 'self'` 下唯一允许的脚本面（内联脚本与
 * 内联事件处理器一律不可用，本文件全部用 addEventListener 接线）。
 *
 * 职责（urlencoded 原生 form 在 JS 缺席/失败时仍可用——303 PRG 人面并存）：
 *   ① 暂存式交互：拖入/粘贴/多选进暂存清单（缩略图 + 逐项可删 + 总量与
 *      2GB 配额余量展示，超限即时拒绝在暂存侧完成，不发起请求）；
 *   ② 点「投递」发起单批 multipart XHR：onprogress 驱动进度百分比与速率；
 *   ③ 右上角常驻角标：上传中显示进度，历史记录读 localStorage
 *      （sc.drop.history 单键 JSON 数组，纯本地，多访客互不可见）；
 *   ④ 投递结果逐文件错误态：服务端 added[] kind=rejected 占位与 S1 错误码
 *      契约 too_large/drop_quota 进文案分支；
 *   ⑤ 主题切换（P-20261120-1）：initTheme 读 sc.share.theme 设 data-theme
 *      （与 share 访客页族跨页共享偏好），投递页头部挂双语标签切换器，
 *      404 页只读偏好零切换器（slot 缺席 null-guard）。
 *
 * 客户端限额与服务端（server/api/quickdrop/files.go）对齐：单批 20、图片
 * 10MB、文件 200MB、总量 2GB。客户端是预闸（即时反馈），服务端是权威
 * （扩展名白名单/敏感名/配额只在服务端判——响应 added[] 据此回填失败位）。
 */
(function () {
  'use strict'

  var MAX_BATCH = 20
  var MAX_FILE_BYTES = 200 * 1024 * 1024
  var MAX_IMAGE_BYTES = 10 * 1024 * 1024
  var MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

  // 历史记录键：sc.<域>.<含义> 约定（web/src/persistence/uiStateLanes.json
  // ls.drop.history 行登记——本文件随 Go 二进制 embed，键面在 web/src 扫描
  // 之外，键名变更须同步该登记行）。单键 JSON 数组（sc.quickdrop.url 单键
  // 载荷先例），纯设备本地，清缓存即消。
  var HISTORY_KEY = 'sc.drop.history'
  var HISTORY_CAP = 20

  // ── 主题切换（P-20261120-1）：与 share 访客页族同表同键——sc.share.theme
  // 跨页共享偏好（文件/终端/会话页选过的主题投递页自动记住，反之亦然；
  // uiStateLanes.json ls.share.theme externalKey 登记）。CSP 零内联纪律：
  // 本段全部住本文件（page_s2_test「无内联脚本」守卫保持）；标签双语硬编码
  // 与页面既有双语形态同款。404 页零切换器只读偏好（initTheme 照常执行，
  // slot 缺席 null-guard 跳过）──
  var THEME_KEY = 'sc.share.theme'
  var THEMES = [
    ['auto', '跟随系统 Auto'],
    ['light', '浅色 Light'],
    ['dark', '深色 Dark'],
    ['one-dark', 'One Dark'],
    ['dracula', 'Dracula']
  ]

  function applyTheme(name) {
    var known = false
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i][0] === name) known = true
    if (!known) name = 'auto'
    document.documentElement.dataset.theme = name
    // sc:themechange：与 share 访客页注入件同款事件语义（本页无监听方，
    // 派发保持事件词表跨页一致）
    try {
      document.dispatchEvent(new CustomEvent('sc:themechange', { detail: { theme: name } }))
    } catch (e) { /* 无 CustomEvent 环境：切换仍生效 */ }
  }

  function initTheme() {
    var saved = null
    try { saved = localStorage.getItem(THEME_KEY) } catch (e) { saved = null }
    applyTheme(saved || 'auto')
  }

  function buildThemeSelect() {
    var sel = document.createElement('select')
    sel.className = 'theme-select'
    sel.title = '主题 / Theme'
    sel.setAttribute('aria-label', '主题 / Theme')
    for (var i = 0; i < THEMES.length; i++) {
      var opt = document.createElement('option')
      opt.value = THEMES[i][0]
      opt.textContent = THEMES[i][1]
      sel.appendChild(opt)
    }
    try { sel.value = localStorage.getItem(THEME_KEY) || 'auto' } catch (e) { sel.value = 'auto' }
    sel.addEventListener('change', function () {
      applyTheme(sel.value)
      try { localStorage.setItem(THEME_KEY, sel.value) } catch (e) { /* 隐私模式：偏好尽力而为 */ }
    })
    return sel
  }

  function $(id) { return document.getElementById(id) }

  function fmtSize(n) {
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB'
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n }

  function fmtTime(ts) {
    var d = new Date(ts)
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
  }

  // ── 暂存清单 ──

  var staged = [] // { file, name, size, thumb, error }
  var uploading = false

  function isImage(file) { return /^image\//.test(file.type || '') }

  // 单文件限额预闸（图片按 MIME 10MB、其余 200MB）；返回 null=通过，否则拒绝原因
  function sizeLimitFor(file) {
    return isImage(file) ? MAX_IMAGE_BYTES : MAX_FILE_BYTES
  }

  function stagedTotal() {
    var t = 0
    for (var i = 0; i < staged.length; i++) t += staged[i].size
    return t
  }

  function addFiles(files) {
    var rejected = []
    for (var i = 0; i < files.length; i++) {
      var f = files[i]
      var name = f.name || ''
      // 粘贴的截图常是无名 image：按 pasteFiles.ts 先例给「截图-时间」名
      if (isImage(f) && (!name || name === 'image.png' || /blob/.test(name))) {
        var d = new Date()
        name = 'screenshot-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
          '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.png'
      }
      var item = { file: f, name: name, size: f.size || 0, thumb: null, error: '' }
      var limit = sizeLimitFor(f)
      if (item.size > limit) {
        rejected.push(name + '（' + fmtSize(item.size) + ' > ' + fmtSize(limit) + '）')
        continue
      }
      if (staged.length + rejected.length >= MAX_BATCH) {
        rejected.push(name + '（单批最多 ' + MAX_BATCH + ' 个）')
        continue
      }
      if (stagedTotal() + item.size > MAX_TOTAL_BYTES) {
        rejected.push(name + '（超出 2GB 配额余量）')
        continue
      }
      if (isImage(f) && typeof URL !== 'undefined' && URL.createObjectURL) {
        try { item.thumb = URL.createObjectURL(f) } catch (e) { item.thumb = null }
      }
      staged.push(item)
    }
    if (rejected.length) {
      showMsg('以下文件未加入暂存：' + rejected.join('、'), true)
    }
    renderStaged()
  }

  function removeStaged(idx) {
    var item = staged[idx]
    if (item && item.thumb) { try { URL.revokeObjectURL(item.thumb) } catch (e) { /* noop */ } }
    staged.splice(idx, 1)
    renderStaged()
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    })
  }

  function renderStaged() {
    var list = $('qd-staged-list')
    var empty = $('qd-staged-empty')
    if (!list) return
    while (list.firstChild) list.removeChild(list.firstChild)
    var hasItems = staged.length > 0
    if (empty) empty.style.display = hasItems ? 'none' : ''
    for (var i = 0; i < staged.length; i++) {
      var s = staged[i]
      var li = document.createElement('li')
      li.className = 'qd-item' + (s.error ? ' qd-item-err' : '')
      li.setAttribute('data-testid', 'qd-staged-item')
      var thumbHTML = s.thumb
        ? '<img class="qd-thumb" src="' + s.thumb + '" alt="">'
        : '<span class="qd-thumb qd-thumb-icon"' +
          (isImage(s.file) ? '' : ' data-icon="file"') + '></span>'
      li.innerHTML =
        thumbHTML +
        '<span class="qd-item-main"><span class="qd-item-name">' + esc(s.name) + '</span>' +
        '<span class="qd-item-size">' + fmtSize(s.size) +
        (s.error ? ' · ' + esc(s.error) : '') + '</span></span>' +
        '<button type="button" class="qd-item-del" data-testid="qd-item-del" aria-label="移除">' +
        '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>'
      ;(function (idx) {
        li.querySelector('.qd-item-del').addEventListener('click', function () { removeStaged(idx) })
      })(i)
      list.appendChild(li)
    }
    var summary = $('qd-staged-summary')
    if (summary) {
      summary.textContent = hasItems
        ? staged.length + ' 个文件 · 共 ' + fmtSize(stagedTotal()) +
          ' · 配额余量 ' + fmtSize(Math.max(0, MAX_TOTAL_BYTES - stagedTotal()))
        : ''
    }
    var btn = $('qd-send')
    if (btn) btn.disabled = uploading
  }

  // ── 输入三通道：多选 input / 拖拽 / 粘贴 ──

  function wireInput() {
    var input = $('qd-file-input')
    var zone = $('qd-dropzone')
    if (input && zone) {
      input.addEventListener('change', function () {
        addFiles(Array.prototype.slice.call(input.files || []))
        input.value = ''
      })
      zone.addEventListener('click', function () { input.click() })
      // dropzone 声明 role=button：键盘激活（Enter/Space）与点击同义
      zone.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          input.click()
        }
      })
    }
    if (zone) {
      zone.addEventListener('dragover', function (e) {
        e.preventDefault()
        zone.classList.add('qd-over')
      })
      zone.addEventListener('dragleave', function () { zone.classList.remove('qd-over') })
      zone.addEventListener('drop', function (e) {
        e.preventDefault()
        e.stopPropagation()
        zone.classList.remove('qd-over')
        addFiles(Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []))
      })
    }
    // 单页投递面：页面级拖放默认行为（浏览器打开文件）整面关闭
    document.addEventListener('dragover', function (e) { e.preventDefault() })
    document.addEventListener('drop', function (e) { e.preventDefault() })
    document.addEventListener('paste', function (e) {
      var cd = e.clipboardData
      if (!cd) return
      var files = Array.prototype.slice.call(cd.files || [])
      if (!files.length && cd.items) {
        for (var i = 0; i < cd.items.length; i++) {
          if (cd.items[i].kind === 'file') {
            var f = cd.items[i].getAsFile()
            if (f) files.push(f)
          }
        }
      }
      if (files.length) {
        e.preventDefault()
        addFiles(files)
      }
    })
  }

  // ── 历史记录（纯本地） ──

  function loadHistory() {
    try {
      var raw = localStorage.getItem(HISTORY_KEY)
      if (!raw) return []
      var arr = JSON.parse(raw)
      if (!Array.isArray(arr)) return []
      var out = []
      for (var i = 0; i < arr.length; i++) {
        var it = arr[i]
        // 形状防御：损坏/旧形状条目丢弃不炸面板
        if (it && typeof it.t === 'number' && typeof it.r === 'string') {
          out.push({ t: it.t, n: String(it.n || ''), s: Number(it.s) || 0, r: it.r })
        }
      }
      return out
    } catch (e) {
      return [] // 隐私模式/损坏 JSON：静默空态
    }
  }

  function saveHistory(entry) {
    var arr = loadHistory()
    arr.unshift(entry)
    if (arr.length > HISTORY_CAP) arr = arr.slice(0, HISTORY_CAP)
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(arr)) } catch (e) { /* 配额满/隐私模式：记录是尽力而为面 */ }
  }

  function clearHistory() {
    try { localStorage.removeItem(HISTORY_KEY) } catch (e) { /* noop */ }
    renderHistoryBadge()
    renderHistoryPanel()
  }

  function renderHistoryBadge() {
    var badge = $('qd-history-badge')
    if (!badge) return
    var arr = loadHistory()
    badge.hidden = arr.length === 0
    var count = badge.querySelector('.qd-badge-count')
    if (count) count.textContent = String(arr.length)
  }

  function renderHistoryPanel() {
    var listEl = $('qd-history-list')
    if (!listEl) return
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild)
    var arr = loadHistory()
    var emptyEl = $('qd-history-empty')
    if (emptyEl) emptyEl.hidden = arr.length > 0
    for (var i = 0; i < arr.length; i++) {
      var h = arr[i]
      var li = document.createElement('li')
      li.className = 'qd-hist-item qd-hist-' + h.r
      li.setAttribute('data-testid', 'qd-hist-item')
      li.innerHTML =
        '<span class="qd-hist-dot" aria-hidden="true"></span>' +
        '<span class="qd-hist-main"><span class="qd-hist-time">' + fmtTime(h.t) + '</span>' +
        '<span class="qd-hist-name">' + esc(h.n) + '</span></span>' +
        '<span class="qd-hist-size">' + fmtSize(h.s) + '</span>'
      listEl.appendChild(li)
    }
  }

  function namesBrief(names) {
    var brief = names.slice(0, 3).join('、')
    if (names.length > 3) brief += ' 等 ' + names.length + ' 个'
    return brief
  }

  // ── 消息条（JS 侧反馈；服务端 .err 横幅独立，互不覆盖） ──

  var msgTimer = null
  function showMsg(text, isErr) {
    var el = $('qd-msg')
    if (!el) return
    el.textContent = text
    el.className = 'qd-msg ' + (isErr ? 'qd-msg-err' : 'qd-msg-ok')
    el.hidden = false
    if (msgTimer) clearTimeout(msgTimer)
    if (!isErr) msgTimer = setTimeout(function () { el.hidden = true }, 6000)
  }

  // ── 进度面 ──

  function setProgress(pct, rateBps, loaded, total) {
    var wrap = $('qd-progress')
    if (!wrap) return
    wrap.hidden = false
    var bar = $('qd-progress-bar')
    if (bar) bar.style.width = Math.min(100, Math.max(0, pct)) + '%'
    var label = $('qd-progress-label')
    if (label) {
      label.textContent = pct.toFixed(0) + '%' +
        (rateBps > 0 ? ' · ' + fmtSize(rateBps) + '/s' : '') +
        (total > 0 ? ' · ' + fmtSize(loaded) + ' / ' + fmtSize(total) : '')
    }
    var badge = $('qd-upload-badge')
    if (badge) {
      badge.hidden = false
      var b = badge.querySelector('.qd-badge-progress')
      if (b) b.textContent = pct.toFixed(0) + '%'
    }
  }

  function hideProgress(ok) {
    var wrap = $('qd-progress')
    if (wrap) wrap.hidden = true
    var badge = $('qd-upload-badge')
    if (badge) badge.hidden = true
    if (ok) setProgress(0, 0, 0, 0) // 复位进度条宽度
    var bar = $('qd-progress-bar')
    if (bar && ok) bar.style.width = '0%'
  }

  // ── 提交（单批 multipart XHR） ──

  function markRejectedByServer(added) {
    // added[] kind=rejected 占位与暂存项按名对齐（服务端净化名可能改写，
    // 以服务端名为准回填失败位）
    for (var i = 0; i < added.length; i++) {
      if (added[i] && added[i].kind === 'rejected') {
        for (var j = 0; j < staged.length; j++) {
          if (staged[j].name === added[i].name) {
            staged[j].error = '被拒收（白名单外或超档）'
          }
        }
      }
    }
    renderStaged()
  }

  function wireSubmit() {
    var form = $('qd-form')
    if (!form) return
    form.addEventListener('submit', function (e) {
      e.preventDefault()
      if (uploading) return
      var textarea = $('content')
      var text = textarea ? textarea.value.trim() : ''
      var active = staged.filter(function (s) { return !s.error })
      if (!text && active.length === 0) {
        // 校验传达（P-20261118-8）：拦截条件不变（内容与文件至少一项），
        // 文案显性说出「至少一项」——旧措辞被用户误读为「文件必须」，劝退
        // 只发文字的真实场景；page_s2_test.go 钉旧串不残留，注释亦不引用
        showMsg('内容与文件至少填写一项即可投递 / Add text or files — at least one is required', true)
        return
      }
      var fd = new FormData()
      if (textarea && textarea.value) fd.append('content', textarea.value)
      for (var i = 0; i < active.length; i++) {
        fd.append('files', active[i].file, active[i].name)
      }

      uploading = true
      renderStaged()
      var btn = $('qd-send')
      if (btn) btn.disabled = true
      // 提交即显 0% 进度面（操作即时反馈；本地上传快到 onprogress 一闪而过
      // 时也保证「已在上传」的状态可见——停滞感知：0% 停住即上传未推进）
      setProgress(0, 0, 0, 0)

      var xhr = new XMLHttpRequest()
      xhr.open('POST', location.pathname)
      var lastLoaded = 0
      var lastTime = Date.now()
      var lastRate = 0
      xhr.upload.onprogress = function (ev) {
        if (!ev.lengthComputable) return
        var now = Date.now()
        if (now > lastTime) {
          var inst = (ev.loaded - lastLoaded) / (now - lastTime) * 1000
          // 速率平滑（0.5 权重）防进度事件抖动跳变
          lastRate = lastRate > 0 ? Math.round(lastRate * 0.5 + inst * 0.5) : Math.round(inst)
        }
        lastLoaded = ev.loaded
        lastTime = now
        setProgress(ev.loaded / ev.total * 100, lastRate, ev.loaded, ev.total)
      }
      xhr.onload = function () {
        uploading = false
        if (btn) btn.disabled = false
        var names = active.map(function (s) { return s.name })
        var total = 0
        for (var k = 0; k < active.length; k++) total += active[k].size
        // 响应体尽量解一次（200 成功契约与 400 全拒契约都带 added[]）
        var data = null
        try { data = JSON.parse(xhr.responseText) } catch (e2) { data = null }
        var code = (data && typeof data.error === 'string') ? data.error : ''
        var rejectedNames = []
        if (data && Array.isArray(data.added)) {
          for (var m = 0; m < data.added.length; m++) {
            if (data.added[m] && data.added[m].kind === 'rejected') rejectedNames.push(data.added[m].name)
          }
        }
        if (xhr.status === 200 && rejectedNames.length === 0) {
          hideProgress(true)
          saveHistory({ t: Date.now(), n: namesBrief(names.length ? names : ['文本投递']), s: total, r: 'ok' })
          // PRG：回成功态（刷新不重投——与 urlencoded 表单 303 同语义）
          location.replace(location.pathname + '?sent=1')
          return
        }
        hideProgress(false)
        if (xhr.status === 200) {
          // 部分可达照收 + 逐文件占位（S1 契约：不搞全批回滚）——历史记 partial 位
          markRejectedByServer(data ? data.added : [])
          var acceptedCount = names.length - rejectedNames.length
          saveHistory({ t: Date.now(), n: namesBrief(names), s: total, r: acceptedCount > 0 ? 'partial' : 'fail' })
          renderHistoryBadge()
          renderHistoryPanel()
          if (acceptedCount > 0) {
            showMsg('已投递 ' + acceptedCount + ' 个文件；被拒收：' + rejectedNames.join('、') + '（白名单外或超档）', true)
          } else {
            showMsg('全部文件被拒收（白名单外或超档）/ All files rejected', true)
          }
          return
        }
        saveHistory({ t: Date.now(), n: namesBrief(names.length ? names : ['文本投递']), s: total, r: 'fail' })
        renderHistoryBadge()
        renderHistoryPanel()
        if (xhr.status === 400 && code === 'content or files required' && rejectedNames.length > 0) {
          // 全部文件被拒 + 无文本可入账：400 契约带逐文件占位
          markRejectedByServer(data ? data.added : [])
          showMsg('全部文件被拒收（白名单外或超档）/ All files rejected', true)
          return
        }
        if (xhr.status === 413 && code === 'drop_quota') {
          showMsg('收件配额已满（2GB）：请移除部分文件或联系主人清理 / Recipient quota full', true)
        } else if (xhr.status === 413) {
          showMsg('内容过大：文本 ≤4KB、图片 ≤10MB、文件 ≤200MB / Content too large', true)
        } else if (xhr.status === 404) {
          showMsg('链接已失效或被撤销 / Link invalid or revoked', true)
        } else {
          showMsg('投递失败（' + (xhr.status || '网络') + '），请重试 / Delivery failed, retry', true)
        }
      }
      xhr.onerror = function () {
        // status 0：连接中断（服务端中途截断/断网）——MaxBytesReader 越界的
        // 服务端表现之一
        uploading = false
        if (btn) btn.disabled = false
        hideProgress(false)
        saveHistory({ t: Date.now(), n: namesBrief(staged.map(function (s) { return s.name })), s: stagedTotal(), r: 'fail' })
        renderHistoryBadge()
        renderHistoryPanel()
        showMsg('连接中断：上传未完成，请检查网络后重试 / Connection interrupted', true)
      }
      xhr.send(fd)
    })
  }

  // ── 装配 ──

  function init() {
    initTheme()
    var themeSlot = $('qd-theme-slot')
    if (themeSlot) themeSlot.appendChild(buildThemeSelect())
    wireInput()
    wireSubmit()
    renderStaged()
    renderHistoryBadge()
    renderHistoryPanel()
    var badge = $('qd-history-badge')
    if (badge) {
      badge.addEventListener('click', function () {
        var panel = $('qd-history-panel')
        if (!panel) return
        panel.hidden = !panel.hidden
        if (!panel.hidden) renderHistoryPanel()
      })
    }
    var clearBtn = $('qd-history-clear')
    if (clearBtn) clearBtn.addEventListener('click', clearHistory)
    window.addEventListener('pagehide', function () {
      for (var i = 0; i < staged.length; i++) {
        if (staged[i].thumb) { try { URL.revokeObjectURL(staged[i].thumb) } catch (e) { /* noop */ } }
      }
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
