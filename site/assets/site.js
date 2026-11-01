// site.js —— Codecombo 官网单页交互（P-20261101-1）。原生 JS，无依赖。
// 三件事：①双语切换（html[data-lang] + localStorage 记忆 + ?lang= 查询参数
// 入口——hreflang 的 zh 变体即靠它落地）；②下载按钮 OS 维度平台探测（评审
// 修正版：Chrome UA 不暴露 CPU 架构，只做 OS 三路 + 默认 amd64，ARM 用户走
// 「全部平台」下拉显式选；移动端/未知 UA 回落 Releases 页）；③语言态回写
// aria-pressed 与若干双语 alt（无障碍）。
(function () {
  'use strict'

  var LANG_KEY = 'codecombo-site-lang'
  var html = document.documentElement

  function setLang(lang, persist) {
    lang = lang === 'zh' ? 'zh' : 'en'
    html.setAttribute('data-lang', lang)
    html.setAttribute('lang', lang === 'zh' ? 'zh-CN' : 'en')
    var btns = document.querySelectorAll('.lang-btn')
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', btns[i].getAttribute('data-lang-set') === lang ? 'true' : 'false')
    }
    if (persist) {
      try { localStorage.setItem(LANG_KEY, lang) } catch (e) { /* 隐私模式下记忆失败可接受 */ }
    }
  }

  // 初始语言优先级：?lang= 显式入参 > 本地记忆 > 浏览器语言（zh 开头给中文）。
  // 无 JS 时 CSS 缺省显示英文（SEO 默认），故探测到中文环境时这里主动切一次。
  var initial = 'en'
  try {
    var qs = new URLSearchParams(window.location.search).get('lang')
    var stored = localStorage.getItem(LANG_KEY)
    if (qs) initial = qs.indexOf('zh') === 0 ? 'zh' : 'en'
    else if (stored) initial = stored
    else if ((navigator.language || '').toLowerCase().indexOf('zh') === 0) initial = 'zh'
  } catch (e) { /* 存储不可用回落默认英文 */ }
  setLang(initial, false)

  var btns = document.querySelectorAll('.lang-btn')
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener('click', function () {
      setLang(this.getAttribute('data-lang-set'), true)
    })
  }

  // ---------- 平台探测下载（OS 维度 + 默认 amd64） ----------
  // 资产名与 build.sh 6 目标一致：codecombo-<os>-<arch>[.exe]；
  // releases/latest/download/<asset> 恒指向最新版资产（GitHub 302 到具体版本）。
  // 移动端先行判定：iOS UA 含「like Mac OS X」、Android UA 含 Linux——
  // 桌面三路之前先排除，否则手机会被误配 darwin/linux 安装包。
  var RELEASES = 'https://github.com/wtr20211202/codecombo/releases'
  var ua = navigator.userAgent || ''
  var os = null
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) os = null
  else if (/Windows|Win32|WOW64/i.test(ua)) os = 'windows'
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'darwin'
  else if (/Linux|X11/i.test(ua)) os = 'linux'

  var primary = document.getElementById('dl-primary')
  if (primary && os) {
    var arch = 'amd64'
    var ext = os === 'windows' ? '.exe' : ''
    primary.href = RELEASES + '/latest/download/codecombo-' + os + '-' + arch + ext
    var osLabel = document.getElementById('dl-os')
    var osLabelZh = document.getElementById('dl-os-zh')
    var names = { windows: ['Windows', 'Windows'], darwin: ['macOS', 'macOS'], linux: ['Linux', 'Linux'] }
    if (osLabel) osLabel.textContent = names[os][0]
    if (osLabelZh) osLabelZh.textContent = names[os][1]
  }
  // 未知 UA / 移动端：primary 保持 Releases 页链接（HTML 初始值），不猜平台。

  // 点击「全部平台」外区域收起下拉（details 原生不收）
  document.addEventListener('click', function (ev) {
    var details = document.querySelector('.dl-all')
    if (details && details.open && !details.contains(ev.target)) details.open = false
  })
})()
