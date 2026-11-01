<script setup lang="ts">
import CommandPalette from '@/components/search/CommandPalette.vue'
import ProjectSearch from '@/components/search/ProjectSearch.vue'
import TerminalHistorySearchPopover from '@/components/search/TerminalHistorySearchPopover.vue'
import TerminalOutputSearchPopover from '@/components/search/TerminalOutputSearchPopover.vue'
import TerminalPortsPopover from '@/components/search/TerminalPortsPopover.vue'
import SelfCheckPopover from '@/components/search/SelfCheckPopover.vue'
import SettingsModal from '@/components/settings/SettingsModal.vue'
import TaskRunner from '@/components/console/TaskRunner.vue'
import OutlinePopover from '@/components/search/OutlinePopover.vue'
import BookmarkListPopover from '@/components/editor/BookmarkListPopover.vue'
import ClipboardHistoryPopover from '@/components/common/ClipboardHistoryPopover.vue'
import type { PaletteCommand, PaletteRemoteFile } from '@/components/search/CommandPalette.vue'

defineProps<{
  showCommandPalette: boolean
  paletteInitialMode?: 'files' | 'commands'
  showQuickOpen: boolean
  showProjectSearch: boolean
  /** 项目搜索种子查询词（P-20261002-86 降级跳转）：打开时填入并自动搜索 */
  projectSearchSeed?: string
  /** 项目搜索 glob 种子（P-20261003-118 目录右键「在此目录搜索」）：打开时预填 */
  projectSearchGlob?: string
  showOutline: boolean
  showTaskRunner: boolean
  /** 书签列表弹层（P-20261002-131，命令面板「书签列表」入口） */
  showBookmarkList: boolean
  /** 多剪贴板粘贴弹层（P-20261002-149，Ctrl+Alt+V 入口） */
  showClipboardHistory: boolean
  /** 跨项目命令历史检索浮层（P-20261004-2，命令面板「搜索命令历史」入口） */
  showTerminalHistorySearch: boolean
  /** 跨会话终端输出检索浮层（P-20261003-290，命令面板「搜索终端输出」入口） */
  showTerminalOutputSearch: boolean
  /** 端口占用一览浮层（P-20261003-293，命令面板「端口占用一览」入口） */
  showTerminalPorts: boolean
  /** 本机环境体检浮层（P-20261003-317，命令面板「环境体检」入口） */
  showSelfCheck: boolean
  paletteFiles: Array<{ name: string; path: string }>
  /** Quick Open 远程文件层（P-20261004-137）：独立分组，项目文件语义零变化 */
  paletteRemoteFiles?: PaletteRemoteFile[]
  paletteFilesLoading: boolean
  /** Quick Open 源文件列表是否触达索引上限（P-20261002-77 尾部弱提示） */
  paletteFilesTruncated?: boolean
  /** 文件层 frecency 作用域（P-20261005-222）：当前项目 id 透传给 CommandPalette */
  paletteProjectId?: string
  paletteCommands: PaletteCommand[]
  recentFiles: Array<{ name: string; path: string }>
  showSettingsModal: boolean
  /** 当前编辑文件的内容——供 OutlinePopover 解析标题 */
  outlineContent: string
  outlinePath: string
}>()

const emit = defineEmits<{
  'update:showCommandPalette': [v: boolean]
  'update:showQuickOpen': [v: boolean]
  'update:showProjectSearch': [v: boolean]
  'update:showOutline': [v: boolean]
  'update:showTaskRunner': [v: boolean]
  'update:showBookmarkList': [v: boolean]
  'update:showSettingsModal': [v: boolean]
  'update:showClipboardHistory': [v: boolean]
  'update:showTerminalHistorySearch': [v: boolean]
  'update:showTerminalOutputSearch': [v: boolean]
  'update:showTerminalPorts': [v: boolean]
  'update:showSelfCheck': [v: boolean]
  paletteCommand: [id: string]
  /** line/col：文件名:行号直达（P-20261003-302），宿主走 handleSearchOpenFile 行定位链 */
  paletteOpenFile: [path: string, line?: number, col?: number]
  /** Quick Open 文件模式 Ctrl/Cmd+Enter（P-20261002-106）：选中文件分屏打开 */
  paletteOpenFileSplit: [path: string]
  /** Quick Open 空结果降级（P-20261002-86）：带查询词去项目搜索 */
  paletteFallbackSearch: [query: string]
  searchOpenFile: [path: string, line?: number]
  settingsSaved: []
  outlineNavigate: [line: number]
  /** 书签条目点选：跨文件跳回书签行（宿主走 handleSearchOpenFile 开文件 + 行定位） */
  bookmarkNavigate: [path: string, line: number]
  /** 多剪贴板历史条目点选（P-20261002-149）：宿主写回系统剪贴板 + 光标插入 */
  clipboardPick: [text: string]
  /** 命令历史检索命中点选（P-20261004-2）：宿主插入当前终端（无终端降级复制） */
  terminalHistoryInsert: [command: string]
  /** 终端输出检索命中点选（P-20261003-290）：宿主走 activate-terminal 链路跳会话；
   *  query = 命中查询词，落会话后做会话内定位（P-20261005-9） */
  terminalOutputJump: [sessionId: string, query?: string]
  /** 端口占用条目点选（P-20261003-293）：宿主走 activate-terminal 链路直达占用方 */
  terminalPortsJump: [sessionId: string]
}>()
</script>

<template>
  <CommandPalette
    :show="showCommandPalette || showQuickOpen"
    :initial-mode="paletteInitialMode"
    :files="paletteFiles"
    :remote-files="paletteRemoteFiles"
    :files-loading="paletteFilesLoading"
    :files-truncated="paletteFilesTruncated"
    :project-id="paletteProjectId"
    :commands="paletteCommands"
    :recent-files="recentFiles"
    @update:show="(v: boolean) => { emit('update:showCommandPalette', v); emit('update:showQuickOpen', v) }"
    @run-command="emit('paletteCommand', $event)"
    @open-file="(path: string, line?: number, col?: number) => emit('paletteOpenFile', path, line, col)"
    @open-file-split="emit('paletteOpenFileSplit', $event)"
    @fallback-search="emit('paletteFallbackSearch', $event)"
  />
  <ProjectSearch
    :show="showProjectSearch"
    :initial-query="projectSearchSeed"
    :initial-file-pattern="projectSearchGlob"
    @update:show="emit('update:showProjectSearch', $event)"
    @open-file="(path: string, line?: number) => emit('searchOpenFile', path, line)"
  />
  <SettingsModal
    :show="showSettingsModal"
    @update:show="emit('update:showSettingsModal', $event)"
    @saved="emit('settingsSaved')"
  />
  <TaskRunner
    :show="showTaskRunner"
    @update:show="emit('update:showTaskRunner', $event)"
  />
  <OutlinePopover
    :show="showOutline"
    :content="outlineContent"
    :path="outlinePath"
    @update:show="emit('update:showOutline', $event)"
    @navigate="(line: number) => emit('outlineNavigate', line)"
  />
  <BookmarkListPopover
    :show="showBookmarkList"
    @update:show="emit('update:showBookmarkList', $event)"
    @navigate="(path: string, line: number) => emit('bookmarkNavigate', path, line)"
  />
  <!-- 多剪贴板粘贴（P-20261002-149）：选中写回系统剪贴板 + 活跃编辑器光标插入
       （宿主 pasteClipboardHistory 闭环，无活跃编辑器降级为仅复制提示） -->
  <ClipboardHistoryPopover
    :show="showClipboardHistory"
    @update:show="emit('update:showClipboardHistory', $event)"
    @pick="(text: string) => emit('clipboardPick', text)"
  />
  <!-- 跨项目命令历史检索（P-20261004-2）：点选命中插入当前终端（不执行），
       宿主 insertTerminalHistoryCommand 闭环（无活跃终端降级复制并提示） -->
  <TerminalHistorySearchPopover
    :show="showTerminalHistorySearch"
    @update:show="emit('update:showTerminalHistorySearch', $event)"
    @insert="(command: string) => emit('terminalHistoryInsert', command)"
  />
  <!-- 跨会话终端输出检索（P-20261003-290）：点选命中走 activate-terminal 链路
       跳到该会话，宿主 jumpToTerminalSession 闭环（会话已结束内部 toast 降级）；
       查询词随行透传做会话内定位（P-20261005-9：滚动落点 + 高亮，滚出缓冲
       toast 诚实提示） -->
  <TerminalOutputSearchPopover
    :show="showTerminalOutputSearch"
    @update:show="emit('update:showTerminalOutputSearch', $event)"
    @jump="(sessionId: string, query?: string) => emit('terminalOutputJump', sessionId, query)"
  />
  <!-- 端口占用一览（P-20261003-293）：点选条目同走 activate-terminal 链路直达
       占用方终端，宿主 jumpToTerminalSession 复用闭环 -->
  <TerminalPortsPopover
    :show="showTerminalPorts"
    @update:show="emit('update:showTerminalPorts', $event)"
    @jump="(sessionId: string) => emit('terminalPortsJump', sessionId)"
  />
  <!-- 本机环境体检（P-20261003-317）：只读体检单浮层，三态语义色 + 复制为
       Markdown（issue 直贴），打开即体检无其他联动 -->
  <SelfCheckPopover
    :show="showSelfCheck"
    @update:show="emit('update:showSelfCheck', $event)"
  />
</template>
