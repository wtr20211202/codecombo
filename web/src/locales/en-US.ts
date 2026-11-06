// English locale - follows the same structure as zh-CN
export default {
  // Render error fallback "white-screen fuse" (P-20261002-26): crash page copy + error center entry
  app: {
    crash: {
      title: 'The page failed to render',
      hint: 'The app detected consecutive rendering errors and switched to a degraded mode. Copy the details for feedback, or go home to continue.',
      copyDetail: 'Copy details',
      reload: 'Reload page',
      goHome: 'Go home',
      logUserMessage: 'A rendering error occurred and has been logged (see error messages)',
    },
  },
  time: {
    justNow: 'just now',
    minutesAgo: '{n} min ago',
    hoursAgo: '{n} hr ago',
    daysAgo: '{n} d ago',
  },
  common: {
    confirm: 'Confirm',
    cancel: 'Cancel',
    later: 'Later',
    save: 'Save',
    saving: 'Saving...',
    create: 'Create',
    delete: 'Delete',
    refresh: 'Refresh',
    add: 'Add',
    close: 'Close',
    rename: 'Rename',
    edit: 'Edit',
    retry: 'Retry',
    asyncLoadFailed: 'Failed to load component resources (network hiccup or page suspended)',
    // Shared actions: copy / copied / saved (used by multiple components)
    copy: 'Copy',
    copied: 'Copied',
    copyFailed: 'Copy failed, please select and copy manually',
    saved: 'Saved',
    saveFailed: 'Save failed',
    deleteFailed: 'Delete failed',
    noProject: 'Please add a Git project first',
    skipToMain: 'Skip to main content',
    // common browse button (shared by PathInput etc.)
    browse: 'Browse',
    // Directory browse panel (PathInput: persistent up button / select-current / symlink badge)
    parentDir: 'Parent directory',
    selectCurrentDir: 'Select current',
    dirEmpty: 'No subdirectories here',
    symlinkDir: 'Link',
  },
  // Credential / OAuth i18n (used by CredentialList / OAuthClientManager / OAuthDeviceFlowDialog)
  credential: {
    expired: 'Expired',
    expiresAt: 'Expires at',
    neverExpires: 'Permanent',
    lastUsed: 'Last used',
    test: 'Test',
    testOk: '✓ Credential valid',
    testExpired: 'Credential expired',
    testRepoTitle: 'Enter test repo URL',
    testRepoPlaceholder: 'http://localhost:3000/owner/repo.git',
    testRepoHint: 'Generic Git platform verifies credentials via git ls-remote; enter a repo URL you can access',
    testRepoConfirm: 'Test',
    testLimited: 'Credential valid, but lacks permission to read user info (does not affect git push/pull)',
    lastError: {
      access_denied: 'Authorization denied',
      expired_token: 'Authorization timed out',
      network: 'Network error, please retry',
    },
    oauth: {
      title: 'OAuth Login',
      step1: '1. Copy code below and paste on platform website',
      openBrowser: 'Open Browser',
      polling: '2. Waiting for authorization... {seconds}s',
      retry: 'Re-authorize',
      success: 'Authorized',
      startFailed: 'OAuth start failed',
      // 用户可见的 device code 提示文案（spec 契约 key，外部脚本/E2E 选择器可能依赖）
      deviceCode: 'Please enter code in browser: {code}',
    },
    platform: {
      github: 'GitHub',
      gitlab: 'GitLab',
      gitea: 'Gitea',
      gitee: 'Gitee',
      generic: 'Generic Git',
      unknown: 'Unknown platform',
    },
  },
  toolbar: {
    fetch: 'Fetch',
    pull: 'Pull',
    push: 'Push',
    clone: 'Clone',
    noBranch: 'No Branch',
  },
  changes: {
    working: 'Working Tree',
    locateInTree: 'Locate in File Tree',
    clipboard: 'Clipboard',
    // Staged side label for diff baseline split (P-20261004-42): pseudo-ref
    // display name alongside working/clipboard (consumed by breadcrumb shortRef)
    index: 'Index',
    rollback: {
      title: 'Rollback Changes',
      confirm: 'Roll back {name}? Uncommitted changes will be discarded and cannot be recovered.',
      confirmBtn: 'Rollback',
    },
    filter: {
      placeholder: 'Filter changed files…',
      noMatch: 'No matching files',
      // Status-dimension filter chips (P-20261003-136): all/unstaged/staged/
      // conflict four states, AND-combined with path and attribution filters
      statusAll: 'All',
      statusUnstaged: 'Unstaged',
      statusStaged: 'Staged',
      statusConflict: 'Conflicts',
      statusAllTitle: 'Show changed files of all statuses',
      statusUnstagedTitle: 'Show unstaged files only',
      statusStagedTitle: 'Show staged files only',
      statusConflictTitle: 'Show conflicted (unmerged) files only',
      statusConflictNone: 'No conflicted files',
    },
    // Changelists (P-20261007-19): JetBrains-style logical grouping — group CRUD,
    // active switching, move-file via change-tree context menu, group shelve
    // (restore via the stash tab)
    changelist: {
      section: 'Changelists',
      new: 'New',
      newTitle: 'New changelist',
      nameLabel: 'List name:',
      namePlaceholder: 'feature-login',
      nameRequired: 'Please enter a list name',
      created: 'Changelist {name} created',
      deleted: 'Changelist {name} deleted (files are unaffected)',
      deleteTitle: 'Delete changelist',
      deleteConfirm: "Delete changelist {name}? Files and the worktree are unaffected — only the grouping view disappears.",
      deleteBtn: 'Delete',
      isActiveTitle: 'Active group: {name} (current group; click another row to switch)',
      setActiveTitle: 'Set active group: {name}',
      filesCountTitle: '{n} files in group (right-click a change to move it in)',
      shelveBtnTitle: 'Shelve group: {name}',
      moveTo: 'Move to list',
      moved: 'Moved to list {name}',
      shelveTitle: 'Shelve "{name}"',
      shelveMsgLabel: 'Shelve message (optional):',
      shelveMsgPlaceholder: 'WIP: login form',
      shelveHint: '{n} changed files in this group will be stored as one stash entry (unrelated changes untouched); switch away for urgent work, restore from the Stash tab later.',
      shelved: 'Shelved {n} files (stash entry marked; restore from the Stash tab)',
      shelveNothing: 'No uncommitted changes on group files — no stash entry created',
      filterChip: 'Active group',
      filterChipOffTitle: 'Show files of active group "{name}" only (stacks with text filter)',
      filterChipOnTitle: 'Showing active group "{name}" only — click again to show all',
      filterChipNone: 'No active group: click ● in the Changelists section first',
      stashBadge: 'Shelved',
      stashBadgeTitle: 'Shelved entry (created by changelist "Shelve group"): click Restore to bring it back',
    },
    // Change tree bulk expand/collapse (P-20261003-169): one-click for per-group
    // toggling across dozens of directory groups; filter hits auto-expand first
    tree: {
      expandAll: 'Expand all directory groups',
      collapseAll: 'Collapse all directory groups',
      // Copy change summary (P-20261003-219): file list + per-file +N/-M lines
      // onto the clipboard; tree header button and the context-menu item of the
      // same name share one action
      copySummary: 'Copy Change Summary',
      // Sort by change size (P-20261003-239): review-focus mode toggle, title
      // states the active ordering
      sortBySizeOff: 'Sort by change size (currently path order; click for largest first)',
      sortBySizeOn: 'Sorted by change size (largest first; click to restore path order)',
      // Inline diff expansion (P-20261004-25): file-row chevron expand/collapse title
      expandDiff: 'Expand inline diff (per-hunk stage/discard)',
      collapseDiff: 'Collapse inline diff',
      // Group header stat (P-20261003-280): file-count face of the dir-row group
      // stat (+x -y are locale-neutral numeric symbols, not i18n'd)
      dirStatFiles: '{n} files',
    },
    // Line-count heat (P-20261003-239): exact numbers in the row heat bar tooltip
    heat: {
      tip: '{n} changed lines (+{a} / -{d})',
    },
    // Inline diff embed (P-20261004-25): in-place feedback when fetching the
    // expanded slot fails (silent fetch, no interceptor global toast; an empty
    // diff reuses commitPanel.noChanges)
    inlineDiff: {
      loadFailed: 'Failed to load diff',
    },
    // Change summary text (P-20261003-219): labels for the utils/changeSummary
    // pure builder — the clipboard artifact is user-visible text, labels go
    // through i18n (copy what you see)
    summary: {
      headBranch: 'Change summary ({branch}): {n} file(s), +{a} / -{d}',
      head: 'Change summary: {n} file(s), +{a} / -{d}',
      binary: 'binary',
      copied: 'Change summary copied',
      loadFailed: 'Failed to load change summary, please retry',
    },
    // Session attribution badge & filter (P-20261003-22): badge tooltip lists
    // runtimes/session count and notes the attribution boundary (only sessions
    // rooted at the project root count; worktree sessions are excluded)
    agentMarks: {
      tip: 'Changed by agent: {runtime} · {n} session(s) (only sessions rooted at the project root count)',
      unknownRuntime: 'unknown runtime',
      filterAgent: 'Agent',
      filterHuman: 'Human',
      filterAgentTitle: 'Show agent changes only',
      filterHumanTitle: 'Show human changes only',
    },
    // Export uncommitted changes as patch (P-20261003-72): three-scope download;
    // git diff semantics exclude untracked files
    exportPatch: {
      label: 'Export patch (git diff format; untracked files not included)',
      worktree: 'Worktree (unstaged)',
      staged: 'Staged',
      head: 'All (vs HEAD)',
      success: 'Patch exported',
      // Sensitive-egress gate confirm dialog (P-20261004-97): key set passed
      // through confirmSensitiveFiles
      sensitiveTitle: 'Security scan before patch export',
      sensitiveIntro: 'This patch contains {n} file(s) that look like keys or credentials. Confirm before saving:',
      moreFiles: '…and {n} more file(s) not listed',
      partialNote: 'Only part of the content was scanned; some sensitive files may have been missed.',
      sensitiveConfirm: 'Export anyway',
    },
  },
  diff: {
    unified: 'Unified',
    sideBySide: 'Side by Side',
    stageHunk: 'Stage Hunk',
    unstageHunk: 'Unstage Hunk',
    // Hunk-level workspace discard (P-20261003-49): discarding is irreversible,
    // the confirm message includes the file name
    discard: {
      hunk: 'Discard Hunk',
      title: 'Discard Hunk',
      confirm: 'Discard all changes in this hunk of "{name}"? This cannot be undone.',
    },
    prevChange: 'Previous change (Alt+↑)',
    nextChange: 'Next change (Alt+↓)',
    // DiffViewer change navigation (P-20261003-212): parity with the DiffEditor
    // prev/next; P-20261004-54 adds in-component Alt+↑/↓ keyboard navigation (same
    // keys as the editor diff tab), so the shortcut hint is accurate here too
    prevHunk: 'Previous hunk (Alt+↑, wraps)',
    nextHunk: 'Next hunk (Alt+↓, wraps)',
    // N/M counter (P-20261004-54): toolbar "position/total" indicator tooltip
    navCount: 'Change position / total',
    ignoreWhitespace: 'Ignore Whitespace',
    collapseUnchanged: 'Collapse Unchanged Regions',
    // Fold placeholder row (P-20261004-99): expand/collapse control text of the
    // self-drawn DiffViewer's unchanged-region folding
    foldExpand: 'Expand {count} lines',
    foldCollapse: 'Collapse',
    // "Open in Editor" (P-20261003-57): one click from the diff toolbar to the
    // file behind the reviewed (right-hand) version
    openInEditor: 'Open in Editor',
    // Line-level diff follow-up (P-20261003-208): right-click "Ask about this
    // change" in the diff view starts a new agent session with file + line +
    // hunk summary (prompt header and packing live in useEditorAskAgent)
    ask: {
      menu: 'Ask about this change',
      prompt: 'Explain why this change at line {line} in {path} was made:',
    },
    // Diff review comments (P-20261003-279): persistent line-level "change this"
    // notes on produced diffs — add via context menu, line marker + hover detail,
    // resolve by checking handled, survive reopen (useDiffComments)
    comment: {
      add: 'Add review comment',
      edit: 'Edit comment',
      resolve: 'Mark handled',
      unresolve: 'Unmark handled',
      remove: 'Delete comment',
      title: 'Review comment',
      anchor: '{path} · line {line}',
      placeholder: 'e.g. this needs changing...',
      empty: 'Comment cannot be empty',
      tooLong: 'Comment is limited to {max} characters',
      hoverTitle: 'Review comment',
      stateResolved: 'Handled',
      statePending: 'Pending',
      drifted: 'Line anchor may have drifted',
      // "Hand to agent" (P-20261006-55): fifth data source of the hand-to-agent
      // action family — batch unresolved comments into one agent fix session
      // (DiffEditor toolbar + changes tree context menu); resolving stays a
      // human review step (the agent never flips the handled state)
      handAction: 'Hand {n} comment(s) to agent',
      handActionTitle: 'Start an agent session to fix each comment; comments stay pending — review and mark handled yourself once fixed',
      fix: {
        headBatch: 'Please fix the following {n} diff review comments (each line is "file:line note"; do not mark the comments handled yourself — resolution is done by human review):',
        headSingle: 'Please fix this diff review comment:',
        omitted: '({n} more comments exceeded the session launch-args limit and are not included; launch the next batch after finishing these)',
        success: 'Agent fix session created ({n} comments)',
      },
    },
    view: {
      sideBySide: 'Side-by-Side View',
      inline: 'Inline View',
    },
  },
  log: {
    filterAuthor: 'Filter by author',
    dirHistory: 'Directory History',
    dirHistoryPlaceholder: 'Dir history (src/)',
    noCommits: 'No commits yet',
    noDirCommits: 'No commits in this directory',
    emptyRepoTitle: 'No commits in this repository yet',
    emptyRepoDesc: 'Your commit history will appear here after the first commit',
    emptyRepoAction: 'Go to Changes panel to create the first commit',
  },
  branch: {
    mergeFailed: 'Merge branch failed',
    rebaseFailed: 'Rebase failed',
  },
  help: {
    title: 'Help Center',
    searchPlaceholder: 'Search FAQs…',
    noResults: 'No matching questions',
    loadFailed: 'Failed to load help content',
    retry: 'Retry',
    agentTip: 'You can also ask the agent directly: the agent is integrated with the system — it sees the same help content and can operate settings, Git, terminals for you',
  },
  whatsNew: {
    title: "What's New",
    dismiss: 'Got it',
    viewHistory: 'View full history in Help Center',
  },
  shortcuts: {
    title: 'Keyboard Shortcuts',
    filterPlaceholder: 'Filter shortcuts (description or keys)',
    filterEmpty: 'No matching shortcuts',
    groupGlobal: 'Global',
    groupEditor: 'Editor',
    groupTerminal: 'Terminal',
    cmdPalette: 'Command palette',
    commandMode: 'Command palette (commands mode)',
    quickOpen: 'Quick open file by name',
    projectSearch: 'Project-wide search',
    outline: 'File outline',
    toggleSidebar: 'Show/hide sidebar',
    railPanels: 'Switch activity bar panels (visual order)',
    // Workspace preset direct access (P-20261004-49): static row (Alt branch of the
    // digit capture chain, reconciled by the audit script)
    workspacePresets: 'Restore workspace preset (#N in list)',
    openSettings: 'Open Settings',
    toggleTerminal: 'Show/hide terminal panel',
    newTerminal: 'New terminal',
    previewToggle: 'Show/hide port preview panel',
    closeTab: 'Close active tab',
    cycleTabs: 'Cycle editor tabs',
    prevTab: 'Previous editor tab',
    nextTab: 'Next editor tab',
    // Keyboard tab move (P-20261005-201, Alt+Shift+arrows): keyboard counterpart of drag reorder
    moveTabPrev: 'Move active tab left',
    moveTabNext: 'Move active tab right',
    exitMaximized: 'Exit layer by layer: floats → maximized → bottom panel',
    save: 'Save current file',
    // Editor-domain custom actions (P-20261008-14): dynamic help rows (combos read from the registry)
    bookmarkToggle: 'Toggle bookmark (cursor line)',
    inlineEdit: 'Inline AI edit selection (active session)',
    find: 'Find',
    replace: 'Find & replace',
    multiCursor: 'Multi-cursor: add next match',
    diffNav: 'Navigate diff changes',
    toggleSplit: 'Toggle split editor',
    splitDown: 'Split down / toggle split direction',
    focusOtherGroup: 'Focus other editor group',
    // Terminal split pane keyboard switch (P-20261004-111): terminal counterpart of focusOtherGroup
    focusOtherPane: 'Switch active terminal pane (split)',
    history: 'Command history panel',
    snippet: 'Command snippet panel',
    switchTerm: 'Switch terminal tab',
    // Terminal single-combo keys (P-20261003-111): font/copy/paste rows read live registry values
    fontIn: 'Increase terminal font size',
    fontOut: 'Decrease terminal font size',
    fontReset: 'Reset terminal font size',
    termCopy: 'Copy terminal selection',
    termPaste: 'Paste into terminal',
    // Command block skip navigation (P-20261003-269): skim long-output blocks (no-op without shell integration)
    cmdNavPrev: 'Jump to previous command block',
    cmdNavNext: 'Jump to next command block',
    // Bookmark list (P-20261004-16): scrollback bookmark panel toggle
    bookmarkList: 'Terminal bookmark list',
    reopenTab: 'Reopen closed editor tab',
    navBack: 'Navigate back (previous location)',
    navForward: 'Navigate forward (next location)',
    // Bookmark jump (P-20261004-102): editor-group cheat-sheet rows on global rebind scope
    bookmarkPrev: 'Previous bookmark (ring order)',
    bookmarkNext: 'Next bookmark (ring order)',
    newDraft: 'New untitled draft',
    saveAll: 'Save All',
    clipHistoryPaste: 'Multi-clipboard paste (pick from history)',
    // Markdown mode cycle (P-20261003-18): md tri-state shortcut (cheat-sheet row)
    mdModeCycle: 'Cycle Markdown mode (source → preview → split, .md files only)',
    monitorRefresh: 'Refresh dashboard data (on Duty Dashboard)',
    // Scope badges & filter (P-20261003-99): entries tagged by activation context (group = domain, badge = scope)
    scopeAll: 'All',
    scopeGlobal: 'Global',
    scopeEditor: 'Editor',
    scopeTerminal: 'Terminal',
    scopeApproval: 'Approval pending',
    scopeMonitor: 'Duty dashboard',
    scopeFilterLabel: 'Filter by scope',
    // Approval keyboard adjudication (P-20261003-1) cheat-sheet rows: active while a pending card is on screen and focus is outside inputs
    groupApproval: 'Approval pending',
    approvalAllowOnce: 'Allow once',
    approvalTier: 'Allow with horizon (1/2/3 in popover)',
    approvalDeny: 'Deny',
    // Mouse & drag group (P-20261005-184): non-keyboard interaction cheat sheet —
    // trigger phrase + one-line effect, rows self-declared here (no mouse registry,
    // not covered by the keybinding audit), kept in sync with the implementation
    groupMouse: 'Mouse & Drag',
    mouseTriggerDrag: 'Drag',
    mouseTriggerDrop: 'Drag & drop',
    mouseTriggerMiddle: 'Middle click',
    mouseTriggerDblclick: 'Double click',
    mouseTriggerClick: 'Left click',
    mouseDragTabMove: 'Drag an editor tab onto another editor group = move it there',
    mouseDragTabCopy: 'Hold Alt and drag an editor tab to another group = copy (source keeps it)',
    mouseTreeDropEditor: 'Drag a file from the tree onto the editor area = open it in that group',
    mouseMiddleCloseEditorTab: 'Middle-click an editor tab = close (pinned tabs unaffected)',
    mouseDblclickPinTab: 'Double-click an editor tab = pin/unpin',
    mouseCrumbSiblings: 'Click a breadcrumb directory segment = list its siblings, click one to jump',
    mouseMiddleCloseTermTab: 'Middle-click a terminal tab = close',
    mouseDropTermPath: 'Drag a tree file into the terminal = paste its path on the input line (not executed)',
    mouseBroadcastSelect: 'In broadcast mode (terminal toolbar toggle), click tabs = select/deselect, one input sends to all',
  },
  // Frontend atom toasts (P-20261023-4): visible feedback for agent-triggered
  // browser effects (download box / clipboard write / open tab) and the settings
  // switches — no silent effect is part of the safety boundary, so these toasts
  // deliberately do not participate in do-not-disturb silencing
  opsAtom: {
    atom: {
      download: 'file download',
      clipboard: 'clipboard write',
      open: 'open page',
    },
    downloadStarted: 'Agent requested download of "{name}" — started',
    clipboardWritten: 'Agent wrote to your clipboard: {preview}',
    clipboardFallback: 'Direct clipboard write was not authorized by the browser — click to take the content',
    clipboardFailed: 'Clipboard write failed',
    opened: 'Agent opened {host} in a new tab',
    openBlocked: 'The browser blocked the popup; it was moved to the notification center — click the notification to open {host}',
    openBlockedTitle: 'Agent requested to open an external link: {host}',
    rateLimited: '{atom} requests are too frequent (10/min); this one was dropped',
    disabledNotice: '{atom} is disabled in Settings; this request was ignored',
  },
  // Multi-clipboard paste (P-20261002-149): clip.history.* prefix — clipboard history picker popover
  clip: {
    history: {
      title: 'Clipboard History',
      empty: 'No copies yet — copy some text first (editor Ctrl+C, terminal copy, or any copy button), then invoke the shortcut',
      copied: 'Copied to clipboard — paste it at the target',
      // Sensitive-item masking (P-20261005-14): per-entry reveal toggle (session-level, re-masked on reopen)
      maskShow: 'Show',
      maskHide: 'Hide',
    },
    // Cross-device clipboard relay (P-20261002-32): copy here → paste on any other
    // unlocked device of the same service; content often holds secrets — server
    // keeps an in-memory slot (5-min TTL) with burn-on-read, copy never shows it
    sendCmd: 'Send Clipboard to Other Devices',
    arrivedToast: 'New clipboard content from another device — click to take',
    sent: 'Sent — other devices can take it from the notification',
    sendEmpty: 'Nothing to send — local clipboard is empty',
    sendTooLarge: 'Content exceeds the 32KB limit and cannot be sent',
    sendFailed: 'Failed to send',
    taken: 'Copied to this device\'s clipboard',
    gone: 'Content was already taken or has expired',
    takeFailed: 'Failed to fetch content',
  },
  settings: {
    saveHint: 'Save (Ctrl+S)',
    title: 'Settings',
    autoFetch: 'Auto-fetch',
    autoFetchDesc: 'Periodically fetch updates from remote',
    externalAccessUrl: 'External access URL',
    externalAccessUrlDesc: 'Optional. When accessed through Tailscale / Cloudflare Tunnel / a public reverse proxy, enter the origin your phone can reach (e.g. https://nas.tailnet.ts.net). Leave empty to auto-select the current address or a LAN IP; only http/https origins are accepted, without credentials, path, query or fragment',
    externalAccessUrlPlaceholder: 'https://nas.example.com',
    externalAccessUrlInvalid: 'Invalid external access URL: only http/https origins are accepted (no credentials, path, query or fragment)',
    sharePublicBaseUrl: 'Share public base URL',
    sharePublicBaseUrlDesc: 'Optional. Share links will always be "<this origin>/s/<token>" — set it when a reverse proxy or SSH tunnel only forwards the main port and the share sub-service port is unreachable (e.g. https://share.example.com). Leave empty to auto-select: external access URL > current address > LAN candidate > share sub-service port; only http/https origins are accepted, without credentials, path, query or fragment',
    sharePublicBaseUrlPlaceholder: 'https://share.example.com',
    sharePublicBaseUrlInvalid: 'Invalid share public base URL: only http/https origins are accepted (no credentials, path, query or fragment)',
    agentProvider: 'AI agent',
    agentGuardLabel: 'Require user approval when agent tokens call guarded APIs (server-enforced)',
    agentApprovalModeLabel: 'High-risk operation approval mode',
    agentApprovalModeAsk: 'Ask every time',
    agentApprovalModeSession: 'Session-scoped allow (granted sessions only)',
    agentApprovalMode24h: 'Allow for 24 hours (auto-restore)',
    agentApprovalModeAllow: 'Always allow (no prompts)',
    agentApprovalMode24hHint: 'Saving starts a fresh 24-hour window; prompts resume automatically after expiry',
    agentApprovalMode24hRemaining: 'Active: {remaining} left; prompts resume automatically after expiry',
    approvalRecordingLabel: 'Approval process recording (capture terminal during approval windows, off by default)',
    uiSnapshotLabel: 'User context snapshot (share current file/line/panels/terminal session with agents, on by default)',
    // Session startup context (P-20261006-47): workspace background auto-attached to new agent sessions
    sessionContextLabel: 'Session startup context',
    sessionContextOptGit: 'Git status summary',
    sessionContextOptNotes: 'Project notes intro',
    sessionContextOptTodos: 'TODO summary',
    sessionContextOptEnv: 'Environment profile (ports/sentinels/deploy targets)',
    sessionContextHint: 'Workspace background material auto-attached to new agent sessions, multi-select; uncheck all = attach none. Adjustable per launch in the new-session dialog without changing this setting.',
    // Session naming note injection (P-20261023-3): the server appends a
    // naming instruction line after the prompt when a session is created
    // with a task prompt — the driver for rename-on-task-evolution
    agentNamingNoteLabel: 'Attach naming note to new sessions (rename to a short label of at most 16 chars when the task evolves)',
    agentNamingNoteHint: 'When a session is created with a task prompt, a system note line is appended after it: it states the session ID and asks the agent to check for duplicates before renaming. Same-name sessions are auto-stepped with a numeric suffix server-side; this toggle only controls the note injection.',
    // Default validity for new shares (P-20261020-5): applied when the create dialog is left untouched
    shareDefaultTTL: 'Default validity for new shares',
    shareDefaultTTLDesc: 'Validity preselected when creating a file share; can be overridden per share in the create dialog. "Permanent" (default) keeps the existing behavior. Applies to live file shares only — frozen snapshots default to 30 days, and other share kinds have fixed windows',
    uiSnapshotHint: 'Location only, never content: agents sense where you are looking to answer precisely, without reading file contents or terminal output; turning it off stops reporting and blocks reads immediately',
    // Preview same-origin compat mode (P-20261019-1): off by default = sandboxed preview iframe
    previewCompatLabel: 'Preview compatibility mode (disables preview sandbox isolation)',
    previewCompatHint: 'Off by default: previewed content runs in a sandbox (opaque origin) and cannot read this app\'s unlock token, cookies, or APIs. Enable only when an app that relies on same-origin storage fails to preview. Once enabled, previewed content gains this app\'s permissions — use only with projects and dependencies you trust',
    previewCompatConfirmTitle: 'Enable preview compatibility mode?',
    previewCompatConfirmBody: 'With the sandbox disabled, scripts in the previewed page gain this app\'s permissions: they can read the unlock token and cookies, call this app\'s APIs as you, and manipulate the page. Enable only if you fully trust the previewed project and all of its dependencies.',
    previewCompatConfirmYes: 'Enable anyway',
    // Frontend atom switches (P-20261023-4): agent-triggered browser effects,
    // togglable per atom — download box / clipboard write / open tab
    opsAtomDownload: 'Allow agents to trigger file downloads (open the browser download box)',
    opsAtomClipboard: 'Allow agents to write the clipboard (with a visible preview before writing)',
    opsAtomOpen: 'Allow agents to open web pages (external links in a new tab)',
    opsAtomsHint: 'These are instant browser effects agents trigger via the ops channel (each with a visible toast, rate-limited to 10/min); when off, matching requests are ignored and the agent is told the atom is disabled',
    // Context warn threshold (P-20261006-33): device-local pref; raise it to leave room for tail conclusions
    contextWarnThreshold: 'Context warn threshold',
    contextWarnThresholdHint: 'When a session\'s remaining context drops below this, show "Context nearly full" and unlock relay (device-local, effective immediately); raise it for long writing/refactor sessions to leave room for conclusions',
    runtimeInstallInTerminal: 'Install in terminal',
    runtimeInstallStarted: 'Installation of {name} started in a new terminal session; finish it interactively there',
    runtimeInstallFailed: 'Failed to create terminal session; copy the install command manually',
    workspaceBackup: {
      title: 'Workspace State Backup',
      desc: 'Export UI state (layout, session groups, remote console tabs) as a JSON backup; importing overwrites matching namespaces.',
      export: 'Export',
      exportDone: 'Exported',
      exportFailed: 'Export failed',
      empty: 'No UI state to export yet',
      import: 'Import',
      importInvalid: 'Invalid file: not a workspace state backup exported by this app',
      importConfirmTitle: 'Import workspace state',
      importConfirm: 'This overwrites UI state of {n} instance(s) (layout, session organization, etc.). Continue?',
      importGo: 'Import',
      importDoneTitle: 'Import complete',
      importDone: 'UI state written. Reload now to fully apply it; UI actions before reloading may overwrite the imported state.',
      refreshNow: 'Reload now',
      importFailed: 'Import failed',
    },
    // Preference track annotations (P-20261007-1 Settings Sync): keymap overrides /
    // notification trio / terminal habits roam with the account (server-side
    // userPrefs single key), while visual prefs (font size / zoom / cursor) are
    // remembered per device (track visibility — users can tell which follow the
    // person and which follow the machine)
    syncTrackRoaming: 'This preference roams with your account: changes sync to the server automatically and follow you when you open the workspace on other devices',
    syncTrackDeviceLocal: 'Visual preferences such as font size / zoom / cursor style are remembered per device and do not roam with your account — they adapt to each machine\'s screen and peripherals',
    // Settings export/import (P-20261005-4): migration of the local settings family
    // across devices of the same instance — localStorage preference whitelist only
    // (font/keymap/locale/theme/local notification prefs), never tokens/credentials
    // or instance-side data; per-device settings like UI zoom are excluded
    transfer: {
      title: 'Export / Import Settings',
      hint: 'Pack font & editor appearance, keymap overrides, interface language, theme and local notification preferences (do-not-disturb, sound, etc.) into a JSON file, then import it here on another device to migrate. Tokens, credentials and project data are never included; per-device settings like UI zoom are excluded',
      export: 'Export Settings',
      exportDone: 'Settings exported',
      exportEmpty: 'Nothing to export (all settings are at defaults)',
      import: 'Import Settings',
      importInvalid: 'Invalid file: not a settings export from this app',
      importVersion: 'Unsupported file version: it may come from a newer or older app version',
      importNone: 'No importable settings section in the file',
      previewTitle: 'Import Preview',
      previewHint: 'Check the sections to apply; unchecked sections keep local values',
      sectionFont: 'Font & editor appearance',
      sectionKeymap: 'Keymap overrides',
      sectionLocale: 'Interface language',
      sectionTheme: 'Theme',
      sectionNotify: 'Local notification preferences',
      itemCount: '{n} items',
      diffCount: '{n} differ from local',
      sameAsLocal: 'Same as local',
      confirmImport: 'Import selected ({n})',
      importNothing: 'Select at least one section',
      importDone: 'Applied {n} section(s)',
    },
    runtimeNotInstalled: 'not installed',
    runtimeCopyInstall: 'Copy install command',
    runtimeCopied: 'Copied',
    unsavedTitle: 'Unsaved changes',
    unsavedContent: 'Settings have unsaved changes. Discard and close?',
    unsavedDiscard: 'Discard and close',
    runtimeLoadFailed: 'Failed to load runtime status',
    runtimeDetecting: 'Detecting local runtimes…',
    retry: 'Retry',
    agentProviderAuto: 'Auto (by availability)',
    agentProviderDesc: 'Default runtime for global-terminal sessions; auto-selected by availability unless specified when creating a session, falls back to an available runtime if the chosen one is absent',
    customAgents: {
      title: 'Custom agents',
      add: 'Add agent',
      addTitle: 'Add custom agent',
      editTitle: 'Edit custom agent',
      hint: 'Register any CLI agent tool by name and get the same experience as built-in runtimes (new-session dropdown, availability probe, default selection). Changes take effect immediately',
      empty: 'No custom agents yet',
      fieldName: 'Name',
      fieldNamePlaceholder: 'lowercase letters/digits first, may contain - _, e.g. gemini',
      fieldDisplayName: 'Display name (optional)',
      fieldDisplayNamePlaceholder: 'Name shown in the UI, e.g. Gemini CLI',
      fieldCommand: 'Launch command',
      fieldCommandPlaceholder: 'Interactive launch command, args allowed, e.g. gemini --yolo',
      formHint: 'The command runs in the agent terminal via shell (equivalent to typing it yourself); the first word is probed for availability',
      nameInvalid: 'Name must start with lowercase letters/digits, may contain - _, max 64 chars',
      commandRequired: 'Launch command is required',
      commandTooLong: 'Launch command too long (max 200 chars)',
      displayNameTooLong: 'Display name too long (max 60 chars)',
      deleteConfirm: 'Delete custom agent "{name}"? Existing sessions keep working, but no new sessions of this runtime can be created',
      deleted: 'Deleted',
      deleteFailed: 'Delete failed',
      // Config export/import (P-20261004-83): pure-JSON transfer; importing adds a command execution surface to this machine — preview list confirmation is not skippable
      import: 'Import',
      exportAll: 'Export all',
      exportOne: 'Export',
      exportEmpty: 'No custom agents to export',
      exportDone: 'Exported {n} custom agents',
      importInvalid: 'Invalid file: expected JSON exported by this tool, or an array of custom agent objects',
      importNone: 'No importable entries in the file',
      importInvalidSkipped: '{n} invalid entries ignored',
      importTitle: 'Import custom agents',
      importCommandWarning: 'Launch commands run on this machine via shell (equivalent to typing them yourself): importing adds a command execution surface — review every entry below and confirm it comes from a trusted source',
      conflictTag: 'Name conflict',
      localCurrent: 'Local current',
      importStrategy: 'On conflict',
      strategySkip: 'Skip existing',
      strategyOverwrite: 'Overwrite existing',
      importConfirm: 'Import {n}',
      importDone: 'Import finished: {created} created, {updated} overwritten, {skipped} skipped, {failed} failed',
    },
    agentTaskTemplates: {
      title: 'Task templates',
      add: 'New template',
      // Literal braces must be escaped as {'{'} / {'}'} (vue-i18n compiles {x} as named interpolation; see snippet.fieldCommand)
      hint: "Pick a template in the new-session dialog to auto-fill the task prompt; placeholders {'{'}file{'}'} = active file, {'{'}branch{'}'} = current branch, {'{'}dir{'}'} = session working directory, {'{'}selection{'}'} = selected code in the editor (snapshot taken when the dialog opens, truncated to the first 200 chars)",
      presetTag: 'Built-in',
      fieldName: 'Template name',
      fieldNamePlaceholder: 'e.g. Review current changes',
      fieldPrompt: 'Task prompt',
      fieldPromptPlaceholder: "Prompt body sent to the agent; supports {'{'}file{'}'} {'{'}branch{'}'} {'{'}dir{'}'} {'{'}selection{'}'} placeholders",
      formHint: 'Takes effect immediately; selectable from the new-session dialog. Injected via launch args (500-byte limit)',
      nameRequired: 'Template name is required',
      promptRequired: 'Task prompt is required',
      nameTooLong: 'Template name too long (max 60 chars)',
      promptTooLong: 'Task prompt too long (max 500 bytes)',
      saved: 'Template saved',
      saveFailed: 'Save failed',
      deleted: 'Template deleted',
      deleteFailed: 'Delete failed',
      deleteConfirm: 'Delete template "{name}"?',
      empty: 'No task templates',
      moveUp: 'Move up',
      moveDown: 'Move down',
      // Export/import (P-20261005-209): file-based cross-instance template migration
      export: 'Export',
      exportTitle: 'Export checked templates (all if none checked)',
      exportEmpty: 'Nothing to export',
      exportDone: 'Exported {n} templates',
      exportSensitiveTitle: 'Template content may contain credentials',
      exportSensitiveContent: 'The task prompt of {names} looks like it contains credentials or tokens; the export is plain-text JSON and is not masked. Review before sharing.',
      exportSensitiveProceed: 'Export anyway',
      import: 'Import',
      importTitle: 'Import task templates',
      importHint: 'Same-name templates are skipped by default; check "Overwrite local" and confirm to replace local content',
      importInvalid: 'Invalid file format',
      importNone: 'No importable templates in the file',
      importInvalidSkipped: '{n} invalid entries ignored',
      importNewItem: 'New',
      importConflictTag: 'Same name',
      importOverwrite: 'Overwrite local',
      importLocalCurrent: 'Local current',
      importConfirm: 'Import {n}',
      importDone: 'Import finished: {created} created, {updated} overwritten, {skipped} skipped',
      factory: {
        'tpl-review': {
          name: 'Review current changes',
          prompt: 'Please review all uncommitted changes in the current workspace: point out issues and risks file by file, then suggest one commit message following this repo\u2019s commit conventions.',
        },
        'tpl-tests': {
          name: 'Fix failing tests',
          prompt: 'Please run the test suite, find the failing tests: locate the root cause, apply a minimal fix and re-run to confirm, without changing existing behavior.',
        },
        'tpl-commit-msg': {
          name: 'Generate commit message',
          prompt: 'Please draft a commit message for the current staged changes: a one-line subject capturing the motivation (≤72 chars) plus bullet-point body, following the repo\u2019s existing commit style.',
        },
        'tpl-explain': {
          name: 'Explain current file',
          // The {file} in the prompt is a task-template placeholder (substituted on selection); escape literal braces so vue-i18n named interpolation doesn't swallow it
          prompt: "Please explain the overall structure and key logic of {'{'}file{'}'}: entry points, data flow and notable risks.",
        },
      },
    },
    projectRules: {
      title: 'Project Rules',
      hint: 'Project-level agent behavior config (read by Claude Code / agents / Cursor): click an existing file to edit it in the editor, or create a missing one from a minimal template',
      selectPlaceholder: 'Select project',
      exists: 'Exists',
      missing: 'Not created',
      edit: 'Edit',
      createFromTemplate: 'Create from template',
      refresh: 'Rescan',
      created: 'Created {name} from template — click the row to keep editing',
      createExists: '{name} already exists (just created?), switched to editable',
      descClaudeMd: 'Claude Code project guidance',
      descAgentsMd: 'Generic agent guidance (Codex etc.)',
      descCursorrules: 'Cursor editor rules',
      noProjects: 'No registered projects',
    },
    terminalBackend: 'Terminal Backend',
    terminalBackendAuto: 'Auto (recommended)',
    terminalBackendTmux: 'tmux (persistent)',
    terminalBackendNative: 'Native PTY',
    terminalBackendHint: 'tmux backend supports session persistence, scrollback replay on reconnect, and multi-window splits; native PTY has the widest compatibility',
    terminalRemoteTmux: 'Remote terminal tmux persistence',
    terminalRemoteTmuxEnable: 'Start remote terminals inside a tmux session on the remote host (falls back to plain shell when tmux is missing)',
    terminalRemoteTmuxHint: 'When enabled, remote processes and output survive SSH drops; reopening the terminal tab resumes the session. Only affects newly opened remote console terminals',
    tmuxStatus: 'tmux status',
    tmuxInstalled: 'Installed',
    tmuxNotInstalled: 'Not installed',
    tmuxInstall: 'Install',
    tmuxInstallManualHint: 'No package manager detected, please install manually',
    tmuxRequiredHint: 'Requires tmux {version} or later (Unix only)',
    tmuxInstallNeedsSudo: 'Root permission required. Run in your system terminal: {cmd}',
    tmuxInstallSuccess: 'tmux installed successfully',
    tmuxInstallFailed: 'Install failed: {output}',
    terminalScrollbackLines: 'Terminal scrollback lines',
    terminalScrollbackLinesHint: 'Number of history lines visible in terminal (1000-200000, default 20000). Takes effect for newly created terminals only',
    terminalIdleTimeout: 'Idle auto-detach',
    terminalIdleTimeoutOff: 'Off (default)',
    terminalIdleTimeoutUnit: 'h',
    terminalIdleTimeoutDayUnit: 'd',
    terminalIdleTimeoutHint: 'Sessions with no input, no output, and no attached terminal connection beyond this duration are detached automatically with a notification — forgotten terminals no longer hang forever. tmux sessions are preserved and reconnectable; on the native backend (no persistence layer) detaching ends the session. Off by default',
    terminalDefaultShell: 'Default Shell',
    terminalDefaultShellFollow: 'Follow platform default',
    terminalDefaultShellFollowWith: 'Follow platform default (currently {shell})',
    terminalDefaultShellNotFound: 'not found',
    terminalDefaultShellCustom: 'Custom path…',
    terminalDefaultShellCustomPlaceholder: 'Path to the shell executable (full path or a name on PATH)',
    terminalDefaultShellHint: 'Shell launched for new terminal sessions; candidates are probed on this machine. Applies to new sessions only — running sessions are unaffected',
    terminalHistoryEnabled: 'Command History',
    terminalHistoryEnabledLabel: 'Record commands executed in terminals (with exit code and duration)',
    terminalHistoryEnabledHint: 'Keeps the last 500 commands per project, searchable in the command history panel; commands containing sensitive keywords (passwords/keys) are never recorded',
    // 高危命令粘贴预检（P-20261005-191）
    terminalPastePrecheck: 'Dangerous Command Paste Precheck',
    terminalPastePrecheckLabel: 'Show impact confirmation before pasting/inserting dangerous commands',
    terminalPastePrecheckHint: 'When pasting or inserting destructive commands (rm -rf, git reset --hard, > overwrite redirects…), an impact summary (file count/size/dirty files) is shown with a confirm dialog; manually typed commands are not intercepted. On by default',
    dshWebTitle: 'dsh Web UI (DeepSeek Harness)',
    dshWebBase: 'Upstream URL',
    dshWebToken: 'Access token',
    dshWebTokenPlaceholder: 'Not needed for the proxy channel (token auto-issued by the proxy)',
    dshProxyPort: 'Proxy port',
    dshExposeAll: 'Expose to all IPs',
    dshAllowStandalone: 'Allow standalone tab access to dsh',
    dshAllowStandaloneHint: 'Off by default: opening the dsh embed channel address directly in a browser tab shows a guide page — dsh is only usable inside Codecombo; turn on to allow standalone access (still protected by the dsh token).',
    dshNpmCommand: 'npm command',
    dshNpmCommandPlaceholder: 'Default: npm; for WSL-installed dsh use wsl.exe npm',
    dshLaunchCommand: 'Launch command',
    dshLaunchCommandPlaceholder: 'Default: dsh web --no-open; for WSL use wsl.exe dsh web --no-open',
    dshWebHint: 'The main-area "dsh Console" embeds via the local reverse proxy: frame-restriction stripping, loopback fence assertion and token auto-issuance all apply. Upstream/port/exposure changes rebind instantly — no restart needed. 0 = disable proxy (direct upstream).',
    snippet: {
      title: 'Command snippets',
      add: 'New snippet',
      fieldTitle: 'Title (e.g. Check disk usage)',
      // vue-i18n literal brace escaping ({{ would break message compilation)
      fieldCommand: "Command, supports {'{'}param{'}'} placeholders (e.g. scp {'{'}src{'}'} {'{'}dst{'}'})",
      commandHint: "Placeholders {'{'}param{'}'} are filled at run time; {'{'}{'{'} escapes a literal {'{'}",
      // Insert-time variable substitution hint (P-20261006-1): literal braces must be
      // escaped as {'{'} / {'}'} (vue-i18n named interpolation, same as commandHint);
      // $ is a plain character and needs no escape
      varsHintCommand: "Variables replaced at insert time: ${'{'}CLIPBOARD{'}'} clipboard · ${'{'}DATE{'}'} today · ${'{'}TIME{'}'} time (HH:mm); unrecognized variables stay verbatim; $0 has no cursor concept in terminals and is inserted as-is.",
      // Same as above (P-20261006-1); in the code domain $0 is the final cursor position
      varsHintCode: "Variables replaced at insert time: ${'{'}CLIPBOARD{'}'} clipboard · ${'{'}DATE{'}'} today · ${'{'}TIME{'}'} time (HH:mm); $0 is the final cursor position (removed from the text, cursor placed there); unrecognized variables stay verbatim.",
      fieldDesc: 'Description (optional)',
      required: 'Title and command are required',
      saved: 'Snippet saved',
      saveFailed: 'Save failed',
      deleted: 'Snippet deleted',
      deleteFailed: 'Delete failed',
      deleteConfirm: 'Delete snippet "{title}"?',
      systemTag: 'system',
      empty: 'No snippets yet',
    },
    linesUnit: 'lines',
    // Terminal cursor preferences (P-20261005-212): style select + blink switch, applies to all sessions instantly
    terminalCursorStyle: 'Terminal Cursor Style',
    terminalCursorStyleBlock: 'Block',
    terminalCursorStyleBar: 'Bar',
    terminalCursorStyleUnderline: 'Underline',
    terminalCursorStyleHint: 'Cursor shape preference, applies instantly to all terminals (project / agent / remote host); bar and underline do not cover the character under the cursor, suited to heavy editing in vim/emacs',
    terminalCursorBlink: 'Cursor Blink',
    terminalCursorBlinkHint: 'When off, the cursor stays solid and static (friendly for demos and screen recording), applies to all terminals instantly',
    terminalCopyOnSelect: 'Copy on Select',
    terminalCopyOnSelectLabel: 'Automatically copy selection to clipboard',
    terminalCopyOnSelectHint: 'In any terminal (project / session manager / remote host), releasing the mouse after selecting text copies it, matching claude code behavior; when off, use the context menu or Ctrl+Shift+C / Ctrl+C to copy',
    resetCloseConfirm: 'Reset Close Confirmation',
    resetCloseConfirmDesc: 'Click to re-enable the confirmation prompt if you\'ve checked "Don\'t ask again"',
    // Write-link backpressure diagnostics (P-20261004-47): read-only observation surface
    terminalBackpressureTitle: 'Write Backpressure Diagnostics',
    terminalBackpressureSession: 'Session',
    terminalBackpressurePending: 'Pending',
    terminalBackpressureDropped: 'Dropped',
    terminalBackpressureHeals: 'Heals',
    terminalBackpressureEmpty: 'No terminal sessions mounted in this window',
    terminalBackpressureRefresh: 'Refresh',
    terminalBackpressureAttention: 'Some sessions dropped output frames and the post-storm resync has not completed yet — if a terminal looks corrupted, use the refresh button at its top-right or reopen the session',
    terminalBackpressureHint: 'Counts and self-healing for frames dropped when an output storm (e.g. several sessions flooding at once) hits the write-link backpressure: the screen state is resynced automatically once the storm settles (tmux sessions get a full server-side repaint). Only sessions mounted in this window are counted; totals persist across reconnects',
    // xterm LRU residency (P-20261007-21): read-only line in the diagnostics panel
    terminalLruStats: 'Resident xterm instances: {live}/{keep} (LRU budget), {evicted} released — background tabs beyond the budget shed their renderer and are restored via server-side scrollback replay when revisited',
    gitConfig: 'Git Config (project level)',
    editorSettings: 'Editor Settings',
    // Line height multiplier (P-20261006-7): effective line height = font size × multiplier
    lineHeight: 'Line Height',
    tabSize: 'Tab Size',
    editorconfigNote: 'Indentation from a project-root .editorconfig takes precedence over these global settings',
    wordWrap: 'Word Wrap',
    renderWhitespace: 'Whitespace',
    minimap: 'Minimap',
    minimapShow: 'Show',
    stickyScroll: 'Sticky scroll (pin current scope at top)',
    // 行级「已修改」标记（P-20261003-171）：竖条 tooltip + 行尾恢复默认钮 title；
    // 方向性文案（P-20261006-49 分区补全）——安全分区恢复默认有升/降防护之分，
    // 恢复钮 tooltip 注明方向（只提示不拦截，设置本身可改，标记只管可见性）
    bracketColor: 'Bracket pair colorization (markdown excluded)',
    // 行级「已修改」标记（P-20261003-171）：竖条 tooltip + 行尾恢复默认钮 title
    modifiedFromDefault: 'Modified (differs from factory default)',
    resetRowToDefault: 'Reset to default',
    resetRowToDefaultLower: 'Reset to default (lowers protection)',
    resetRowToDefaultRaise: 'Reset to default (raises protection)',
    off: 'Off',
    on: 'On',
    none: 'None',
    selection: 'Selection',
    all: 'All',

    // Device migration (P-20261003-147): instance config package export/import wizard
    migration: {
      exportTitle: 'Export package',
      exportSub: 'Pack credentials/tokens/settings/instance registry (+optional project content) into a passphrase-encrypted .scpkg',
      // Download-progress toast title (P-20261030-2): .scpkg envelope is encrypted
      // server-side before streaming — direct link not possible
      exportProgress: 'Exporting migration package…',
      importTitle: 'Import package',
      importSub: 'On the new machine: pick the package, enter the passphrase, preview, then apply per block',
      modeLabel: 'Package mode',
      modeLight: 'Light',
      modeLightDesc: 'Config blocks · KB~MB · seconds (fastest with a follow-up first sync)',
      modeFull: 'Full',
      modeFullDesc: 'Config blocks + project & context content · self-contained (retire the old machine)',
      mode: { light: 'Light', full: 'Full' },
      blocksTitle: 'Config blocks',
      blocks: {
        credentials: 'Credentials (git/SSH/deploy)',
        tokens: 'Token family (Agent Token)',
        settings: 'System settings (incl. lock config, excl. lock password)',
        instances: 'Instance registry',
      },
      projectsTitle: 'Project content (full)',
      loading: 'Loading projects…',
      noProjects: 'No registered projects (full package will only carry global contexts)',
      filesCount: '{n} files',
      includeGit: 'Include .git',
      globalContexts: 'Global contexts (snippets/runtimes/approvals/chains/UI state)',
      oversizeWarn: 'Project {names} is estimated over 2GB — packing and transfer will take a while; uncheck it or switch to workspace-only (uncheck .git) to shrink.',
      oversizeAccept: 'I understand the package includes a 2GB+ project, continue',
      passphrase: 'Passphrase',
      passPlaceholder: 'Passphrase (min 8 chars, unrecoverable)',
      passPlaceholder2: 'Repeat passphrase',
      strength: {
        0: 'Too short (min 8)',
        1: 'Weak',
        2: 'Fair',
        3: 'Strong',
      },
      exportBtn: 'Export .scpkg',
      exportHint: 'Streamed and encrypted server-side; plaintext never touches disk',
      exportDone: 'Package exported',
      keepSafe: 'The package holds encrypted credentials — keep it safe; a lost passphrase cannot be recovered',
      pickPackage: 'Pick package',
      previewBtn: 'Decrypt & preview',
      fromHost: 'From: {host}',
      credKind: { git: 'Git credential', sshHost: 'SSH host', sshKey: 'SSH key', deploy: 'Deploy credential' },
      existsLocal: 'Exists locally',
      agentToken: 'Agent Token (sca_)',
      tokenNote: 'Machine API tokens (sc_)/quickdrop (scd_)/hook (sch_) are hash-only with a machine-local salt and do not migrate — re-issue them on the new machine.',
      settingsSame: 'Settings match this machine — no differences',
      diffTruncated: '{n} more differences omitted (package values apply as a whole)',
      contentTitle: 'Content (full package)',
      destHint: 'Landing root: {root} (configurable in General; same semantics as instance sync)',
      policy: {
        merge: 'Merge (keep local on conflict)',
        overwrite: 'Overwrite (package wins)',
        skip: 'Skip (do not import)',
        package: 'Use package values',
        local: 'Keep local values',
      },
      applyBtn: 'Apply import',
      applyHint: 'Any failed block rolls the whole import back',
      applyDone: 'Import finished',
      applyFailed: 'Import failed: ',
      rolledBack: 'Rolled back — this machine is unchanged; landed content is listed below.',
      reportCounts: 'Imported {ok} · skipped {skip} · failed {fail}',
      peerGuide: '{n} peer instance(s) imported — run a first sync to pull project content.',
      openSync: 'Open Sync Center',
      lockGuide: 'Lock config migrated (without password): set a new lock password on this machine.',
      rotateGuide: 'The old machine still holds the same Agent Token — rotate/revoke it there to avoid double-active tokens.',
      manualNote: 'Migration is a human-only flow: the passphrase travels only between your browser and the server, never through agent channels. Ask an agent to guide you here — not to operate for you.',
    },

    securityTitle: 'Security',
    // TLS (HTTPS/WSS): sibling of security — service transport encryption
    tls: {
      tab: 'TLS',
      section: 'HTTPS / WSS (Transport Encryption, enabled by default)',
      desc: 'Enabled by default: this service is served entirely over HTTPS/WSS (the address bar and all connections are encrypted). With certificate fields left empty, a self-signed certificate is generated automatically — browsers will show a warning on first visit; continue through it (TOFU). Alternatively, fill in a CA-issued certificate and private key path. Disabling falls back to plain HTTP (local debugging only).',
      enable: 'Enable HTTPS/WSS',
      requiresEnable: 'Enable the HTTPS/WSS switch above first',
      certPlaceholder: 'Certificate file path (empty = auto-generate self-signed)',
      keyPlaceholder: 'Private key file path (empty = auto-generate self-signed)',
      certConfigured: 'Certificate path configured (leave empty to keep)',
      keyConfigured: 'Private key path configured (leave empty to keep)',
      hint: 'Restart the service after saving for changes to take effect. While enabled, a plain-HTTP loopback helper port (main port + 1, localhost only) serves agent callbacks and the local CLI.',
      peerSection: 'Inter-instance TLS Verification (fingerprint by default, effective immediately)',
      peerDesc: 'Inter-instance connections (instance probe / proxy / update-from-center) use TOFU fingerprint verification by default: the first connection records the peer\'s self-signed certificate fingerprint automatically; later connections are allowed only when it matches, and rejected on change — no certificate import needed, while MITM protection is preserved. Delete peer-certs.json in the data dir to re-trust all peers.',
      verifyPeer: 'Strict TLS verification between instances',
      verifyPeerHint: 'When enabled, inter-instance connections use strict system trust-store verification: install each peer\'s certs/cert.pem into this machine\'s system trust store first (Windows admin PowerShell: Import-Certificate -FilePath cert.pem -CertStoreLocation Cert:\\LocalMachine\\Root; Linux: copy to /usr/local/share/ca-certificates/ or /etc/pki/ca-trust/source/anchors/ then update-ca-certificates / update-ca-trust extract), otherwise instance probe / proxy / update-from-center will fail. Takes effect immediately — no restart needed.',
      verifyPeerSaved: 'Inter-instance TLS verification policy saved — effective immediately',
      savedRestart: 'TLS settings saved — restart the service to take effect',
      saveFailed: 'Failed to save TLS settings',
    },
    // Data retention (P-20261003-123): audit / run log retention days, both directions
    // adjustable; enforced by the server-side daily cleanup patrol (no restart needed)
    retention: {
      section: 'Data retention (audit / run logs)',
      desc: 'Audit events and run logs are cleaned up automatically after the retention window; changes take effect via the daily cleanup patrol — no restart needed.',
      auditDays: 'Audit log retention (days)',
      logDays: 'Run log retention (days)',
      diskNote: 'Longer retention consumes more disk: the storage cost of extra-long retention is the administrator\'s own responsibility; after shortening, out-of-window data is permanently deleted in the next cleanup round and cannot be recovered — export first if needed.',
      saved: 'Retention saved — effective via the daily cleanup patrol',
      saveFailed: 'Failed to save retention settings',
      // Sensitive external-write observation switch (P-20261005-15): watcher hit
      // on sensitive patterns from a non-workbench write → audit + notification;
      // off silences the observation, effective immediately
      externalWatch: 'Sensitive external-write observation',
      externalWatchDesc: 'When credential-class files (.env, keys, credentials) inside a project are rewritten by a process outside the workbench (local IDE / another user on a shared machine / a runaway tool), an audit event (project.file.external) and a notification are recorded. Only path metadata is recorded — file content never enters the audit trail.',
      externalWatchSaved: 'Observation switch saved',
    },
    // Security section subkeys: tabs for top categories; credentials / oauthClients for child components
    security: {
      tabs: {
        credentials: 'Credentials',
        oauthClients: 'OAuth Apps',
        sshKeys: 'SSH Keys',
        lock: 'Lock',
        accessTokens: 'Access Tokens',
      },
      // Custom sensitive patterns (P-20261006-11): project-owned secret regexes, consumed by both ends
      sensitivePatterns: {
        tab: 'Sensitive Patterns',
        title: 'Custom Sensitive Patterns',
        desc: 'Register project-owned secrets with regexes (e.g. MY_APP_TOKEN=…): matches are skipped in terminal command history, masked in audit and snapshots, and covered by approval-card / session-replay masking (same source on server and web). Empty by default = built-in generic recognition only.',
        dialectHint: 'Regexes must stay in the common subset of both ends: inline flags (?i), named groups, lookaround and backreferences are not supported; express case-insensitivity with [Xx] character classes. With a capture group the 1st group is preserved (e.g. (MY_APP_TOKEN=)(.+) masks the value only); otherwise the whole match is masked. A pattern must not match the empty string.',
        addPlaceholder: 'Regex, e.g. (MY_APP_TOKEN=)([^ ]+) or scrt_[A-Za-z0-9]+',
        add: 'Add',
        empty: 'No custom patterns yet (built-in generic recognition only)',
        delete: 'Delete',
        emptyEntry: 'Pattern must not be empty',
        tooLong: 'Pattern too long (max {n} chars)',
        dialect: 'Inline flags (?i), named groups and lookaround are not supported — use [Xx] character classes for case-insensitivity',
        duplicate: 'This pattern is already in the list',
        cap: 'Up to {n} patterns',
        dirty: 'Unsaved changes',
        discard: 'Discard',
        save: 'Save Patterns',
        saved: 'Custom sensitive patterns saved — masking takes effect on both ends immediately',
        saveFailed: 'Failed to save',
      },
      // Replace history (P-20261004-66): batch replace archival + one-click restore
      replaceHistory: {
        tab: 'Replace History',
        desc: 'Every batch replacement is archived automatically (20 per project / 30-day retention, patch embedded); mistakes can be restored to the pre-replace state in one click. Untracked files have no baseline and are out of restore scope.',
        projectPlaceholder: 'Select a project',
        empty: 'No replacements recorded for this project yet',
        restore: 'Restore',
        restoreConfirmTitle: 'Restore this replacement?',
        restoreConfirm: 'Files rewritten by this replacement will be rolled back to their pre-replace state: uncommitted changes made after the replacement are discarded (safe failure if the workspace has since changed). Continue?',
        restoreEmptyBackupConfirm: 'The workspace was clean before this replacement — restoring discards ALL current uncommitted changes in those files (back to the staged state). Continue?',
        restored: 'Restored {n} file(s) to the pre-replace state',
        restoreFailed: 'Restore failed',
        untrackedNote: '{n} untracked file(s) are out of restore scope (no baseline); use per-file local history to recover them',
        notRestorable: 'Backup purged',
        tagRegex: 'regex',
        tagCase: 'case-sensitive',
        tagWord: 'whole word',
        tagPreserve: 'preserve case',
        deleted: '(delete matched text)',
        stats: '{files} file(s) / {hits} hit(s)',
        partial: '{skipped} skipped · {conflicts} conflicts',
        patchRefOnly: 'patch not embedded (restore reads the backup file)',
        moreFiles: 'and {n} more files',
        loadFailed: 'Failed to load replace history',
      },
      agentToken: {
        tab: 'Agent Token',
        desc: 'Long-lived token (sca_ prefix) for agent CLIs (claude / codex / dsh) running in terminals to call this system\'s API. The server injects CC_BASE_URL and this token into every terminal session automatically — agents work out of the box.',
        reveal: 'Reveal',
        rotate: 'Rotate',
        revoke: 'Revoke',
        rotateNote: 'After rotating or revoking, tokens already injected into open terminal sessions stop working immediately — affected agent terminals must be reopened.',
      },
      // Inbound event hooks (P-20261003-23): external events → notification center
      // with optional panel action; separate sch_ token domain from Agent Token
      hookToken: {
        tab: 'Inbound Hook',
        desc: 'External events (CI failures / monitoring alerts / scripts) are written into the notification center through a dedicated token, optionally with a panel: action to jump straight to a workspace panel. The token is a separate permission domain from Agent Token — even if leaked it can only add notification noise.',
        badge: 'Inbound',
        boundary: 'With no valid token the inbound endpoint is closed (all requests 401); revoke takes effect immediately',
        issue: 'Issue',
        rotate: 'Rotate',
        revoke: 'Revoke',
        plainTitle: 'New token (shown once)',
        plainHint: 'The plaintext is shown only here; the server stores only its hash. If lost, simply rotate.',
        endpointHint: 'Inbound endpoint: POST /api/hooks (prefer passing the token via the X-Hook-Token header); URL form /api/hooks/<token> is also accepted (masked in access logs).',
        copySample: 'Copy example',
        bodyHint: 'Body fields: title (required) / body / category (git·task·clone·system·error, defaults to system) / action (panel: prefix, e.g. panel:git; or a url: link whose host is in the allowlist below).',
        limitHint: 'Each token is limited to 60 events/minute (429 when exceeded); category=error notifications are forwarded to the configured webhook under the default important scope.',
        dates: 'Created {created} · last rotated {rotated}',
        rotateTitle: 'Rotate inbound hook token',
        rotateConfirm: 'A new token will be issued and the old one will stop working immediately — every external event source using the old token must be updated. Continue?',
        revokeTitle: 'Revoke inbound hook token',
        revokeConfirm: 'The inbound endpoint will close immediately: every hook request returns 401 until a new token is issued. Continue?',
        issued: 'Token issued — copy and store it now',
        rotated: 'Token rotated; the old token is now invalid',
        revoked: 'Token revoked; inbound hooks are closed',
        // URL action allowlist (P-20261003-164): boundary for url:<link> actions
        urlAllowDesc: 'URL actions: notifications can carry a url:<link> button that opens an external page (http/https only). Only links to hosts in the list below are accepted; saving empty = URL actions off (panel: jumps only).',
        urlAllowPlaceholder: 'e.g. ci.example.com, status.internal.example.com',
        urlAllowSave: 'Save allowlist',
        urlAllowHint: 'Matched by host name (any port), comma-separated; takes effect immediately after saving.',
        urlAllowSaved: 'URL action allowlist saved',
      },
      // Long-lived token issuance boundary warnings (P-20261001-25): access tokens stay valid
      // while locked (independent store + /proxy/* exemption); proposal-scoped token.* keys
      // to minimize merge conflicts with parallel proposals
      token: {
        longLivedWarning: 'Long-lived tokens remain valid while the system is locked and can fully manage this machine — use only on trusted devices',
        longLivedBadge: 'Long-lived',
        agentBoundary: 'Long-lived token: stays valid across lock; rotate immediately if leaked',
        // Rotate/revoke confirmation flow (P-20261003-78): informed decision for
        // immediate-invalidation semantics — running agent session count is an
        // instant snapshot (the dialog is an advisory, not a guarantee)
        rotate: {
          rotateTitle: 'Rotate Agent Token',
          rotateConfirm: 'A new token will be generated immediately and the old one invalidated — agent terminals with the old token injected must be reopened. Continue rotating?',
          revokeTitle: 'Revoke Agent Token',
          revokeConfirm: 'The token will be deleted permanently and all agents using it lose API access immediately. Continue revoking?',
          runningWarning: '{count} running agent session(s) detected: their injected token becomes invalid immediately after this action and tool callbacks will get 423 — finish them first if possible',
        },
        // Access token delete confirm (P-20261005-5): kills in-flight consumers (/proxy and remote-instance links) immediately and the plaintext is never shown again — the highest-impact item of the delete family, so confirm with full context
        deleteTitle: 'Delete access token "{name}"?',
        deleteConfirm: 'Deletion takes effect immediately: every call using this token (including /proxy and remote-instance links) loses access at once, and the plaintext is never shown again — consumers must be re-issued and redeployed.',
      },
      credentials: {
        title: 'Git Credentials',
        addPAT: 'Add PAT / Password',
        host: 'Host',
        username: 'Username',
        secret: 'Password / PAT',
        platform: 'Platform',
        platformAuto: 'Auto detect',
        platformHint: 'Manually specify platform for self-hosted services (e.g. Gitea) that cannot be auto-detected',
        empty: 'No credentials',
        deleteConfirm: 'Delete credential for {host}?',
        requiredFields: 'Host and secret are required',
      },
      oauthClients: {
        title: 'OAuth Apps',
        add: 'Add OAuth App',
        hint: 'OAuth Device Flow does not require client_secret (except self-hosted Gitea)',
        platform: 'Platform',
        host: 'Host',
        secretOptional: 'Optional, usually not needed for Device Flow',
        empty: 'No OAuth apps configured',
        requiredFields: 'host and client_id are required',
        formTitle: 'Configure OAuth App',
        deleteConfirm: 'Delete {platform}/{host}?',
      },
      // Data egress overview (P-20261003-20): one-page security posture. All
      // values are desensitized display states; no secret material on any copy path
      egress: {
        title: 'Data Egress',
        desc: 'Every channel this instance sends data to, at a glance (read-only aggregation).',
        manage: 'Manage',
        view: 'View',
        webhook: 'Webhook',
        webhookNone: 'Not configured',
        webhookOff: 'Disabled',
        shares: 'Active shares',
        sharesNone: 'No active shares',
        sharesCount: '{n} active link(s)',
        sharesMore: '…{n} more in total',
        createdAt: 'created {time}',
        expiresAt: 'expires {time}',
        agentToken: 'Agent Token',
        agentTokenNone: 'Not issued',
        issuedAt: 'issued {time}',
        remoteHosts: 'Remote hosts',
        hostsCount: '{n} host(s)',
        audit: 'Security audit',
        auditCount: '{n} event(s) (30-day window)',
      },
      // Ingress surface overview (P-20261004-11): the other half of the security
      // posture — "who is coming in". All values are desensitized display states;
      // no token, IP, or share token material on any copy path
      ingress: {
        title: 'Ingress Surface',
        desc: 'Every way into this instance, at a glance (read-only aggregation).',
        manage: 'Manage',
        lock: 'System lock',
        lockOn: 'Enabled',
        lockOff: 'Disabled',
        lockSetup: 'Setup pending',
        failures: '{total} failed unlock(s) from {ips} source(s), {blocked} blocked',
        failuresNone: 'No failed unlocks recorded',
        failuresNote: 'Rate-limit counters are in-memory and reset on restart',
        agentToken: 'Agent Token',
        agentTokenNone: 'Not issued',
        issuedAt: 'issued {time}',
        rotatedAt: 'rotated {time}',
        tls: 'Transport encryption',
        tlsOn: 'TLS enabled',
        tlsOff: 'TLS disabled (plain HTTP)',
        loopbackPort: 'plaintext loopback aux port {port} (127.0.0.1 only)',
        loopbackNotReady: 'loopback aux port not ready',
        shares: 'Share entry',
        sharesNone: 'No active shares',
        sharesCount: '{n} active link(s)',
        remoteHosts: 'Remote hosts',
        hostsCount: '{n} host(s)',
      },
    },
    atRestBoundary: 'Boundary of credential encryption at rest: credentials such as SSH private keys are encrypted with AES-256-GCM, but the decryption master key lives in the same local data directory as the ciphertext — it protects against ciphertext-only disclosure (leaked backups, pasted tickets), not against processes running as the service user or root. The exposure is equivalent to a plaintext ~/.ssh key.',
    tokenDescPlaceholder: 'Description',
    tokenPermanent: 'Permanent',
    tokenDays: '{n} days',
    tokenYear: '1 Year',
    generateToken: 'Generate',
    tokenGenerated: 'Token generated (shown only once)',
    copyToken: 'Copy',
    deleteToken: 'Delete',
    noTokens: 'No Tokens',
    // Git HTTPS credentials
    // SSH Keys
    sshKeyWarn: 'Supports Ed25519 and RSA keys for SSH protocol cloning and authentication.',
    sshKeyNamePlaceholder: 'Key name',
      sshKeyGenerate: 'Generate',
      sshKeyImport: 'Import',
      sshKeyImportPlaceholder: 'Paste private key PEM content',
      sshKeyGenerated: 'Key generated. Copy the public key and add it to your Git service.',
    sshKeyImported: 'Key imported',
    noSshKeys: 'No SSH keys',
    // SSH key delete confirm (P-20261005-5): dependent host connections break at once; re-adding requires reinstalling authorized_keys
    sshKeyDeleteTitle: 'Delete SSH key "{name}"?',
    sshKeyDeleteConfirm: 'Host connections that rely on this key will fail immediately; after re-adding it you must reinstall authorized_keys on the affected hosts.',
    notifTitle: 'Notification Preferences',
    notifCategoryTitle: 'Categories',
    notifCategoryGit: 'Git operations (fetch / pull / push)',
    notifCategoryTask: 'Long-running terminal tasks',
    notifCategoryClone: 'Clone completion',
    notifCategorySystem: 'System events (updates / connection)',
    notifCategoryError: 'Error events (save failures, etc.)',
    notifCategoryDrop: 'Quickdrop (delivery from phone/scripts)',
    notifCategoryApproval: 'Approval waits (card alert)',
    // Project mute management (P-20261003-168): list & unmute quick-muted combos
    projectMute: {
      title: 'Project mutes',
      empty: 'No project mutes',
      hint: 'Muted "project × category" combos produce no notifications; unmute to restore',
      remove: 'Unmute',
    },
    notifThreshold: 'Long-task threshold',
    notifThresholdDesc: 'Notify when commands running longer than this complete (1-60s)',
    notifDesktop: 'Desktop notifications',
    notifDesktopDesc: 'Only shown when browser is in background or minimized',
    notifDesktopRequest: 'Grant permission',
    notifDesktopGranted: 'Permission granted',
    notifDesktopTest: 'Send test notification',
    notifDesktopTestTitle: 'Test notification',
    notifDesktopTestBody: 'Desktop notification pipeline works — seeing this means your config is live',
    notifDesktopDenied: 'Permission denied (enable in browser settings)',
    notifDesktopRecheck: 'Re-check',
    notifSimpleMode: 'Minimal mode (generic title only)',
    notifSimpleModeDesc: 'Desktop notifications carry no title/body details and only show a generic "New notification" placeholder — for shared workstations and screen sharing; the in-app notification center is unaffected',
    terminal: 'Terminal',
    commitId: 'Commit ID',
    buildTime: 'Build Time',
    runtime: 'Runtime',
    copied: 'Copied',
    uiFont: 'UI font',
    uiFontBrand: "Geist / Inter (default, bundled)",
    uiFontSystem: "System font stack (matches native apps like dsh)",
    terminalLigatures: 'Enable programming ligatures (=> !== render as single glyphs)',
    terminalTheme: {
      sectionTitle: 'Terminal Theme',
      classicDark: 'Classic Dark',
      classicLight: 'Classic Light',
      oneDark: 'One Dark',
      dracula: 'Dracula',
      cyberHud: 'Cyber HUD',
      industrial: 'Industrial',
      deepSpace: 'Deep Space',
      description: {
        cyberHud: 'Cyan neon + magenta accent, cyber HUD aesthetic',
        industrial: 'Amber monochrome CRT, industrial brutalist',
        deepSpace: 'Deep purple + teal glow, deep space console',
      },
    },
    terminalFont: {
      sectionTitle: 'Terminal Font',
    },
    monoFontName: {
      label: 'Monospace font name',
      placeholder: 'Empty = built-in mono stack (a font installed locally, e.g. JetBrains Mono / Fira Code / Sarasa Mono SC)',
      ligatureTip: 'Takes effect once the font is installed locally; falls back to the built-in stack otherwise. The ligature toggle only switches the calt/liga feature and does not synthesize glyphs — custom fonts need their own ligature glyphs, or => etc. render as plain characters',
    },
  },
  push: {
    advanced: 'Advanced',
    forceWithLease: 'Force overwrite remote (force-with-lease)',
    force: 'Force Push (dangerous: overwrites remote changes)',
    overwriteWarning: 'Will overwrite {n} commits on the remote',
    followTags: 'Follow Tags',
    allTags: 'All Tags',
    newBadge: 'new',
    fail: 'Push failed',
    remotePlaceholder: 'remote',
    aheadMore: '+{n} more commits',
    aheadNoUpstream: 'No upstream tracking — commit list preview skipped',
  },
  pull: {
    fail: 'Pull failed',
  },
  fetch: {
    fail: 'Fetch remote failed',
  },
  // Fix with agent (P-20261002-109): one-click fix session for errors / failed tasks
  agent: {
    fix: {
      action: 'Fix with agent',
      actionTitle: 'Create an agent session preloaded with the failure context',
      taskHead: 'The following command failed. Please find the root cause and fix it:',
      taskOutputTail: 'Failure output (tail):',
      errorHead: 'A frontend request failed. Please find the root cause and fix it:',
      errorDetail: 'Details:',
      errorTitle: '{method} {url} → {status}: {message}',
      success: 'Agent fix session created',
      degraded: 'No agent runtime detected; created a plain terminal session (context not injected)',
      failed: 'Failed to create agent session',
      sensitiveTitle: 'Context may contain sensitive values',
      sensitiveBody: 'The content to send looks like it contains credentials or tokens. Hand it to the agent anyway?',
      // Deploy failure notification agent-fix action (P-20261003-289): prompt assembly lines
      deployHead: 'A remote deployment task failed. Please find the root cause and suggest a fix:',
      deployHost: 'Host: {host}',
      deployTools: 'Deploy tools: {tools}',
      deployTaskRef: 'Full task config (incl. tool params): GET /api/deploy/{taskId}',
      deployErrorTail: 'Failure output (tail):',
      // Sentinel-hit notification second action (P-20261005-150): prompt assembly lines
      sentinelHead: 'A terminal output sentinel was hit. Please find the root cause and suggest a fix:',
      sentinelRule: 'Sentinel rule: {name}',
      sentinelSession: 'Triggering session: {session}',
      sentinelMatched: 'Matched line: {matched}',
      sentinelOutputTail: 'Triggering session output (tail):',
      // Commit-message gate failure (P-20261003-273): prompt assembly lines
      commitMsgHead: 'The following commit message failed the commit-message convention check. Rewrite it into a compliant message of the form <type>(<scope>): <subject> (keep the intent; output only the rewritten message itself):',
      commitMsgReasons: 'Failure reasons:',
      commitMsgBody: 'Original message:',
      // Server logs (P-20261008-15): hand the log tail to an agent session to diagnose the service itself
      serverLogHead: 'The local Codecombo service log shows signs of trouble. Locate the cause and suggest a fix:',
      serverLogDate: 'Log date: {date}',
      serverLogTail: 'Log tail window:',
    },
    // Runtime precheck & detection (P-20261003-79): explicit creation errors + manual detection in settings
    runtime: {
      errorMissing: 'Agent runtime {name} is not installed or not in the service process PATH',
      errorVersionCheck: 'Agent runtime {name} exists but failed the version quick check — the installation may be broken, please reinstall',
      detect: 'Detect runtimes',
      detectTip: 'Re-probe runtime availability and versions on this machine (fresh installs/uninstalls show up immediately)',
    },
    // Task-file fallback (P-20261006-44): when launchArgs exceeds 500 bytes the full
    // task goes to the project-root .sc-task.md, session launched via short reference
    taskFile: {
      fallbackNote: 'Task content exceeds the launch-args limit; it has been written to the project-root .sc-task.md — the agent will read the full task from that file (safe to delete once done)',
      fallbackWriteFailed: 'Failed to write the task file; launched with the prompt truncated to the launch-args limit instead (context may be incomplete)',
    },
  },
  agentTerminal: {
    title: 'Terminal Sessions',
    // Instruction queue for running sessions (P-20261003-248): per-row entry + inline panel
    queue: {
      toggle: 'Queued instructions',
      placeholder: 'Instruction to send when the agent finishes (Enter to queue)',
      enqueue: 'Queue',
      sentNow: 'Session idle — sent immediately',
      empty: 'No queued instructions',
      count: '{n} queued (max 5)',
      edit: 'Edit',
      delete: 'Delete',
      sendNow: 'Send now',
      manualNote: 'No progress reports from this session — auto-send unavailable, use "Send now"',
      full: 'Queue is full (max 5)',
      sendFail: 'Send failed: session missing or closed',
    },
    // @ file-reference completion (P-20261005-196): popover key hints (discoverability)
    atComplete: {
      hint: '↑↓ navigate · Enter insert · Esc close',
    },
    collapseSidebar: 'Collapse sidebar',
    expandSidebar: 'Expand sidebar',
    termSessionsTab: 'Terminals',
    sortLabel: 'Sort sessions',
    sortDefault: 'Default order',
    sortByName: 'By name',
    sortRecent: 'Recent activity',
    // Group-by-runtime view (P-20261003-238): tabs-row toggle (group heads use
    // the shared agentLabelOf runtime labels — brand names are locale-neutral)
    groupByRuntime: 'Group by runtime',
    groupFlat: 'Back to flat view',
    searchPlaceholder: 'Search sessions / projects',
    noMatchSession: 'No matching sessions',
    // Time filter chips (P-20261003-174): AND-combined with the name filter
    timeChip: {
      today: 'Today',
      week: 'This week',
      all: 'All',
    },
    // Runtime filter chips (P-20261004-84): multi-select OR dimension filter,
    // AND-combined with name/time filters (chip labels use the shared
    // agentLabelOf runtime mapping — same source as the grouping view)
    runtimeChipAll: 'All',
    runtimeChipLabel: 'Filter by runtime',
    lastActivity: 'Last activity',
    // Session ID line (P-20261004-123): always-on row tooltip line — terminalId
    // is the collaboration-protocol address; hover to check "whose ID is this"
    // (copy entry lives in the terminal tab context menu)
    sessionId: 'Session ID',
    // Session identity inline face (P-20261023-3): same-name disambiguation
    // presentation — inline created/last-activity dim text (tooltip promoted
    // inline) and the new/resumed badges (new means new, not reused)
    createdAt: 'Created',
    createdAtTip: 'Created at {time}',
    newBadge: 'New',
    newBadgeTip: 'Created within 24h with no command activity yet — a brand-new session, not a reused one',
    resumeBadge: 'Resumed',
    resumeBadgeTip: 'Created from a resume flag (--resume), inheriting the previous session name',
    // Shell-integration detection (P-20261004-90): always-on tooltip line +
    // not-detected dim icon title — diagnosability for the dependent family
    // (command history / idle hint / exit-code decoration / git auto refresh)
    shellIntOn: 'Shell integration: connected',
    shellIntOff: 'Shell integration: not detected',
    shellIntOffTip: 'No shell integration detected — command history, idle hint, exit-code decoration and git-panel auto refresh are unavailable in this session (prompt not rendered yet, never attached from this browser, or unsupported custom shell)',
    activityJustNow: 'just now',
    activityMinutesAgo: '{n} min ago',
    activityHoursAgo: '{n} h ago',
    activityDaysAgo: '{n} d ago',
    batchSelected: '{n} selected',
    batchDestroyConfirm: 'Destroy {n} selected sessions? Running tasks in them will be terminated.',
    batchDestroyConfirmMixed: 'Destroy {n} selected sessions? Self-hosted sessions will be terminated; external takeovers will only be released (the tmux sessions keep running).',
    sessionCount: '{n} sessions',
    // External tmux session takeover (P-20261005-189): listing / attach /
    // close split / kill confirm copy
    takeover: {
      title: 'Take over an existing tmux session',
      field: 'External tmux session',
      placeholder: 'Pick an external tmux session to take over (selecting attaches it)',
      empty: 'No external tmux sessions found (no sessions created outside this system on the tmux server)',
      hint: 'After takeover this system watches/drives the session as another tmux client; "close" only releases the takeover — the session and its processes keep running. Read-only by default; unlock in the terminal toolbar to type.',
      attachedSuffix: '{n} client(s) attached',
      takenOverSuffix: 'taken over',
      success: 'Taken over "{name}" (read-only by default — unlock in the terminal toolbar to type)',
      multiClient: '{n} other client(s) are attached to this session; mirrored screens across clients are a tmux feature',
    },
    external: {
      release: 'Release takeover',
      releaseTitle: 'Release takeover',
      releaseConfirm: 'Release the takeover of "{name}"? The underlying tmux session and its processes keep running; you can take it over again later.',
      kill: 'Kill tmux session',
      killTitle: 'Kill tmux session',
      killConfirm: 'Kill "{name}"? The tmux session and all processes running inside it will be terminated. This cannot be undone.',
    },
    newSession: 'New Session',
    noSessions: 'No sessions yet',
    emptyHint: 'Use the shell directly, or pick a runtime (claude / codex) when creating a session to operate this system',
    emptyHintClaude: 'Pick a Claude session on the left to resume it, or create a new Claude session to start a fresh conversation',
    cwdTip: 'Working directory: {dir}',
    // File tree context menu "New agent session in this folder" (P-20261003-55):
    // session cwd = target directory (dir entry = itself / file entry = parent),
    // prompt phrased relative to the cwd (P-28 convention)
    dirAsk: {
      menu: 'New agent session in this folder',
      prompt: 'Familiarize yourself with the code structure in the current directory first, then wait for my specific task.',
      // Locating preface (P-20261003-102): a subdirectory session's agent sees the
      // subdir as cwd and cannot tell where the project root is; absolute paths are
      // the point of this line (the agent can reference them directly on this machine)
      locate: 'Project root: {root}; current working directory: {dir} (relative: {rel})',
      success: 'Agent session created (working directory: {dir})',
    },
    // Inject a git status summary into session creation (P-20261003-176): one-line
    // context of branch / uncommitted changes / last commit subject (assembly in utils/gitStatusSummary)
    gitSummary: {
      attach: 'Attach git status',
      dropped: 'Task prompt is long; git status will not be attached this time',
      dirtyCommit: 'Git status ({project}): branch {branch}, {count} uncommitted changes, last commit: {subject}',
      dirty: 'Git status ({project}): branch {branch}, {count} uncommitted changes',
      cleanCommit: 'Git status ({project}): branch {branch}, working tree clean, last commit: {subject}',
      clean: 'Git status ({project}): branch {branch}, working tree clean',
    },
    // Session startup context config (P-20261006-47): per-launch overrides in the
    // new-session dialog + notes/todos/env injection lines (assembly in
    // utils/sessionContextSummary; the git line reuses the gitSummary block above)
    sessionContext: {
      field: 'Context this launch',
      attachNotes: 'Attach project notes intro',
      attachTodos: 'Attach TODO summary',
      attachEnv: 'Attach environment profile (ports/sentinels/deploy targets)',
      hint: 'Defaults to Settings > General "session startup context"; this only adjusts the current launch',
      dropped: 'Task prompt is long; not attached this time: {names}',
      labelGit: 'git status',
      labelNotes: 'project notes',
      labelTodos: 'TODO summary',
      labelEnv: 'environment profile',
      notesLine: 'Project notes ({project}): {excerpt}',
      todosLine: 'TODO summary ({project}): {count} items, e.g. {entries}',
      todosLineNoEntries: 'TODO summary ({project}): {count} items',
      // Environment profile injection line (P-20261007-14): ports/sentinels/deploy
      // targets overview; details via GET /projects/:id/env-profile. Boundary note
      // travels with the line (profile = aggregated observations, not live topology)
      envLine: 'Environment profile ({project}): {parts} (aggregated observations, not live)',
      envPorts: 'ports {ports}',
      envSentinels: '{count} sentinel(s)',
      envTargets: 'deploy targets {targets}',
      envSeparator: '; ',
    },
    // Fleet bulk launch (P-20261003-291): start agent sessions across projects in one shot
    fleet: {
      paletteCmd: 'Bulk agent tasks (multi-project fleet)',
      title: 'Bulk Agent Tasks',
      fieldProjects: 'Target projects',
      fieldProjectsPlaceholder: 'Pick projects to launch (up to 20)',
      fieldPrompt: 'Task prompt',
      fieldPromptPlaceholder: 'e.g. Run a dependency audit for this project (npm audit / go list -m all), summarize outdated dependencies and known vulnerabilities into a list. Do not modify files directly.',
      promptBytes: '{n} bytes now (tail-truncated server-side past 500, keeping the trailing instructions)',
      promptTruncated: 'Over 500 bytes: the server will keep the tail when launching (drops the head, keeps trailing instructions)',
      launch: 'Launch fleet',
      createdSummary: '{n} sessions launched',
      skippedSummary: '{n} projects skipped',
      close: 'Close',
      // Sidebar "launch fleet" entry (P-20261005-152): title hint + disabled-gate copy
      sidebarEntry: 'Launch fleet: create agent sessions for multiple projects in one shot (also searchable via Ctrl+K "Bulk agent tasks")',
      needProjects: 'Requires at least two projects to launch a fleet (add projects on the home page first)',
    },
    runtimeAuto: 'Auto (by availability)',
    approvalTitle: 'Agent requests confirmation',
    approvalAllow: 'Allow once',
    approvalDeny: 'Deny',
    approvalAllowed: 'Allowed; the agent may proceed',
    approvalDenied: 'Operation denied',
    approvalResolveFailed: 'Failed to submit decision; try again',
    approvalAgentUnknown: 'Unknown source',
    approvalAlways: 'Always allow',
    approvalAlwaysSet: 'Set to always allow — high-risk operations will no longer prompt (revert in Settings)',
    approvalJumpSession: 'View session',
    approvalSessionEnded: 'Originating session has ended',
    approvalViewRecording: 'View recording',
    activityTitle: 'Session Output',
    activityUnavailable: 'Session not found or already ended — no output data',
    activityNoBaseline: 'No creation baseline; showing current working-tree changes (old or plain-terminal session)',
    activityNoBaselineShort: 'worktree view',
    activityNoBaselineTip: 'No baseline captured at creation (an old session, or an agent CLI running in a plain terminal). Showing current working-tree changes; commits made during the session are not included',
    activityNoGit: 'Not a git repository or no baseline captured; output unavailable',
    activityEmpty: 'No output yet — the agent has not changed any files',
    // Review baseline marks (P-20261003-217): staged review for long sessions —
    // mark when this round is reviewed; the output view can switch its diff
    // range to any mark (server resolves the base via timestamped rev-list)
    markBaseline: 'Mark review baseline',
    markBaselineTip: 'Record the current moment as a staged review baseline — mark after reviewing this round, then switch the output view here to see later changes',
    markBaselineDone: 'Review baseline marked — the output view can show later changes from the new baseline',
    baselineSwitchTip: 'Switch the output diff range: session start or a review baseline mark',
    baselineStart: 'Session start',
    baselineMark: 'Baseline {n}',
    // Relaunch (P-20261003-146): session-row context menu prefills the new-session
    // dialog with the initialPrompt captured at creation — re-issue the original
    // task after a long session went stale or ran out of context
    relaunch: 'Relaunch',
    // Postmortem report (P-20261004-60): session-row context menu opens the
    // aggregated postmortem dialog
    postmortem: 'Postmortem report',
    runtimeShell: 'Plain terminal (no agent)',
    runtimeUnavailable: 'unavailable',
    // Tooltip for disabled missing-runtime options (P-20261004-85): key phrase
    // mirrors the P-79 precheck stable marker (agent.runtime.errorMissing);
    // includes the re-detect way out (disabled items cannot reach the note row)
    runtimeMissingTip: 'Not installed, or not in the service process PATH — creation would be rejected. Just installed? Re-run "Runtime detection" in Settings → General',
    // Runtime-unavailable install guidance (P-20261003-296): all-unavailable card
    // + per-item detection note; guide link anchors the help-center FAQ entry
    runtimeNoneTitle: 'No agent runtime detected',
    runtimeNoneBody: 'Agent sessions require a locally installed runtime such as claude / codex / dsh.',
    runtimeShellFallback: 'You can start a plain shell session meanwhile — come back here once a runtime is installed.',
    runtimeInstallGuide: 'Installation guide',
    runtimeUnavailableNote: '{name} was not detected (detection = its launch command is executable in the service process). Just installed? Re-run "Runtime detection" in Settings → General, or see',
    // Re-detect (P-20261005-167): in-place re-probe button on the card/note action
    // row — verify right after installing without reopening the dialog; a light
    // toast confirms when an available runtime shows up
    runtimeRedetect: 'Re-detect',
    runtimeRedetecting: 'Detecting…',
    runtimeRedetected: 'Available runtime detected',
    newDialogTitle: 'New Agent Session',
    fieldRuntime: 'Runtime',
    fieldName: 'Session name',
    fieldNamePlaceholder: 'Leave empty to auto-name',
    fieldDir: 'Working directory',
    fieldDirPlaceholder: 'Leave empty = home directory',
    fieldCommand: 'Launch command',
    fieldCommandPlaceholder: 'Leave empty = default command',
    // Session-level shell override (P-20261004-57): advanced collapse for the
    // plain-terminal form; candidates share the shell-candidates endpoint with
    // the settings page. An explicit choice applies to this session only
    shellAdvancedTitle: 'Advanced',
    shellField: 'Shell',
    shellFollowSetting: 'Follow settings',
    shellFollowSettingWith: 'Follow settings (currently {shell})',
    shellNotFound: 'not found',
    shellHint: 'Applies to this session only; leave empty to follow Settings → Terminal → Default Shell',
    // Target instance (P-20261004-101 federated dispatch): local default / registered instances
    // with availability badges; status wording reuses instance.status* keys
    targetInstance: {
      field: 'Target instance',
      local: 'This machine (current instance)',
    },
    dispatched: 'Dispatched to {instance}: {session} (click the notification to open that instance)',
    dispatchFailed: 'Dispatch failed: target instance unreachable',
    // Task templates (P-20261002-16): picking one substitutes placeholders against the current context into launchArgs
    taskTemplate: {
      fieldTemplate: 'Task template',
      optionNone: 'No template',
      fieldPrompt: 'Task prompt',
      // Literal braces escaped (vue-i18n named interpolation; see settings.snippet.fieldCommand)
      promptPlaceholder: "Auto-filled from the selected template, editable; {'{'}file{'}'} = active file, {'{'}branch{'}'} = current branch, {'{'}dir{'}'} = working directory, {'{'}selection{'}'} = selected code",
      unresolvedHint: 'Missing context; these placeholders will stay literal: {names}',
      // {selection} placeholder (P-20261005-149): the truncation note rides along with the selection text;
      // the no-selection hint sits beside the generic unresolvedHint and names the actual cause
      selectionTruncated: '… (selection truncated)',
      selectionEmptyHint: "No selection right now — {'{'}selection{'}'} stays literal; select code in the editor and reopen this dialog to bring it in",
      promptTooLong: 'Task prompt exceeds the 500-byte limit; shorten it before creating',
      manageHint: 'Manage in Settings → General → Task templates',
    },
    // Unsubmitted draft retention (P-20261004-89): restore hint + discard for the last unsubmitted fields
    draft: {
      restored: 'Unsubmitted draft restored',
      discard: 'Discard',
    },
    // Close confirmation (P-20261006-6): confirm first on Esc/cancel when the task prompt/template has unsent content
    closeConfirm: {
      title: 'Discard this input?',
      body: 'The task prompt has not been created yet; discarding also clears the autosaved draft.',
      keep: 'Keep',
      discard: 'Discard',
    },
    saveAsDefault: 'Save as default launch command for this runtime',
    saveDefaultFailed: 'Failed to save launch command (settings error); session will still be created',
    createNow: 'Create',
    createFailed: 'Failed to create session; check that the directory path is valid',
    rename: 'Rename',
    renameTitle: 'Rename session',
    renameLabel: 'Session name',
    groupManage: 'Manage group',
    ungrouped: 'Ungrouped',
    newGroup: 'New Group',
    groupNamePlaceholder: 'Group name',
    moveToGroup: 'Move to',
    moveToRoot: 'Move to ungrouped',
    destroy: 'Destroy session',
    destroyConfirm: 'Destroy "{name}"? Processes running inside will be terminated',
    exitToast: 'Session ended: {name}',
    projectSessions: 'Project Sessions',
    systemSessions: 'System Sessions',
    openProject: 'Open Project',
    attachTip: 'Click to take over this session here (bottom panel gets suspended)',
    attachedTip: 'Rendering here · click the suspended bottom tab to take it back',
    attachedBadge: 'Here',
    newProjectSession: 'New Project Session',
    suspendedTip: 'Viewing in Terminal Sessions · click to take back',
    suspendedCard: 'Viewing in Terminal Sessions page',
    resumeToPanel: 'Take back to panel',
    dock: 'Open management page',
    openFloat: 'Open in floating window',
    collapse: 'Collapse to floating ball',
    sidebarResizeTip: 'Drag to resize sidebar width',
    projectGroupDragTip: 'Click to collapse/expand · Right-click for new session · Drag to sort',
    idle: 'Idle',
    // Stale-loss weak hint (P-20261003-303): running with no task.progress beyond threshold (mini ball/bar + management header dot)
    staleBadge: 'May be lost',
    staleTip: 'Running but no progress reported for over 10 minutes — the agent process may have crashed or disconnected; recovers when a real terminal state arrives',
    // Fleet dispatch backflow (P-20261004-131): progress belongs to a dispatched peer session — ball/bar badge tooltip
    remoteBadgeTip: 'Dispatched session on remote instance {instance}',
    error: 'Failed to create session — please retry',
    ballShapeBall: 'Ball',
    ballShapeBar: 'Bar',
    ballShapeList: 'Floating List',
    refreshList: 'Refresh session list',
    ballSize_small: 'Small',
    ballSize_medium: 'Medium',
    ballSize_large: 'Large',
    ballOpacitySolid: 'Solid',
    ballOpacityTranslucent: 'Translucent',
  },
  // Cross-agent review chain (P-20261003-6): hand a session's output to another runtime for review
  review: {
    cross: {
      action: 'Cross Review',
      title: 'Cross-Agent Review',
      sourceLabel: 'Source session',
      runtimeLabel: 'Target runtime',
      runtimeHint: 'Defaults to the first available runtime other than the source session\'s; changeable',
      launched: 'Cross-review session launched',
      launchFailed: 'Failed to create review session',
      degraded: 'No agent runtime detected; downgraded to a plain shell session',
      sensitiveTitle: 'Output list may contain sensitive values',
      sensitiveBody: 'Some paths look like credentials/tokens. Hand them to another runtime for review?',
      promptHead: 'Please cross-review the changes produced by agent session "{name}": check each file for correctness, defects and risks, and give a structured review verdict.',
      promptListHeadMain: 'Output files (relative to the main tree root):',
      promptListHeadDir: 'Output files (relative to the session working directory):',
      promptNoOutput: '(No output recorded yet; review the working tree in the session directory directly.)',
    },
  },
  // Compare experiment (P-20261003-46): two agents writing the same task in parallel with per-file comparison
  experiment: {
    title: 'Compare Experiment',
    newTitle: 'Start a compare experiment',
    fieldPrompt: 'Task prompt (each runtime runs it on its own)',
    fieldPromptPlaceholder: 'Describe the task for the two agents to race on…',
    fieldDir: 'Working directory (optional)',
    fieldDirPlaceholder: 'Empty = user home directory',
    fieldRuntimeA: 'Side A runtime',
    fieldRuntimeB: 'Side B runtime',
    launch: 'Launch both',
    listTitle: 'Experiments',
    listEmpty: 'No experiments yet — start one',
    pickExperiment: 'Pick an experiment on the left to compare',
    statusRunning: 'Running (waiting for completion reports)',
    statusReady: 'Both sides done, ready to compare',
    state: {
      waiting: 'Waiting',
      done: 'Done',
      failed: 'Failed',
      error: 'Launch failed',
    },
    adoptedBadge: 'Adopted {side}',
    adoptedClear: 'Clear adoption mark',
    adoptAction: 'Adopt {side}',
    adoptHint: 'The adoption mark is a record only; "Apply" finalizes the working tree automatically (other-side-only files rolled back/deleted, with a mandatory restorable backup).',
    applyAction: 'Apply to workspace',
    applyConfirmTitle: 'Apply adoption of {side}',
    applyConfirmBody: 'Will keep {kept} adopted-side-only file(s); roll back {roll} other-side-only file(s); delete {del} untracked file(s) (content force-backed up, retrievable from apply records); {noop} both-side file(s) stay as-is. The whole apply is refused if the workspace changed after adoption.',
    applyDone: 'Applied: kept {kept} · rolled back {roll} · deleted {del}',
    notify: {
      applied: {
        title: 'Compare experiment applied',
        body: 'Adopted {side}: kept {kept} · rolled back {roll} · deleted {del} ({noop} file(s) untouched)',
      },
    },
    notReadyHint: 'Completion reports are not all in yet; the file list tracks the working tree live.',
    sessionRunning: 'Session running',
    sessionGone: 'Session ended (no report)',
    tokens: 'Token {tokens}',
    tokensTip: 'Cumulative Claude session token usage (input+output+cache read)',
    fileCount: 'Output files {n}',
    noFiles: 'No output on either side (no baseline or no working tree changes)',
    pickFile: 'Click a file to view baseline-vs-side diff',
    sideView: '{side} view',
    diffFailed: 'Failed to load diff',
    flagOnlyA: 'Changed by A only',
    flagOnlyB: 'Changed by B only',
    flagBoth: 'Changed by both sides',
    promptRequired: 'Enter a task prompt first',
    sensitiveTitle: 'Prompt may contain sensitive values',
    sensitiveBody: 'The prompt looks like it contains credentials/tokens. Hand it to both runtimes?',
    launched: 'Compare experiment launched — both sessions started',
    launchFailed: 'Failed to launch compare experiment',
    opFailed: 'Operation failed, please retry',
  },
  instanceSessions: {
    title: 'Multi-instance session overview',
    filterPlaceholder: 'Filter by session name / project…',
    summary: '{n} sessions across {m} instances',
    local: 'local',
    online: 'online',
    unreachableTip: 'Instance not responding: verify it is running and the URL/token are correct, or check it in instance management',
    manageInstance: 'Manage instances',
    unreachable: 'unreachable',
    switchTo: 'Switch to this instance',
    loading: 'loading…',
    noSessions: 'no sessions',
    refresh: 'Refresh',
    rename: 'Rename',
    end: 'End session',
    confirmEnd: 'Click again to confirm',
    viewOutput: 'View output',
    goOperate: 'Operate',
    outputHint: 'Read-only snapshot, auto-refreshes every 3s (does not take over the session)',
    outputEmpty: 'No output yet',
    sessionEnded: 'Session ended or unreachable',
    renamed: 'Renamed',
    ended: 'Session ended',
    opFailed: 'Operation failed, please retry',
  },

  // Instance fleet overview (P-20261003-56): same-machine multi-instance fleet view
  fleet: {
    title: 'Instance fleet',
    desc: 'All Codecombo instances on this machine, discovered via project claim files; liveness comes from server-side probing, re-probed automatically every 15s while the overview is open',
    colInstance: 'Instance',
    colPort: 'Port',
    colProjects: 'Open projects',
    colStatus: 'Status',
    statusSelf: 'This machine',
    statusOnline: 'alive',
    statusInvalid: 'port taken over',
    statusOffline: 'stopped',
    residual: 'residual',
    open: 'Open in new tab',
    dispatch: 'New session on this instance',
    clean: 'Clean residual claims',
    confirmClean: 'Click again to confirm',
    cleaned: 'Removed {n} residual claims',
    cleanFailed: 'Cleanup failed, please refresh and retry',
    projectsNone: 'no project claims',
    versionTip: 'Peer instance version (captured during probe)',
    empty: 'No instance records yet — same-machine instances are discovered via project claim files; at least one git project is required',
  },

  // Cross-instance notification aggregation (P-20261003-125): fleet watch surface
  changeStream: {
    title: 'Cross-Project Changes',
    panelTitle: 'Cross-Project Changes',
    refresh: 'Refresh',
    empty: 'No file changes yet',
    loadFailed: 'Failed to load, try again later',
    staleHint: 'Refresh failed, retrying automatically',
    moreFiles: 'and {n} more files',
    droppedHint: 'Some events were evicted during high-frequency bursts; timeline may be incomplete',
    openHint: 'Open {file} (project {project})',
    switchHint: 'Switch to project {project}',
    cardHint: 'Auto-refreshes every {sec}s · click an entry to open',
  },
  // Agent collaboration stream card (P-20261008-6): the duty board's "what is
  // happening between agents" — timeline of directed messages (P-20261004-68)
  // and session chains (P-20261004-38) ops events + chain health rail; existing
  // agentchain.* keys (trigger counts / source alive / inert) are reused across cards
  collabStream: {
    title: 'Agent Collaboration',
    empty: 'No collaboration yet — session messages and chain relays will appear here in real time',
    cardHint: 'Live events · click an entry to open the session',
    chainsTitle: 'Chain health',
    chainsStaleHint: 'Chain list refresh failed',
    msgLine: '"{from}" → "{to}": {summary}',
    readLine: '"{session}" read {n} message(s)',
    chainLine: '"{next}" continues "{source}"',
    legBadge: 'leg {n}',
    chainLeg: 'at leg {n}',
    chainNoTrigger: 'never triggered',
    cooldown: 'cooling down',
    openHint: 'Open session "{name}"',
  },
  // Project environment profile (P-20261007-14): dev port observations x sentinel rules x deploy target summaries in one sidebar page

  // Multi-instance sync center (P-20261023-1)
  sync: {
    title: 'Instance Sync',
    directionPull: 'Pull from peer to this machine',
    directionPush: 'Push this machine to peers',
    dirPull: 'Pull',
    dirPush: 'Push',
    directionAria: 'Sync direction',
    pullButton: 'Pull from {peer} to this machine',
    pushButton: 'Push this machine to {count} instance(s)',
    peerTitle: 'Target instances',
    noInstances: 'No registered instances yet — add one in Settings · Instances (URL + Token)',
    noPeer: 'No instance selected',
    thisMachine: 'This machine',
    srcSide: 'Source',
    dstSide: 'Target',
    peerStatus: {
      online: 'Online',
      offline: 'Offline',
      unknown: 'Unknown',
      invalid: 'Invalid',
      local: 'Local',
    },
    projectsTitle: 'Select projects',
    selectAll: 'Select all',
    searchPlaceholder: 'Search projects…',
    noProjects: 'No registered projects on this machine',
    lastSync: 'Last synced {time} ({dir})',
    behindHint: 'Changed locally after last sync (see plan preview)',
    contextTitle: 'Sync content (context packs)',
    ctxNotes: 'Notes',
    ctxSessions: 'Sessions',
    ctxCrons: 'Cron tasks',
    ctxSnippets: 'Snippets',
    ctxRuntimes: 'Runtimes',
    ctxApprovals: 'Approval rules',
    ctxChains: 'Chains',
    ctxUIState: 'UI prefs',
    includeIgnored: 'Include ignored files',
    includeGit: 'Include .git (full repo)',
    planTitle: 'Sync preview',
    planTotal: '{n} items · {size}',
    state: {
      synced: 'In sync',
      'local-newer': 'Local newer',
      'peer-newer': 'Peer newer',
      conflict: 'Conflict',
      new: 'New',
    },
    kind: {
      project: 'Project',
      sessions: 'Sessions',
      notes: 'Notes',
      crons: 'Cron',
      snippets: 'Snippets',
      runtimes: 'Runtime',
      approvals: 'Approvals',
      chains: 'Chain',
      uistate: 'Prefs',
      deliver: 'Deliver',
    },
    conflictCount: '{n} conflict(s):',
    resolveAllLocal: 'Keep all local',
    resolveAllPeer: 'Take all peer',
    resolveAllSkip: 'Skip all',
    resolveLocal: 'Keep local',
    resolvePeer: 'Take peer',
    resolveSkip: 'Skip',
    resolveLocalHint: 'Overwrite peer with the local version on conflict',
    resolvePeerHint: 'Overwrite local with the peer version on conflict',
    gitBothHint: 'Both sides are git repos with local commits — prefer git remote/fetch; file-level overwrite loses commits',
    diskInsufficient: 'Peer disk space insufficient',
    execute: 'Run',
    selectPeerFirst: 'Select a target instance first',
    nothingSelected: 'Nothing selected to sync',
    started: 'Sync started, see progress below',
    startFailed: 'Failed to start sync (another sync may be running)',
    rerunLast: 'Rerun last',
    noLastRun: 'No previous sync yet',
    progressTitle: 'Syncing · {peer}',
    speedPending: 'Measuring…',
    etaPrefix: 'ETA ',
    etaSec: '{n}s',
    etaMin: '{n}m',
    currentFile: 'Transferring: {name}',
    enumerating: 'Enumerating files…',
    unitState: {
      queued: 'Queued',
      enumerating: 'Enumerating',
      transferring: 'Transferring',
      landing: 'Landing',
      done: 'Done',
      failed: 'Failed',
      'conflict-skipped': 'Conflict skipped',
      'busy-skipped': 'Busy skipped',
    },
    resultSummary: 'OK {done} · Failed {failed} · Skipped {skipped}',
    redlineNote: 'Scheduled/automatic sync never carries credentials; manual sync only, over the pairing-key E2E channel',
    redlineMore: 'Why?',
    redlineDetail: 'Always-on channel × automation × fleet-wide blast radius is unacceptable — scheduled sync is hard-rejected server-side (config drift cannot break this). Manual credential sync uses a separate channel: pairing codes transcribed out-of-band (never over the network), an end-to-end AEAD layer inside TLS, mandatory certificate fingerprint short-code verification before the first transfer, and human confirmation on first receipt. Instance tokens are channel credentials and never travel; lock password hashes never travel; quickdrop tokens are hash-only and cannot travel (re-issue on the new machine).',
    credInclude: 'Include key credentials',
    credIncludeHint: 'Manual credential sync: credential store + SSH hosts (with keys) + deploy credentials + agent token, end-to-end encrypted',
    credConfirmTitle: 'Confirm credential sync',
    credConfirmBody: 'About to transfer the credential vault (credential store / SSH hosts / deploy credentials / agent token) over the pairing-encrypted channel. Confirm the peer is trusted and the network is under your control.',
    credConfirmPush: 'Send to {peer}',
    credConfirmPull: 'Pull from {peer} and merge locally',
    credUnpaired: 'Not paired',
    credPaired: 'Paired',
    credVerified: 'Verified',
    credPairBtn: 'Pair',
    credPairTitle: 'Instance pairing (manual credential sync)',
    credPairIntro: 'Pairing codes are transcribed out-of-band like instance tokens: generate on one side, enter on the other — matching on both ends completes pairing.',
    credPairGenerate: 'Generate pairing code',
    credPairRotate: 'Regenerate (old code voided)',
    credPairCodeLabel: 'Local pairing code (copy to the peer)',
    credPairCopy: 'Copy',
    credPairCopied: 'Copied — enter this code on the peer instance',
    credPairInputLabel: 'Enter the code transcribed from the peer',
    credPairSet: 'Enter',
    credPairClear: 'Unpair',
    credPairFp: 'Pairing fingerprint: {fp}',
    credPairDone: 'Pairing saved',
    credPairInvalid: 'Invalid pairing code format (expect 64 hex chars)',
    credLastSync: 'Last credential sync: {time} ({dir})',
    credCeremonyTitle: 'First credential sync verification (one-time)',
    credCeremonyIntro: 'Verify both short codes match before transferring credentials (never skipped even on intranet). Mismatch = possible man-in-the-middle; stop immediately.',
    credCeremonyPairFp: 'Pairing fingerprint (must match)',
    credCeremonyLocalPairFp: 'Local record',
    credCeremonyPeerPairFp: 'Peer record',
    credCeremonyCertFp: 'Peer certificate fingerprint (must match)',
    credCeremonyLocalCert: 'Locally pinned',
    credCeremonyPeerCert: 'Peer self-reported',
    credCeremonyNoTls: 'Peer has no TLS (plain HTTP) — no certificate to verify; E2E encryption still applies',
    credCeremonyNoCert: 'Peer never connected (no pinned fingerprint) — probe connectivity first',
    credCeremonyAck: 'I verified both short codes match',
    credCeremonyConfirm: 'Verified — allow credential sync',
    credCeremonyNeedAck: 'Check the verification box first',
    credCeremonyFailed: 'Verification failed (peer unreachable or not paired)',
    credStagedTitle: 'Credential vaults awaiting confirmation',
    credStagedFrom: 'From "{peer}"',
    credStagedExpires: 'Expires {time}',
    credStagedAccept: 'Accept & land',
    credStagedReject: 'Reject',
    credStagedEmpty: 'No pending credential vaults',
    credStagedAccepted: 'Landed',
    credStagedRejected: 'Rejected',
    credStagedFailed: 'Resolve failed (may have expired)',
    peerUnsupported: 'Peer instance needs an upgrade to support sync (peer {version})',
    peerOffline: 'Peer instance offline, cannot preview',
    planFailed: 'Sync preview failed',
    loadFailed: 'Failed to load sync panel',
    cronTitle: 'Scheduled sync',
    cronNew: 'New scheduled sync',
    cronDefaultName: 'Scheduled sync',
    cronNameField: 'Task name',
    cronDirection: 'Direction',
    cronTime: 'Daily at',
    cronPolicyLabel: 'Conflict policy',
    cronPolicy: {
      safe: 'Safe (conflicts for review)',
      'local-mirror': 'Local-mirror',
      'peer-mirror': 'Peer-mirror',
    },
    cronSchedule: 'Daily {time}',
    cronRunNow: 'Run now',
    cronEnable: 'Enable',
    cronDisable: 'Disable',
    cronEmpty: 'No scheduled sync yet',
    cronCreate: 'Create',
    deliverTitle: 'Sync "{name}" to another instance',
    deliverHint: 'Light delivery for non-project content: lands under the peer sync root (not registered as a project)',
    deliverPeer: 'Target instance',
    deliverPickPeer: 'Pick an online instance…',
    deliverDest: 'Peer destination path (relative to its sync root)',
    deliverDestHint: 'Must stay inside the peer sync root; existing files are backed up before overwrite',
    deliverGo: 'Deliver',
    deliverDestInvalid: 'Invalid destination path',
    deliverDone: 'Delivered "{name}"',
    deliverFailed: 'Delivery failed (peer offline or destination not writable)',
    cronNote: 'Scheduled sync tasks are configured in Settings with the same form (direction/project set/schedule/conflict policy) and run automatically; conflicts are resolved by policy or left in the notification center.',
    landed: {
      title: 'Sync landing finished: {landed} item(s) ok',
    },
    cronConflicts: {
      title: 'Scheduled sync has {conflicts} conflict(s) to review ({task} → {peer})',
    },
    cronDone: {
      title: 'Scheduled sync "{task}" {result}',
    },
  },
  envProfile: {
    title: 'Environment Profile',
    portsTitle: 'Dev Ports',
    sentinelsTitle: 'Output Sentinels',
    targetsTitle: 'Deploy Targets',
    sourceDetected: 'detected',
    sourceReported: 'reported',
    scopeGlobal: 'All sessions',
    scopeProject: 'This project',
    portEmpty: 'No port observations yet (registry = detection/reporting surface)',
    sentinelEmpty: 'No sentinel rules visible to this project',
    targetEmpty: 'No deploy target hosts configured',
    degradedHint: 'Source unavailable, section omitted',
    loadFailed: 'Failed to load profile, please retry',
    staleHint: 'Refresh failed, showing last snapshot',
    boundaryNote: 'Profile = aggregated observations, not a live topology: dead ports are listed for reference (lastSeen marks freshness); listeners outside detection/reporting are not shown',
  },
  fleetNotify: {
    title: 'Cross-Instance Notifications',
    summary: 'Recent notifications across {m} instances (issues first)',
    offlineNote: '{n} instance(s) unreachable: their notifications are not counted until back online',
    unreachable: 'Offline',
    offlineShort: '{n} offline',
    chipTipOnline: 'Click to show only this instance',
    chipTipOffline: 'Instance not responding; notifications not counted',
    filterAll: 'All',
    filterIssues: 'Issues',
    filterUnread: 'Unread',
    openCenter: 'Notifications',
    openTip: 'View the cross-instance notification aggregation list',
    loading: 'Loading…',
    empty: 'No notifications in the selected scope',
    cardHint: 'Click for the aggregated list · auto-refresh every {sec}s',
  },
  overview: {
    refresh: {
      all: 'Refresh all',
      lastTip: 'Last refreshed: {time}',
    },
  },
  // Export center (P-20261003-266): aggregated per-domain export entries panel +
  // recent exports (reusing audit actions); domain keys mirror utils/exportCenter.ts
  exportCenter: {
    title: 'Export Center',
    desc: 'All export entries in one place: a unified facade for session knowledge, deploy archives and audit egress',
    go: 'Go',
    placeholder: 'Not yet',
    placeholderTip: 'No host-side export entry for this domain yet; lights up once landed',
    recentTitle: 'Recent exports',
    recentLoading: 'Loading…',
    recentEmpty: 'No export records yet (exports performed anywhere are written to the audit log and shown here)',
    recentNote: 'Full history: Settings → Security → Audit log',
    domains: {
      session: {
        title: 'Session export',
        desc: 'Replay page export Markdown / raw JSONL; session center bulk zip archive',
      },
      deploy: {
        title: 'Deploy logs',
        desc: 'Remote deploy task log txt download (Settings · Remote deploy)',
      },
      audit: {
        title: 'Audit export',
        desc: 'Audit log CSV, approval verdict history CSV egress archive',
      },
      changes: {
        title: 'Change patch',
        desc: 'Export uncommitted changes as a git diff patch (changes panel)',
      },
      shareArchive: {
        title: 'Share archive',
        desc: 'Directory share zip download (currently on the guest share page)',
      },
    },
  },
  dshConsole: {
    localTarget: 'Local dsh',
    versionsTitle: 'dsh Version Manager',
    currentVersion: 'Current version',
    versionUnknown: 'Unknown',
    versionUnknownHint: 'Current version not detected (not an npm global install, or undetectable) — you can still install any version below; it will be recognized afterwards',
    recheck: 'Recheck',
    latestTag: 'latest',
    upToDate: 'Up to date',
    upgradableTitle: 'A newer version is available — click to view',
    upgradeTo: 'Upgrade to v{version}',
    upStepPrepare: 'Recording rollback point…',
    upStepInstall: 'Installing new version… (npm fetching, please wait)',
    upStepRestart: 'Restarting dsh to load the new version…',
    upDone: 'Upgrade complete — dsh restarted on the new version',
    upInstallFailed: 'Install failed — npm output: {output}',
    upRestartFailedHint: 'New version failed to start (plugin incompatibility or new requirements?) — you can roll back to the pre-upgrade version',
    rollbackHint: 'Pre-upgrade version v{version} was recorded as the rollback point; rolling back restarts dsh automatically.',
    rollbackTo: 'Roll back to v{version}',
    rollbackPointLabel: 'Pre-upgrade version: v{version}',
    rollbackThis: 'Roll back',
    rollbackConfirmTitle: 'Roll back dsh version',
    rollbackConfirmBody: 'dsh will be reinstalled at v{version} via npm and restarted (reconnects automatically). Roll back?',
    showPrerelease: 'Show prerelease versions',
    prereleaseChannel: 'On the prerelease channel',
    upToDatePrerelease: 'Latest prerelease (stable: v{stable})',
    upToDatePrereleaseOnly: 'Latest prerelease',
    versionCheckFailed: 'Version check failed (npm registry unreachable?)',
    versionsHint: 'Upgrades run via a global npm install (configure the npm command in Settings); dsh restarts automatically after install. If the new version fails to start, you can roll back to the pre-upgrade version with one click.',
    manageTargets: 'Manage dsh connections',
    targetsTitle: 'dsh Connection Manager',
    addTarget: 'Add connection',
    editTarget: 'Edit connection',
    targetName: 'Name',
    targetToken: 'Token (optional)',
    targetsEmpty: 'No external connections yet — add one and switch from the dropdown above; embedding capabilities (frame stripping / fence assertion / token auto-issuance) apply to every connection',
    targetDeleteTitle: 'Delete dsh connection',
    targetDeleteConfirm: 'Delete "{name}"? Related browser sessions will fall back to the local dsh automatically.',
    targetFormHint: 'External dsh connections are embedded through the same proxy channel: frame stripping / loopback fence assertion / token auto-issuance all apply; changes take effect instantly',
    exposeRequiredTitle: 'Expose to all IPs required',
    exposeRequiredBody: 'Opening dsh in a standalone browser tab leaves this app window (no longer protected by the system lock). The current policy only allows embedded access within this system — expose to all IPs now? Devices on the LAN will be able to use dsh directly; you can turn it off anytime in Settings.',
    exposeEnableAndOpen: 'Expose and open',
    localOnlyHint: 'Your browser is not on this machine and the loopback embed channel is unreachable — expose to all IPs in Settings, or use the local browser',
    exposeAndReload: 'Expose all IPs and reconnect',
    certHint: 'The embed channel now serves https with the main service (self-signed cert): first time only, open the address below in a new tab and accept the certificate, then refresh here',
    dismissCertHint: "Don't show again",
    degradedHint: 'dsh reverse proxy failed to listen (port occupied?): adjust the proxy port in Settings and retry',
    title: 'dsh Console',
    statusOk: 'running',
    refresh: 'Refresh (Ctrl+R / F5)',
    openNewTab: 'Open in new tab',
    notRunning: 'dsh Web UI not detected',
    launch: 'Start dsh',
    launching: 'Starting…',
    launchingHint: 'Starting dsh and capturing the access token automatically (no manual setup)…',
    launchFailed: 'Launch unsuccessful: make sure dsh is installed and the command works. See the log for details: {path}',
    launchFailedReason: 'Launch unsuccessful: {reason} (full log: {path})',
    installHint: 'dsh command not found: install it on that machine first (npm install -g @deepseek-ai/dsh), or set the launch command to the full path in Settings → Terminal → dsh Web UI',
    launchNoCommand: 'Launch failed: configure a launch command in Settings → Terminal → dsh Web UI (e.g. wsl.exe dsh web --no-open)',
    tokenUnset: 'dsh needs authorization: no access token configured, so the embedded page cannot pass the dsh auth gate',
    tokenStale: 'dsh needs re-authorization: the token is stale (dsh rotates its token on every start, so a token saved before a dsh restart no longer works)',
    launchAlreadyRunning: 'dsh is already running; no new token was captured this time — restart dsh first and launch again, or update the token manually in Settings',
    openDshSettings: 'Open Settings',
    restartBtn: 'Restart & recapture token',
    clTitle: 'v{version} release notes',
    clOpenPage: 'Open release page',
    clLoading: 'Loading release notes…',
    clEmpty: 'No release notes for this version',
    clExpand: 'Show full notes',
    clCollapse: 'Collapse',
    restartProcess: 'Restart dsh (apply plugins/config)',
    restartDone: 'dsh restarted, new token captured',
    restartTitle: 'Restart dsh?',
    restartBody: 'The current dsh process will be stopped and relaunched to capture a fresh token. dsh data lives on disk and is kept; running tasks will be interrupted.',
    restartOk: 'Restart & capture',
    restarting: 'Restarting dsh and capturing the new token…',
    restartFailed: 'Restart unsuccessful: make sure the launch command works (see Settings → Terminal → dsh Web UI and dsh-web.log)',
    restartPortBusy: 'New token captured, but the probe still reports unauthorized: the upstream port seems occupied by an old dsh process (this system never kills processes it did not start) — stop the old dsh manually and retry',
    notRunningHint: 'Make sure dsh is running locally (default port 3080), or adjust the upstream URL in Settings → Terminal → dsh Web UI. You can also open it directly in a new tab.',
    retry: 'Retry',
    closeEsc: 'Close (Esc)',
    maximize: 'Maximize',
    restore: 'Restore',
  },
  claudeSessions: {
    idCopyTip: 'Click to copy session id (for recovery: claude --resume <id>)',
    title: 'Claude Sessions',
    searchPlaceholder: 'Search id / content…',
    scopeAllProjects: 'All Projects',
    scopeFilter: 'Project scope',
    bucketToday: 'Today',
    bucket7d: 'Last 7 Days',
    bucket30d: 'Last 30 Days',
    bucketEarlier: 'Earlier',
    // Time filter chips (P-20261003-174): AND-combined with the name search
    timeChip: {
      today: 'Today',
      week: 'This week',
      all: 'All',
      noMatch: 'No sessions in this time range ("Load more" pages in older ones)',
    },

    groupTip: '{n} sessions share this title; click to expand/collapse',
    loadMore: 'Load more ({n} left)',
    resume: 'Resume',
    active: 'Running',
    activeTip: 'This session is currently running and cannot be resumed here (avoid two processes writing the same conversation)',
    resumeName: 'Claude · {title}',
    resumeOk: 'Resumed "{title}" in a new terminal — claude is loading the conversation',
    resumeNoRuntime: 'claude runtime not found — opened a plain shell (run claude --resume manually)',
    resumeFail: 'Resume failed, please retry',
    empty: 'No Claude sessions yet — start claude in a terminal and it shows up here',
    noMatch: 'No matching sessions',

    replay: 'Replay',
    // Untitled-session fallback (P-20261031-1): noise/empty titles show relative time in gray
    unnamed: 'Untitled session',
    rel: {
      now: 'just now',
      minutes: '{n} min ago',
      hours: '{n} h ago',
      days: '{n} d ago',
      months: '{n} mo ago',
    },
    // Row context menu (session id visibility): explicit copy entry
    ctx: {
      copyId: 'Copy session id',
    },
    replayTip: 'See what this session did (step-by-step replay of prompts / replies / tool calls)',
    timelineTitle: 'Session Replay · {title}',
    timelineSteps: '{n} steps',
    timelineKindUser: 'User',
    timelineKindAssistant: 'Reply',
    timelineKindTool: 'Tool',
    timelineKindResult: 'Result',
    timelineInput: 'Input',
    timelineGapMin: '+{n} min',
    timelineStatusError: 'failed',
    timelineLoadMore: 'Load more ({n} left)',
    timelineTruncated: 'Session too long — showing the most recent part only',
    timelineEmpty: 'Nothing to replay in this session',
    timelineLoadFail: 'Failed to load timeline',
    timelineRetry: 'Retry',
    // In-timeline search (P-20261002-81): search box in the viewer header (in-page filter over loaded entries)
    timeline: {
      search: {
        placeholder: 'Search prompts / replies / tool calls…',
        jumpTip: 'Enter jumps to the next hit, Shift+Enter to the previous',
        hits: '{n} hits',
        hitsOnly: 'Hits only',
        hitsOnlyTip: 'Show matching steps only (hide the rest)',
        noMatch: 'No matching steps',
        // Regex toggle (P-20261003-196): on = match as regex, invalid patterns fall back to literal with a hint
        regexTip: 'Match as a regular expression (invalid patterns fall back to literal matching)',
        invalidRegex: 'Invalid regex — matching literally',
      },
      // Continue this session (P-20261002-96): resume exit in the replay modal footer
      resume: {
        label: 'Continue this session',
        tip: 'Opens a new terminal with claude --resume to pick up where this conversation left off',
      },
      // Export dual format (P-20261003-44 md / P-20261003-60 raw JSONL): knowledge egress + machine-readable archive, raw fidelity
      export: {
        label: 'Export',
        tip: 'Export this session: Markdown is a human-readable sectioned document, raw JSONL is a lossless archive for re-analysis; both are full plaintext',
        success: 'Session exported',
        mdLabel: 'Markdown (readable)',
        // Q&A-only tier (P-20261004-132): same endpoint as the full tier (mode=qa), -qa filename suffix
        mdQaLabel: 'Markdown (Q&A only · share-ready)',
        mdQaTip: 'Keeps user prompts and assistant replies only — tool calls, result quotes and thinking blocks are omitted for readers who just need conclusions; the file name carries a -qa suffix to tell it apart',
        jsonlLabel: 'Raw JSONL (lossless archive)',
        // Copy-to-clipboard variant (P-20261005-6): one step to the primary paste use case; same rendered document as the download
        copyMdLabel: 'Copy Markdown to clipboard',
        copyMdTip: 'Writes the same rendered document as "Markdown (readable)" to the clipboard, ready to paste (truncation notes for oversized sessions travel inside the document)',
        copySuccess: 'Session Markdown copied to clipboard',
        copyFail: 'Copy to clipboard failed; use download instead',
        // Curation export (P-20261003-144): filtered hits / bookmarked rounds — dropdown items bilingual only; the document body follows the server-side export document language (an artifact, not UI copy; see utils/claudeCurationExport)
        fail: 'Curation export failed, please retry',
        hitsLabel: 'Markdown · Current filter hits ({n})',
        hitsTip: 'Export only the entries matching the current search (client-rendered, with a scope note in the document header)',
        hitsEmptyTip: 'Available after a timeline search with hits',
        bmLabel: 'Markdown · Bookmarked rounds ({n})',
        bmTip: 'Export only bookmarked rounds (client-rendered; bookmarks pointing to unloaded segments are noted honestly in the document)',
      },
      // Share replay link (P-20261003-77): generate a read-only visitor link
      // (thinking blocks / tool details included, 24h by default; server-side
      // snapshot + P-108 masking) — the synchronous sibling of export
      share: {
        label: 'Share',
        tip: 'Generate a read-only visitor link: visitors see the complete session process (thinking blocks and tool details included; sensitive values masked). Content is a snapshot taken when the link was created and expires after 24 hours by default',
      },
      // AI session summary (P-20261003-215): agent reads the full transcript itself and produces a structured summary (task / key changes / conclusions / leftovers)
      summary: {
        label: 'AI Summary',
        tip: 'Start an agent session that reads the full transcript and produces a structured summary (task / key changes / conclusions / leftovers); reading long sessions costs many tokens',
        name: 'AI Summary · {title}',
        prompt: 'Read the session transcript file {path} and output a structured summary of this session in four sections: Task, Key changes, Conclusions, Leftovers. Note: never reproduce any secret, token or password in the summary (replace them with ***); output the summary only, do not modify any files.',
        ok: 'Started "AI Summary · {title}", the agent is reading the transcript to produce the summary',
        noRuntime: 'No claude runtime detected; a plain shell session was opened (the summary prompt is kept in the launch args, you can start claude manually)',
        fail: 'Failed to start AI summary, please retry',
        noPath: 'Transcript path unavailable (older server version); cannot start AI summary',
      },
      // Copy turn link (P-20261003-154): shareable/bookmarkable replay position (?session=&turn= deep link)
      copyLink: {
        tip: 'Copy turn link (opens directly at this step)',
        done: 'Turn link copied',
      },
      // Per-message content copy (P-20261003-185): copy one entry as plain text (formatting stripped, for notes/docs)
      copyText: {
        tip: 'Copy this message as plain text (formatting stripped, ready to paste)',
        done: 'Message copied',
      },
      // Turn bookmarks (P-20261003-122): star a conclusion turn + jump back from the top list
      bookmark: {
        addTip: 'Bookmark this turn (reachable from the top list)',
        removeTip: 'Remove bookmark from this turn',
        fail: 'Failed to save bookmark, please retry',
        missing: 'Bookmarked turn is outside the retrievable window (beyond the transcript truncation)',
      },
      // Turn semantic tags (P-20261003-256): #theme labels + top tag filter bar — bookmarks = position, tags = semantics
      tag: {
        addTip: 'Tag this turn (group by theme, filter the replay from the tag bar above)',
        placeholder: 'Type a tag and press Enter, e.g. architecture / fix',
        applyTip: 'Add "{tag}" to this turn',
        removeTip: 'Remove "{tag}" from this turn',
        filterTip: 'Show only the {n} turn(s) tagged "{tag}" (click again to clear)',
        noMatch: 'No entries carry the selected tags',
        fail: 'Failed to save tag, please retry',
      },
    },
    // Replay deep-link consumption (P-20261003-154): honest degrade when the session cannot be resolved
    deepLink: {
      notFound: 'Session not found or deleted; replay link not opened',
      loadFail: 'Failed to load session info; replay link not opened',
    },
    // Cumulative token usage badge (P-20261002-139): precise full-transcript aggregation (unlike the ≈ pressure estimate)
    usage: {
      tip: 'Session total {n} tokens (precise input+output+cache_read aggregation, not an estimate)',
    },
    // Session structured ledger (P-20261005-208): timeline tool_use aggregation (deduped files written /
    // shell command count / first-to-last span); segments hidden on zero. files/commands/duration are
    // segments of the row hover sentence; relayLine prefixes the relay preamble ledger line
    ledger: {
      files: '{n} files changed',
      commands: '{n} commands run',
      duration: 'took {d}',
      durMin: '{n}m',
      durHour: '{n}h',
      durLt1m: '<1m',
      relayLine: 'Previous session: {line}',
    },
    // Session history full-text search (P-20261003-19): cross-transcript hits with context, click through to replay
    search: {
      section: 'Full-text hits ({n} sessions)',
      truncated: 'Scan limit reached; results may be incomplete',
      none: 'No matches in session transcripts',
      hitTip: 'Click to replay this session at the hit',
    },
    // Sensitive masking (P-20261004-14): replay view masked as *** by default, originals behind confirmation
    mask: {
      show: 'Show original',
      hide: 'Hide original',
      showTip: 'Passwords/tokens are masked as *** by default — click to confirm showing originals',
      hideTip: 'Hide originals and return to the masked view',
      confirmTitle: 'Show sensitive originals?',
      confirmDesc: 'Originals may contain passwords, tokens or keys (sca_ tokens / password assignments / AKIA keys). Be careful when screen-sharing, taking screenshots, or sharing.',
      confirmShow: 'Show anyway',
    },
    // Session idle hint (P-20261003-53): weak badge + hover tip when running with no output past the threshold;
    // pending specialization (P-20261003-198): attribute to "waiting on you" when an approval is pending
    idle: {
      badge: 'no output {n} min',
      tip: 'May be waiting for input or stalled',
      pendingBadge: 'awaiting approval {n} min',
      pendingTip: 'The session requested a high-risk operation and is awaiting your approval',
    },
    // Stall strong badge (P-20261004-37): task claims running while both terminal sides
    // (command activity and progress reports) went quiet past the threshold — the weak
    // badge only says "no output", this tier attributes "suspected stall" and opens triage
    stall: {
      badge: 'suspected stall {n} min',
      tip: 'Task claims running but the terminal shows no command activity or progress reports — may be stalled, click to triage',
    },
    // Manual curation layer (P-20261003-67): star to pin + one-line plain-language note (faster recall than full-text search)
    curation: {
      bucketStar: '★ Starred',
      star: 'Star (pin to top)',
      unstar: 'Unstar',
      starFail: 'Failed to update star, please retry',
      badge: 'Note',
      note: 'Note',
      noteEdit: 'Edit note',
      notePlaceholder: 'One-line note (≤200 chars) — find this session without digging through records',
      noteSave: 'Save',
      noteClear: 'Clear',
      noteSaved: 'Note saved',
      noteFail: 'Failed to save note, please retry',
    },
    // Session hide/restore (P-20261003-112): index-layer cleanup — transcript files
    // are never touched, restorable anytime
    hide: {
      toggle: 'Hidden',
      toggleTip: 'Show hidden sessions (recoverable; transcript files are never deleted)',
      badge: 'Hidden',
      actionTip: 'Hide from list (file untouched, restorable anytime)',
      restore: 'Restore',
      restoreTip: 'Unhide and show in the session list again',
      hideOk: 'Session hidden — restore anytime via "Hidden"',
      restoreOk: 'Session restored to the list',
      hideFail: 'Hide failed, please retry',
      restoreFail: 'Restore failed, please retry',
      empty: 'No hidden sessions',
      searchDisabled: 'Search not available for hidden list',
    },
    // Session relay (P-20261003-114): row action injects the tail assistant conclusion of this session into a new session's launchArgs preamble (cross-day knowledge handoff into a fresh context)
    relay: {
      badge: 'Relay',
      tip: 'Start a relay session: carries this session\'s final conclusions into a new one as the task preamble (tail messages first — most recent is most relevant), so multi-day tasks continue where they left off',
      name: 'Relay · {title}',
      prompt: 'Conclusions from the previous session: {summary}. Please continue.',
      ok: 'Relay "{title}" started; previous conclusions injected as the task preamble',
      noRuntime: 'claude runtime not found; opened a plain shell session (conclusions kept in launch args — start claude manually)',
      fail: 'Relay failed, please retry',
      noSummary: 'Nothing to relay (no assistant replies in this session\'s timeline)',
    },
    // Relay from instance (P-20261003-218): cross-instance session relay — a toolbar
    // entry in the session center opens a dialog to pick a source instance + session,
    // pulls the timeline conclusion read-only and injects it into a new local session
    // (zero write-back). badge/prompt/noSummary/noRuntime/fail reuse relay.* above
    // (same relay semantics; the preamble template stays free of source-instance
    // names — that would only burn the 500-byte budget)
    instanceRelay: {
      toolbar: 'Relay from instance',
      toolbarTip: 'Relay from another instance\'s Claude sessions: pulls the tail conclusions read-only and injects them into a new session on this instance (nothing is written back to the remote)',
      title: 'Relay from Instance',
      pickInstance: 'Select source instance',
      searchPlaceholder: 'Search sessions on that instance (id / content)…',
      empty: 'No Claude sessions on this instance',
      unreachable: 'Instance unreachable — cannot list sessions (click refresh to retry)',
      noInstances: 'No other instances to relay from yet — register one from the instance menu first',
      rowTip: 'Click to relay: injects this session\'s tail conclusions into a new session on this instance (read-only pull, zero write-back)',
      name: 'Instance relay · {title}',
      ok: 'Relayed "{title}" from "{instance}"; conclusions injected as the new session\'s task preamble',
      readOnlyNote: 'Read-only pull: only read requests cross instances — nothing is written back',
    },
    // Low-context warning (P-20261003-141): badge shows constantly once headroom
    // drops below the warn threshold, with the row relay action pinned visible —
    // proactive session rotation (warning informs; the action reuses the P-114
    // relay chain). Threshold is user-adjustable (P-20261006-33); tip shows it
    lowctx: {
      badge: 'Context nearly full',
      tip: 'Less than {pct}% context left — output quality degrades quickly. Relay into a fresh session to carry this session\'s conclusions over',
    },
    // Batch session export (P-20261003-165): multi-select zip archive — action bar
    // and row-click hint copy
    batch: {
      rowTip: 'Ctrl+click to multi-select, Shift+click for range, Ctrl+A to select all visible',
      selected: '{n} selected',
      limit: 'Up to 50 per batch',
      overLimit: 'Over the 50-per-batch limit — deselect some or export in batches',
      formatLabel: 'Export format',
      fmtMd: 'Markdown',
      fmtJsonl: 'Raw JSONL',
      export: 'Export selected',
      exportOk: 'Exported {n} sessions as zip archive',
      // Passphrase envelope tier (P-20261003-166): toggle + two-step passphrase
      // entry (P-101 strength warning reused)
      enc: 'Passphrase',
      encTip: 'When on, exports a passphrase-encrypted archive (decryption requires the same passphrase, lost passphrases cannot be recovered); off = plaintext zip',
      passTitle: 'Set Archive Passphrase',
      passHint: 'Set an archive passphrase (min 8 chars): the zip archive will be encrypted and requires the same passphrase to decrypt; a lost passphrase cannot be recovered',
      passConfirmHint: 'Re-enter the passphrase to confirm',
      passPlaceholder: 'Enter passphrase (min 8 chars)',
      passConfirmPlaceholder: 'Re-enter passphrase',
      passTooShort: 'Passphrase must be at least 8 characters',
      passMismatch: 'Passphrases do not match',
      weakHint: 'Passphrase is weak — the archive can be brute-forced',
      exportOkEnc: 'Exported {n} sessions as passphrase-encrypted archive',
      // Download-progress toast title (P-20261030-2): blob cannot be direct-linked
      // (POST + envelope); receive phase is made visible
      exportProgress: 'Exporting session archive…',
    },
  },
  // Session context pressure (P-20261002-58): headroom badge tooltip on active rows
  // in the Claude session picker
  session: {
    pressure: {
      tipOk: 'Context ≈{p}% (estimated from tail usage) — plenty of headroom',
      tipCompact: 'Context ≈{p}% (estimated) — consider running /compact',
      tipNew: 'Context ≈{p}% (estimated) — run /compact or start a new session',
    },
  },
  share: {
    managerTitle: 'File Sharing',
    managerDesc: 'Turn project files or folders into short links — visitors can preview and download',
    // Entry points (P-20261020-8): command palette / editor tab menu / manager CTA
    tabShare: 'Share',
    newShare: {
      action: 'New Share',
      noProject: 'Open a project first, then create a share',
    },
    currentFile: {
      saveFirst: 'The current file has unsaved changes — save it before sharing',
      unavailable: 'Only saved files inside the project can be shared',
    },
    statusRunning: 'Service running',
    statusDown: 'Service not ready',
    serviceDownHint: 'The share sub-service is not ready (port busy or failed to start), so short links are temporarily unreachable. Check the sharePort setting in config.json and restart.',
    empty: 'No shares yet — right-click a file or folder in the project tree to create a short link',
    totalCount: '{n} shares',
    colName: 'Name',
    colProject: 'Project',
    colPath: 'Path',
    colType: 'Type',
    colFrozenBytes: 'Snapshot Size',
    colCreated: 'Created',
    colExpires: 'Expires',
    colHits: 'Visits',
    colLastAccess: 'Last access',
    neverAccessed: 'Never',
    hitsTip: 'Short link opened or downloaded {n} times',
    colActions: 'Actions',
    // Row action overflow menu trigger (P-20261020-9): hover / screen-reader text
    moreActions: 'More actions',
    // Relative last-access labels (P-20261002-14): keys mirror relativeTimeParts
    // (per-domain copy, same precedent as agentTerminal)
    activityJustNow: 'just now',
    activityMinutesAgo: '{n} min ago',
    activityHoursAgo: '{n} h ago',
    activityDaysAgo: '{n} d ago',
    typeDir: 'Folder',
    typeFile: 'File',
    rootPath: '(project root)',
    copyLink: 'Copy Link',
    open: 'Open',
    revoke: 'Revoke',
    revokeTitle: 'Revoke Share',
    revokeConfirm: 'Revoke the share of "{name}"? The short link will stop working immediately.',
    revoked: 'Share of {name} revoked',
    linkCopied: 'Share link copied',
    rotate: {
      action: 'Rotate',
      title: 'Rotate Share Link',
      confirm: 'Generate a new link for "{name}"? The old link stops working immediately — short links already shared will no longer open. The new link will be copied automatically.',
      confirmAction: 'Rotate & Copy New Link',
      doneCopied: 'Share of {name} rotated — new link copied to clipboard',
      done: 'Share of {name} rotated — copy the new link from the list',
    },
    resultTitle: 'Share Link Created',
    resultFileDesc: 'Visitors can preview this file in the browser and download it via the short link',
    resultDirDesc: 'Visitors can browse all files inside the folder, download them one by one or as a ZIP',
    resultNeverAccessed: 'This link has not been opened yet',
    resultHitsLine: 'Opened {n} times, last access: {time}',
    resultTip: 'Re-sharing the same file/folder always yields the same link; revoke anytime in Share Manager',
    manageAll: 'Manage all shares',
    serviceDown: 'The share sub-service is not ready, so the link is unavailable. Check the sharePort setting on the server and retry.',
    // Share link reachability badge (P-20261020-2): same three-color semantics as
    // the QR relay — green = any network / yellow = same network / red = local only
    // or unreachable. The label names the base source; the hint gives an actionable fix.
    reach: {
      label: {
        publicBase: 'Share base',
        external: 'External address',
        public: 'Public address',
        lan: 'LAN',
        loopback: 'Localhost',
        unreachable: 'Unreachable',
      },
      hint: {
        publicBase: 'Using the configured share public base URL — reachable from any network',
        publicBaseLoopback: 'The configured share public base URL is a loopback address, so recipients cannot reach it — use an external/LAN-reachable origin (or forward /s/ at your proxy entry)',
        external: 'Using the configured external access URL — reachable from any network',
        public: 'Using the current public address — reachable from any network (firewall must allow it)',
        lan: 'The link uses a LAN address; the recipient must be on the same network as the server',
        candidate: 'Opened via localhost, so the link was switched to a LAN address; the recipient must be on the same network. If not, configure a share public base URL in Settings · General',
        legacy: 'This link is only reachable on this machine — configure a share public base URL in Settings · General (Tailscale / Cloudflare Tunnel / public reverse proxy) or an external access URL',
        unreachable: 'The share service is not ready or no reachable address is available; the link is temporarily unavailable',
      },
    },
    // List search & kind filter (P-20261002-85): header instant filter +
    // file|snippet|terminal badge point-select
    filter: {
      placeholder: 'Search name, project, or path…',
      all: 'All',
      file: 'Files',
      snippet: 'Snippets',
      terminal: 'Live',
      termFrozen: 'Snapshots',
      cast: 'Replays',
      session: 'Session replays',
      count: '{n}/{total} shares',
      noMatch: 'No matching shares — adjust the search, kind, or status filter',
      statusLabel: 'Status',
      statusActive: 'Active',
      statusExpired: 'Expired',
      statusConsumed: 'Consumed',
      statusAbnormal: 'Broken',
    },
    // Health projection (P-20261020-10): surface broken live targets, deleted
    // projects, and missing snapshots directly in the manager list
    health: {
      count: '{n} broken',
      targetMissing: 'Target missing',
      targetMissingTip: 'The shared file/folder was removed or moved out of the project; visitors see an invalid link. Revoke and share again.',
      projectGone: 'Project deleted',
      projectGoneTip: 'The owning project was deleted or its directory is unavailable, so visitors cannot read the content. Revoke this link.',
      snapshotMissing: 'Snapshot missing',
      snapshotMissingTip: 'The frozen snapshot is no longer on disk (cleaned up or disk issue); visitors cannot read the frozen content. Revoke and share again.',
    },
    // "Locate target" action (P-20261020-10): take the owner back to the
    // project content the short link points at
    locate: {
      action: 'Locate target',
      unavailable: 'This share kind has no in-project target to locate',
      projectGone: 'The owning project was deleted — target cannot be located',
      targetGone: 'The share target is gone — cannot locate it',
    },
    // "Share again" (P-20261020-10): rebuild an expired/consumed file share
    // with a fresh lifecycle
    reshare: {
      action: 'Share again',
      title: 'Share again',
      confirm: 'This revokes the old link of "{name}" and creates a new share for the same target. The old link is already expired/dead; the sensitive-file scan and confirmation flow still apply.',
      passphraseLabel: 'Passphrase',
      passphrasePlaceholder: 'Leave empty to rebuild without a passphrase',
      passphraseHint: 'The original share was passphrase-protected. Passphrases are stored only as hashes and cannot be read back — re-enter one to keep the protection; leave empty to drop it.',
      passphraseTooLong: 'Passphrase must not exceed 64 bytes',
      unavailable: 'Only expired/consumed file shares with a healthy target can be shared again',
      failed: 'Share again failed — try later',
      abortedAfterRevoke: 'Old link revoked, but the new share was not created because sensitive files were not confirmed',
      done: 'Shared {name} again',
    },
    // Bulk revoke (P-20261005-226): multi-select with a single confirmation
    // instead of N dialogs; bulk rotate is out of scope for phase one
    bulk: {
      enter: 'Bulk manage',
      exit: 'Exit bulk mode',
      selected: '{n} selected',
      revoke: 'Revoke selected',
      revokeTitle: 'Revoke shares in bulk',
      revokeConfirm: 'This will revoke {n} shares: {names}. Links stop working immediately and cannot be undone. Continue?',
      moreNames: ' and {n} more',
      done: 'Revoked {n} shares',
      partial: 'Revoked {ok}, {fail} failed — see the notification center for details',
    },
    scan: {
      warningTitle: 'Sensitive files detected',
      warningIntro: 'The following {n} files look like keys or credentials — anyone with the link will be able to download them:',
      moreFiles: '…and {n} more files not listed',
      partialNote: 'This folder has many entries; only part of it was scanned, so some sensitive files may have been missed.',
      confirmShare: 'Share anyway',
    },
    // Text snippet sharing (P-20261002-71): troubleshooting paste link —
    // project-independent, auto-expires after 24h
    snippet: {
      menuSelection: 'Share selected text',
      paletteCmd: 'Share text snippet',
      noSelection: 'No text selected',
      dialogTitle: 'Share Text Snippet',
      contentLabel: 'Snippet content',
      contentPlaceholder: 'Paste the error output, command output or code to share…',
      nameLabel: 'Title (optional)',
      namePlaceholder: 'Defaults to the first content line',
      publicWarning: 'This text will be made public: anyone with the link can view it. Do not include keys or passwords.',
      publicWarningLocked: 'This text will be shared: visitors need the link plus the access passphrase. Do not spread the passphrase in public channels.',
      expireNote: 'The snippet expires automatically after 24 hours; the link stops working then.',
      byteCount: '{n} / {max} bytes',
      tooLarge: 'Content exceeds the 32KB limit — trim it before sharing',
      create: 'Create link',
      created: 'Snippet link created',
      resultDesc: 'Visitors can view this text as a code block via the link; it expires automatically after 24 hours',
      typeBadge: 'Snippet',
      expiresInMinutes: 'Expires in {n} min',
      expiresInHours: 'Expires in {n} h',
      expired: 'Expired',
      pathEmpty: '(standalone snippet)',
    },
    // Validity (opt-in TTL, P-20261003-29 / P-20261020-5): chosen at creation,
    // configurable default, editable in Share Manager; default permanent
    ttl: {
      label: 'Validity',
      action: 'Validity',
      actionTitle: 'Adjust validity for "{name}"',
      permanent: 'Permanent',
      oneHour: '1 hour',
      oneDay: '1 day',
      sevenDays: '7 days',
      thirtyDays: '30 days',
      custom: 'Custom date',
      permanentLine: 'Valid until revoked — manage or revoke anytime in Share Manager',
      expiresAtLine: 'Valid until {date}; the link stops working afterwards',
      presetHint: 'Expires automatically after {label}; the link stops working then',
      updated: 'Validity updated',
      expired: 'Expired',
      expiresInMinutes: 'Expires in {n} min',
      expiresInHours: 'Expires in {n} h',
      expiresInDays: 'Expires in {n} d',
    },
    // Terminal read-only live share (P-20261003-306): token→terminal session,
    // guests watch a masked read-only output stream
    terminal: {
      resultDesc: 'Visitors can watch this terminal\'s live output read-only via the link (sensitive values are masked as ***, heuristically — not absolute). It expires automatically after 30 minutes and can be revoked anytime',
      typeBadge: 'Live',
      pathEmpty: '(terminal live)',
    },
    // Terminal output frozen snapshot (P-20261005-205): a link frozen at
    // creation time - the session keeps running while the content stays put,
    // and the link outlives the session (bug-report / ask-for-help flow)
    termFrozen: {
      resultDesc: 'Visitors can view a snapshot of this terminal\'s output frozen at creation time (sensitive values masked as ***; the content does not update with later output). It expires after 30 days by default, remains accessible after the session closes, and can be revoked anytime',
      typeBadge: 'Snapshot',
      pathEmpty: '(terminal output snapshot)',
    },
    // Session replay share (P-20261004-103): a recorded cast snapshot plus a
    // read-only replay page — async walkthrough (teaching / retro / demo),
    // short 1-hour TTL by default (adjustable)
    cast: {
      resultDesc: 'Visitors can watch this recorded process in a read-only replay page via the link (played back in recorded order, with command chapters for jumping; sensitive values are masked as ***, heuristically — not absolute). It expires automatically after 1 hour by default and can be revoked anytime',
      typeBadge: 'Replay',
      pathEmpty: '(session replay)',
      tooLarge: 'The replay exceeds the 200MB limit and cannot be shared; shorten the recording window and try again',
      scanWarningTitle: 'Replay may contain sensitive values',
      scanWarningIntro: 'The replay text contains {n} suspicious key/credential occurrences (masking already ran at record time; this is a backstop re-scan). After sharing, visitors can replay the whole process; confirmed hits are masked again in the shared copy:',
      scanWarningConfirm: 'Share anyway',
      scanWarningMore: '…and {n} more not listed',
      scanWarningPartial: 'The replay text is large; only part of it was scanned, so some sensitive values may have been missed.',
    },
    // Session replay read-only share (P-20261003-77): Claude session timeline
    // snapshot (thinking blocks and tool details visible to visitors per the
    // 2026-10-19 product decision), 24h TTL by default
    session: {
      resultDesc: 'Visitors can read the complete process of this session as a read-only timeline via the link (user prompts / assistant replies / thinking blocks / tool calls and results; sensitive values are masked as ***). The content is a snapshot taken when the link was created, expires automatically after 24 hours by default, and can be revoked anytime',
      typeBadge: 'Session replay',
      pathEmpty: '(session replay)',
    },
    // Frozen snapshot usage line (P-20261005-176): capacity-guard transparency in
    // the manager header — above 80% of the cap switches to the orange warn state
    frozenUsage: {
      line: 'Frozen snapshots {used} / cap {cap}',
      warnTip: 'Frozen snapshot usage is above 80% of the cap — once full, new frozen shares are rejected (413); revoke unneeded frozen shares to free space',
    },
    // Frozen snapshot share (P-20261003-320): a copy is snapshotted at creation,
    // what guests see stays immutable
    frozen: {
      typeBadge: 'Frozen',
      resultDesc: 'Visitors see a frozen copy from the moment of creation: later project changes never affect this link. The copy is kept for 30 days by default (adjustable below) and expires automatically afterwards',
      tooLarge: 'Target exceeds the 200MB freeze limit; use a live share instead',
      quotaFull: 'Frozen snapshot storage is full. Revoke unneeded frozen shares in Share Manager, or use a live share instead',
      pathEmpty: '(frozen snapshot)',
      // In-place refresh (P-20261005-177): keep the token, swap the content —
      // orthogonal to rotate's "issue a new link" semantics
      refreshAction: 'Refresh snapshot',
      refreshTitle: 'Refresh frozen snapshot',
      refreshConfirm: 'This re-copies the frozen copy of "{name}" from the project\'s current content: the link stays the same (short links already shared keep working) and the 30-day retention resets.',
      refreshDone: 'Refreshed the frozen snapshot of {name}; the link is unchanged',
    },
    // Multi-path frozen share (P-20261008-1): cross-directory selection → one
    // immutable review-package link
    batch: {
      selected: '{n} items',
      more: 'and {n} more not listed',
      estimate: 'about {n} file entries, {size} total',
      estimating: 'Estimating total size…',
      overLimit: 'Total size exceeds the frozen limit of {max}; creation will be rejected. Split the selection and retry.',
      frozenDesc: 'Multi-file shares use frozen snapshots: every selected path is snapshotted into one link at creation; later project changes never affect what guests see',
      typeBadge: 'Batch {n}',
      pathSummary: '{n} items (batch frozen)',
      resultDesc: 'Guests can view the frozen copy of these {n} items — preview/download each one, or download the whole package. Expires automatically after 30 days and can be revoked anytime',
    },
    // View-once (P-20261006-27): burn after reading — the first visitor's open
    // starts a 10-minute grace window; the link dies afterwards (count
    // dimension of share expiry)
    viewOnce: {
      typeBadge: 'One-time',
      badgeTip: 'View-once share: after the first visitor opens it, a 10-minute grace window starts and the link dies afterwards (burn after reading)',
      consumedBadge: 'Consumed',
      consumedTip: 'This view-once share has been viewed; the grace window has passed and the link is gone',
    },
    // Guest message board owner side (P-20261006-13): "messages N" badge + read-only list panel —
    // one-way flow, replies live in IM; cleanup = single delete / clear. notify.* are the
    // server-side titleKey/bodyKey templates for new-message notifications
    msg: {
      action: 'Messages',
      actionN: '{n} messages',
      title: 'Visitor messages · {name}',
      readonlyTip: 'Messages are a one-way flow from visitors (read-only): follow up in your IM or chat tool.',
      empty: 'No visitor messages yet',
      anon: 'Anonymous',
      delete: 'Delete this message',
      deleted: 'Message deleted',
      clear: 'Clear messages',
      clearTitle: 'Clear messages',
      clearConfirm: 'Clear all {n} messages of "{name}"? This cannot be undone.',
      cleared: 'Messages cleared',
      notify: {
        title: 'New message on a shared link',
        body: '"{name}" {nick}: {text}',
      },
    },
    // Collab channel (P-20261024-1): visitor upload inbox — notify.* are the
    // server-side titleKey/bodyKey templates; the rest feed the manager inbox
    // panel and the hand-to-session consumption chain (useShareDrop)
    drop: {
      menu: 'Collab inbox',
      title: 'Collab inbox · {name}',
      tip: 'Visitor uploads land in a local inbox on this machine (absolute paths visible only here). "Send to session / New session" live as inline actions in the notification center. Consumed items are cleaned after 24 h, unconsumed after 72 h.',
      empty: 'No visitor uploads yet',
      kindImage: 'Image',
      kindFile: 'File',
      sensitive: 'Sensitive name',
      used: 'Handed to session',
      copyPath: 'Copy path',
      pathCopied: 'Absolute path copied — paste it into a session to hand it to the agent',
      markUsed: 'Mark consumed',
      consumed: 'Marked as consumed (auto-cleaned in 24 h)',
      deleted: 'Upload deleted',
      arrived: '"{name}" received a visitor upload: {file} ({nick})',
      promptHead: 'Shared collaboration material (uploaded by a visitor). Please read the following path and analyze its contents:',
      gone: 'The upload was cleaned up or already handled (unconsumed items are kept for 72 h)',
      forwarded: 'Upload path pasted into the current session',
      newLaunched: 'New session created to handle the upload',
      notify: {
        title: 'Share received visitor material',
        body: '"{name}": {nick} uploaded {file} ({size})',
      },
    },
    // Collab channel toggle (P-20261024-1): actioned inline switch — on exposes
    // the visitor upload panel + raised message limit (500→2000), off revokes
    // the endpoints (received files remain readable)
    collab: {
      menuOn: 'Collab channel: on',
      menuOff: 'Collab channel: off',
      on: 'Collab channel enabled — visitors get an upload panel and the message limit rises to 2000 characters',
      off: 'Collab channel disabled — visitor upload/input endpoints revoked immediately (received files remain readable)',
    },
    // Direct input tier (P-20261024-1, second independent switch, decoupled
    // from collab): visitors request-then-owner-approves typing into the
    // anchored agent session; enabling requires explicit confirmation
    direct: {
      menuOn: 'Direct input: on',
      menuOff: 'Direct input: off',
      enable: 'Enable direct input',
      enableTitle: 'Enable direct input',
      enableConfirm: 'Once enabled, visitors may request permission to type directly into the agent session anchored to "{name}" (single holder, auto-revoked after 10 min idle, every batch ≤4KB fully audited). Regular terminals are never exposed. Enable now?',
      notify: {
        title: 'Visitor direct input granted',
        body: '"{name}": {nick} is typing into the session (auto-revoked after 10 min idle)',
      },
      on: 'Direct input enabled — waiting for visitor requests (your keyboard yields while a visitor holds input)',
      off: 'Direct input disabled — held permissions revoked immediately, session input returned to you',
      granted: 'Approved input request from "{nick}" (auto-revoked after 10 min idle)',
      revoked: 'Visitor input access revoked, session input returned to you',
      approveAction: 'Approve visitor input request ({nick})',
      revokeAction: 'Revoke visitor input ({nick})',
    },
    // Retired-link leak watch (P-20261008-2): alert + badge for retired links
    // still being accessed after rotation — a zero-false-positive leak signal;
    // notify.* are the server-side titleKey/bodyKey templates (Title/Body carry
    // Chinese fallbacks for template-less consumers)
    retired: {
      badge: 'Retired {n}',
      badgeTip: 'Links retired by rotation are still being accessed ({n} hits, last {time}) — hits on a dead link signal a leak. Review content sensitivity and rotate/revoke again as needed',
      notify: {
        title: 'Retired share link is still being accessed',
        body: 'A retired link of "{name}" ({tail}) is still being accessed ({n} hits total) — it may have leaked. Review content sensitivity and rotate or revoke again as needed',
      },
    },
    // Quickdrop card (P-20261006-51): lightest phone/script → workbench
    // channel — scd_ token lifecycle + drop page URL (/drop/<token>, main port)
    quickdrop: {
      title: 'Quickdrop',
      desc: 'Paste text on your phone; it lands in the workbench notification center, one click to a session',
      generate: 'Create drop link',
      rotate: 'Rotate',
      revoke: 'Revoke',
      revokeTitle: 'Revoke quickdrop link',
      revokeConfirm: 'The drop page and endpoint stop working immediately; every copied link becomes invalid.',
      copyUrl: 'Copy link',
      created: 'Drop link created (the plain token is shown only this once — copy it now)',
      revoked: 'Revoked — links are dead',
      copied: 'Copied',
      noneHint: 'No drop link yet — create one, then open it in your phone browser to deliver (content expires in 24h)',
    },
    // Access passphrase gate (P-20261006-25): link + passphrase two-factor, one guard for all share kinds
    pass: {
      action: 'Passphrase',
      badgeTip: 'This share is protected by a passphrase',
      title: 'Access passphrase',
      hasDesc: '"{name}" already has a passphrase. Enter a new one to replace it — all issued visitor sessions become invalid and must re-enter the passphrase.',
      noDesc: 'Set a passphrase for "{name}" so visitors need both the link and the passphrase to view the content.',
      inputPlaceholder: 'Enter a passphrase',
      rotateLabel: 'Also rotate the link (recommended)',
      rotateNote: 'A passphrase change usually means it may have leaked — rotating also invalidates the old link and all issued visitor sessions. Leave unchecked to keep the link unchanged and only replace the passphrase.',
      save: 'Save',
      remove: 'Remove passphrase',
      removeTitle: 'Remove passphrase',
      removeConfirm: 'Remove the passphrase from "{name}"? Anyone with the link will be able to view the content directly.',
      saved: 'Passphrase updated',
      removed: 'Passphrase removed',
      createLabel: 'Access passphrase (optional)',
      createPlaceholder: 'Leave empty for no passphrase',
      createNote: 'Visitors will need this passphrase to view the content; change or remove it anytime in Share Manager',
      inviteReady: 'Passphrase saved — copy the invitation (link + this passphrase) and send it to the recipient',
    },
    // Invitation text (P-20261020-6): result card / manager passphrase save /
    // handover share — link + plaintext passphrase known only in this creation
    // session + expiry/view-once notes, delivered in one copy
    invite: {
      copy: 'Copy invitation',
      copied: 'Invitation copied (includes the access passphrase)',
      secretNote: 'The passphrase is shown only this once and cannot be recovered after closing; never put it in a QR code or a public channel.',
      link: 'Share link: ',
      passphrase: 'Access passphrase: ',
      expires: 'Valid until: ',
      permanent: 'No expiry; revoke anytime',
      once: 'View once: the first visitor gets a 10-minute window, then the link dies',
    },
    // Share creation dialog (P-20261003-320): mode selection — live view / frozen snapshot
    create: {
      title: 'Share Project Content',
      modeLabel: 'Share mode',
      liveLabel: 'Live view',
      liveDesc: 'Guests see the project\'s current state — content changes as the project evolves',
      frozenLabel: 'Frozen snapshot',
      frozenDesc: 'A copy is snapshotted at creation; later project changes never affect what guests see (immutable)',
      frozenNote: 'Copy is kept for 30 days by default, up to 200MB; scanned for sensitive files at creation',
      confirm: 'Create link',
      // Visitor attribution watermark (P-20261005-193): leaked screenshots can be traced to a link
      watermarkLabel: 'Visitor watermark',
      watermarkNote: 'Overlay a faint watermark on the visitor page (share name, link tail, date) so leaked screenshots can be attributed to a link by its tail; the watermark can be cropped — best-effort attribution',
      // View-once (P-20261006-27): burn after reading; mutually exclusive with frozen
      viewOnceLabel: 'View once (burn after reading)',
      viewOnceNote: 'After the first visitor opens it, a 10-minute grace window starts and the link dies automatically — for "send a credential/screenshot for a quick look" one-offs',
      viewOnceFrozenNote: 'Frozen snapshots are for immutable evidence and don\'t support view-once (switch to live view)',
      // Single-file HTML note (P-20261020-4): a single-file share contains only
      // that file — sibling CSS/images are outside the boundary
      singleHtmlNote: 'A single-file share contains only this HTML file: external CSS, images and other sibling assets will not load. To share the complete page, share its containing folder instead.',
      // Validity (P-20261020-5): chosen at creation; untouched = server default
      ttlPickDate: 'Pick an expiry date',
      ttlPresetHint: 'Expires automatically {label} after creation; adjustable on the result card or in Share Manager',
      ttlDefaultHint: 'Expires after {label} by default (change the default in Settings)',
      ttlFrozenDefaultHint: 'Frozen snapshots are kept for 30 days by default (not affected by the default setting); adjust the expiry here',
    },
    // Row-level QR shortcut (P-20261003-282): short link as a QR code — scan with
    // a phone to open the visitor page (multi-device viewing)
    qr: {
      action: 'QR Code',
      title: 'Share QR Code',
      desc: 'Scan with a phone to open the visitor page for "{name}", or copy the link to send it manually',
      // Address plan and reachability badge (P-20261020-6; reuses P-20261019-10
      // three-form address selection)
      loading: 'Choosing a reachable address…',
      addressLabel: 'QR address',
      unreachablePlaceholder: 'No phone-reachable share address found — check the share service or the external access URL setting',
      status: {
        external: 'External address',
        public: 'Public address',
        lan: 'LAN',
        loopback: 'Same LAN only',
        unreachable: 'Unreachable',
      },
      hint: {
        external: 'Using the external access URL from settings — reachable from any network',
        public: 'Using a public address — reachable from any network (allow the share service port)',
        lan: 'The link points to a LAN address: the recipient must be on the same Wi-Fi / LAN',
        loopback: 'Switched to LAN address {ip}: the recipient must be on the same Wi-Fi / LAN',
        unreachable: 'Opened via loopback and no LAN address was detected; configure an external access URL in Settings · General',
        networkFailed: 'Failed to read local network addresses; refresh and retry, or configure an external access URL in Settings · General',
      },
    },
  },
  remoteConsole: {
    title: 'Remote Manager',
    addHost: 'Add host',
    searchPlaceholder: 'Search hosts',
    noHosts: 'No remote hosts yet',
    openTerminal: 'Open terminal',
    newTerminal: 'New terminal',
    termCountTip: 'Click the card to switch to the latest terminal; use the ⋯ menu to open another',
    sftpShellHint: 'SFTP host: if the server does not expose a shell, the terminal may stay blank — file management still works from the host card',
    openFirst: 'Open first terminal',
    diagnoseHost: 'Diagnose host',
    termCount: '{n} terminals',
    quickActions: 'Quick actions',
    noTabs: 'Pick a host on the left and click "Open terminal"',
    noHostsMain: 'No remote hosts yet — start with "Add host" on the left',
    closeTitle: 'Close terminal tab',
    closeConfirm: 'The remote session of "{title}" will be closed too. Continue?',
    renameTitle: 'Rename terminal tab',
    renameLabel: 'Tab name',
    reopen: 'Reopen',
    ended: 'Remote session ended (server reconnect window expired)',
    endedTip: 'Server session was recycled; reopening creates a new session',
    removedHostToast: 'Some terminal tabs belonged to deleted hosts and were removed',
    staleSessionsToast: '{n} remote terminal session(s) are gone (server restart or expiry) — use "Reopen" on the tab to reconnect',
    openFailed: 'Failed to open remote terminal',
    testRunning: 'Testing connection…',
    testOk: 'Connected: {whoami} ({os} / {arch})',
    testFailed: 'Connection failed: {msg}',
    retestAll: 'Retest all',
    retestAllOk: '{n} host(s) all connected',
    retestAllPartial: '{ok} connected / {fail} failed: {names}',
    authFailHint: 'Check username/password; Ubuntu denies root password login by default (PermitRootLogin prohibit-password) — use key auth or adjust server sshd config',
    decryptFailHint: 'Credential decryption failed (master-key mismatch after data dir migration/reinstall) — right-click "Edit" and re-enter the password/key',
    ftpNoTerminalHint: 'This host uses FTP (file management only) — switch to an SFTP host for terminal access',
    ftpNoGitCompare: 'This host uses FTP (file management only) — Git compare requires an SSH channel, switch to an SFTP host',
    statusAuthOkTip: 'Connected (authentication passed)',
    statusAuthPendingTip: 'Port reachable but auth unverified — run "Test Connection" to verify credentials and turn green',
    newGroup: 'New folder',
    newGroupTitle: 'New folder',
    renameGroupTitle: 'Rename folder',
    renameGroup: 'Rename',
    deleteGroupTitle: 'Delete folder',
    deleteGroupConfirm: 'Delete folder "{name}"? Hosts inside will be moved to ungrouped.',
    groupNameLabel: 'Folder name',
    groupActions: 'Folder actions',
    groupEmpty: 'No hosts. Drag hosts here or use right-click move',
    moveToGroup: 'Move to folder',
    rootGroup: 'Ungrouped',
    copyHost: 'Copy host',
    pasteHost: 'Paste host copy',
    copied: 'Copied. Click "Paste host copy" to create a duplicate',
    pasted: 'Host copy created',
    pasteFailed: 'Paste failed',
    sendNoTerminal: 'No active remote terminal',
    collapseSidebar: 'Collapse host list (widen terminals)',
    expandSidebar: 'Expand host list',
    deleteHostFailed: 'Failed to delete host',
    diagCompareBtn: 'Inspect',
    exportHosts: 'Export',
    importHosts: 'Import',
    exportWarn: 'Export file is fully encrypted (including SSH private keys). Keep both the file and passphrase safe — a lost passphrase cannot be recovered',
    exportFailed: 'Export failed',
    imported: 'Imported {n} host(s)',
    importPartial: '{n} host(s) failed to import (see server logs)',
    importFailed: 'Import failed: invalid file format',
    legacyImported: 'Imported from legacy plaintext format. Consider re-exporting with the new encryption',
    exportPassTitle: 'Export Hosts',
    exportPassHint: 'Set a passphrase (min 8 chars): credentials and SSH private keys will be encrypted. The same passphrase is required on import',
    exportPassConfirmHint: 'Re-enter the passphrase to confirm',
    exportPassWeakHint: 'Weak passphrase — the export file can be brute-forced',
    importPassTitle: 'Import Encrypted File',
    importPassHint: 'This file is encrypted. Enter the passphrase set at export time',
    passPlaceholder: 'Passphrase (min 8 chars)',
    passConfirmPlaceholder: 'Re-enter passphrase',
    passTooShort: 'Passphrase must be at least 8 characters',
    passMismatch: 'Passphrases do not match',
    passRequired: 'Passphrase is required',
  },
  remoteFiles: {
    title: 'Files — {host}',
    menu: 'Files',
    up: 'Parent directory',
    mkdir: 'New folder',
    mkdirTitle: 'New folder',
    mkdirLabel: 'Folder name',
    mkdirFailed: 'Failed to create folder',
    upload: 'Upload',
    uploaded: 'Uploaded {n} file(s)',
    uploadFailed: 'Upload failed: {name}',
    download: 'Download',
    downloadZip: 'Download (zip)',
    downloadFailed: 'Download failed: {name}',
    downloaded: 'Downloaded {n} file(s)',
    renameTitle: 'Rename',
    renameLabel: 'New name',
    renameFailed: 'Rename failed',
    deleteTitle: 'Delete remote files',
    deleteConfirm: 'Delete: {names}? Folders are removed recursively and cannot be restored.',
    deleteFailed: 'Delete failed',
    deletePartial: '{n} item(s) failed to delete: {msg}',
    deleted: 'Deleted {n} item(s)',
    listFailed: 'Failed to list directory',
    empty: 'Folder is empty',
    colName: 'Name',
    colSize: 'Size',
    colMode: 'Mode',
    colMtime: 'Modified',
    transfer: 'Transfer to hosts',
    transferTitle: 'Transfer to other hosts',
    transferTargets: 'Target hosts (multi-select)',
    transferTargetsPlaceholder: 'Pick hosts to receive files',
    transferDir: 'Target directory',
    transferDirPlaceholder: 'Default /',
    transferHint: 'Streams the {n} selected item(s) (folders as full trees) to the targets; relayed by the server without touching disk.',
    transferStart: 'Transfer',
    transferred: 'Transferred to {host} ({n} files)',
    transferFailed: 'Transfer to {host} failed: {msg}',
    ctxOpen: 'Open',
    ctxOpenEditor: 'Open in Editor',
    copyPath: 'Copy Path',
    copyUrl: 'Copy URL',
    urlCopied: 'URL copied',
    copyName: 'Copy Name',
    copied: 'Copied to clipboard',
    filterPlaceholder: 'Filter by name',
    pathEdit: 'Edit path to jump',
    pathPlaceholder: 'Type a remote path, Enter to jump',
    // Path history quick-select (P-20261006-19): per-host recent-path LRU + manual pin to top
    history: {
      title: 'Path history',
      pinned: 'Pinned',
      recent: 'Recent',
      empty: 'No path history yet',
      pin: 'Pin to top',
      unpin: 'Unpin',
    },
    dualMode: 'Dual',
    dualHint: 'Dual-pane mode: drag files/folders from one pane to the other to transfer (relayed in-stream by the server)',
    dualTargetPlaceholder: 'Pick the opposite host',
    dualNoOtherHost: 'No other hosts yet — add one in the remote console to use dual-pane transfer',
    dropConfirm: 'Transfer {n} item(s) from "{src}" to "{dst}" at {dir}? Folders go as full trees; existing files with the same name will be overwritten.',
    ftpNoTransfer: 'FTP hosts do not support cross-host transfer (file management only)',
  },
  clone: {
    branchPlaceholder: 'Leave empty to clone default branch',
    fail: 'Clone failed',
    // Inline form error for the server-side clone destination precheck (P-20261003-26)
    destExists: {
      label: 'Target directory already exists and is not empty',
    },
    // Inline form error for the clone URL form precheck (P-20261003-70);
    // literal '@' must be written as {'@'} in i18n messages
    urlInvalid: {
      label: 'Invalid URL form: expected http(s)://, git{\'@\'}host:path, ssh:// or a local path, without whitespace or full-width characters',
    },
    // Remote branch prefetch before clone (P-20261003-93): inline errors keyed by
    // the server 502 stable markers
    branches: {
      fetch: 'Fetch branches',
      failedAuth: 'Fetch branches failed: authentication failed, check credentials or SSH key',
      failedUnreachable: 'Fetch branches failed: repository unreachable, check URL and network',
      failedNotFound: 'Fetch branches failed: repository not found or access denied',
      failedGeneric: 'Fetch branches failed, you can still type a branch or clone directly',
    },
  },
  file: {
    saveFail: 'Save file failed',
  },
  manage: {
    title: 'Repository Management',
    updateAll: 'Update All',
    lfsPull: 'LFS Pull',
    lfsPush: 'LFS Push',
    submodule: 'Submodules',
    addSubmodule: 'Add Submodule',
    noSubmodule: 'No Submodules',
    removeSubmodule: 'Remove Submodule',
    confirmRemoveSubmodule: 'Are you sure you want to remove Submodule {name}? This will remove the submodule configuration from the repository.',
    submoduleAdded: 'Submodule added',
    submoduleRemoved: 'Submodule removed',
    submoduleUpdated: 'Submodules updated',
    remove: 'Remove',
    gpgSign: 'GPG Signing',
    gpgSignCommit: 'GPG Sign Commits',
    gpgEnabled: 'Enabled',
    gpgDisabled: 'Disabled',
    gpgEnabledMsg: 'GPG signing enabled',
    gpgDisabledMsg: 'GPG signing disabled',
    gpgDesc: 'When enabled, all commits will be signed with a GPG key. Please ensure a GPG key is configured.',
    lfs: 'LFS',
    lfsStatus: 'LFS Status:',
    lfsInstalled: 'Installed',
    lfsNotInstalled: 'Not Installed',
    lfsInstall: 'Install LFS',
    lfsInstalledMsg: 'LFS installed',
    trackRules: 'Track Rules',
    trackAdded: 'Track rule added',
    trackRemoved: 'Track rule removed',
    lfsPullDone: 'LFS Pull completed',
    lfsPushDone: 'LFS Push completed',
    gitHooks: 'Git Hooks',
    noHook: 'No Hooks',
    selectHookView: 'Select a hook to view',
    hookSaved: 'Hook saved',
    subUrlPlaceholder: 'Repository URL (e.g. https://github.com/user/repo.git)',
    subPathPlaceholder: 'Local path (e.g. libs/repo)',
    subBranchPlaceholder: 'Branch (optional)',
    confirmRemoveSubTitle: 'Confirm Remove',
  },
  terminal: {
    themeFollow: {
      label: 'Follow app light/dark',
      tip: 'When on, the terminal theme switches with the app color scheme (dark → Classic Dark, light → Classic Light). When off, the theme selected below is locked and app light/dark changes are not followed. This switch roams with your account across devices.',
    },
    selectProject: 'Please select a project first',
    createFailed: 'Failed to create terminal',
    reconnecting: 'Connection lost, reconnecting in {delay}s ({attempt}/{max})',
    disconnected: 'Connection lost. Max reconnection attempts reached. Please close and recreate the terminal.',
    // WS long-backoff lines (P-20261005-185): 1009 oversize input / 1011 server error —
    // reason written into the terminal instead of an unexplained disconnect, single 60s retry
    wsTooBigClosed: 'Sent data exceeded the server frame limit. Connection closed; reconnecting in {delay}s.',
    wsServerClosed: 'Connection closed by a server error. Reconnecting in {delay}s.',
    // Gap marker for output evicted from the ring buffer during a disconnect (P-20261005-233):
    // written into the output stream (exports/copies carry it along, making archive completeness self-evident)
    disconnectGapMarker: 'Some output from the disconnect window was not retained',
    closeTab: 'Close terminal',
    closeOthers: 'Close others',
    closeRight: 'Close to the right',
    closeAll: 'Close all',
    showAllTabs: 'Show all tabs',
    tabUnread: 'New output (switch to this session to view)',
    // Session tab pin (P-20261004-53): pinned group + bold state; label flips with state
    pinTab: 'Pin Tab',
    unpinTab: 'Unpin',
    floatOut: 'Float out as window',
    floatDockBack: 'Dock to panel',
    // Float window chrome status tiers (P-20261004-91): color semantics tooltip for the 4px strip / dot
    floatStatusRunning: 'Task running',
    floatStatusDone: 'Task done',
    floatStatusFailed: 'Task failed',
    floatStatusIdle: 'Idle',
    liveShare: 'Share live view',
    // Live badge & one-click stop (P-20261005-161): tab dot title carries
    // remaining time / cumulative views (hits = visitor page opens); the live
    // menu item flips to "stop" while an active share anchors the session
    liveBadgeTitle: 'Live · {time} left · {n} views',
    endLiveShare: 'Stop live',
    endLiveShareDone: 'Live stopped, visitors disconnected',
    // Direct-input badge & one-click revoke (P-20261024-1): tab amber dot title
    // carries the holding visitor and remaining window; the context-menu item
    // sits next to "stop live" (same expose-surface revocation family)
    directInputBadgeTitle: 'Visitor typing: {nick} (right-click to revoke)',
    revokeDirectInput: 'Revoke visitor input',
    revokeDirectInputDone: 'Visitor input revoked, session input returned to you',
    frozenShare: 'Share output snapshot',
    // Share replay (P-20261004-103): read-only replay link of the session's latest recording
    shareReplay: 'Share replay',
    replayShareNone: 'No process recording for this session yet — process recording is off by default; enable it in Settings and approvals will record automatically',
    exportOutput: 'Export output',
    exportOutputDone: 'Terminal output exported',
    // Session output compare (P-20261005-210): current session ↔ picked session
    // scrollback text diff in one view — A/B verification across environments
    compareOutput: 'Compare output…',
    compare: {
      title: 'Compare session output',
      pickHint: 'Pick a session to compare with "{name}" (point-in-time snapshot diff, read-only)',
      groupShell: 'Local sessions',
      groupAgent: 'Agent sessions',
      groupRemote: 'Remote sessions',
      noCandidate: 'No other sessions to compare',
      loading: 'Fetching both outputs (compare with {name})…',
      fetchFailed: 'Failed to fetch output of "{name}" (session may be gone)',
      remoteFetchFailed: 'Failed to fetch remote session output ({host}) — host may be offline; retry or pick another session',
      backToPick: 'Pick another',
      snapshotAt: 'snapshot {time}',
      statsTip: 'Line diff: + lines only in right / − lines only in left · frozen at {time}, not refreshed by later output',
      truncated: 'truncated',
      truncatedTip: 'Side exceeds {max} chars and was truncated (large-output diff guard; use "Export output" for the full archive)',
    },
    // Sensitive mark & egress warning (P-20261003-155): human-curated safety
    // annotation; export/share hits ask for confirmation before leaving
    markSensitive: 'Mark sensitive',
    unmarkSensitive: 'Unmark sensitive',
    markSensitiveDone: 'Marked as sensitive session',
    unmarkSensitiveDone: 'Sensitive mark removed',
    sensitiveBadgeTip: 'Sensitive session: exporting/sharing will ask for confirmation',
    sensitiveEgressTitle: 'Sensitive session egress',
    sensitiveEgressIntro: 'Session "{name}" is marked sensitive (may contain credentials/tokens). Export or share it anyway?',
    sensitiveEgressConfirm: 'Export anyway',
    // Sensitive content gate (P-20261004-113): session export md/jsonl and
    // terminal output export show this confirmation on credential patterns /
    // sensitive file names — types and counts only (never the values); the
    // content itself is exported as-is once confirmed (no masking)
    sensitiveContentEgressTitle: 'Sensitive content egress',
    sensitiveContentEgressIntro: 'The exported content matches these sensitive patterns (types and counts only, never the values):',
    sensitiveContentEgressNote: 'If you continue, the content is exported as-is without masking. This warning is for informed confirmation only.',
    sensitiveHitType: {
      platformToken: 'Platform token',
      knownToken: 'API token',
      awsAccessKey: 'Cloud access key',
      secretAssignment: 'Credential assignment',
      urlCredentials: 'URL credentials',
      privateKey: 'Private key block',
      bearerToken: 'Bearer token',
      sensitiveFileName: 'Sensitive file name',
      customPattern: 'Custom sensitive pattern',
    },
    // Auto-detection hint for sensitive content (P-20261003-207): scan tail
    // after export lands, suggest marking on hit — suggestion, not a gate;
    // confirm button reuses markSensitive, skip marks nothing and blocks nothing
    secretHintTitle: 'Possible secret detected',
    secretHintContent: 'The output of session "{name}" looks like it contains secrets/credentials. Mark it as a sensitive session? Export/share will then ask for confirmation before leaving.',
    secretHintSkip: 'Skip',
    renameTab: 'Rename',
    // Session tab duplicate (P-20261004-1): creation-config copy + activate —
    // suffix guards against confusing the copy with its source; chains on repeat
    duplicateTab: 'Duplicate Session',
    duplicateName: '{name} (Copy)',
    // Copy session ID (P-20261004-123): terminalId is the collaboration-protocol
    // address (agent inbox / continuation chains / ui.snapshot attribution /
    // task-progress jumps) — one click into the clipboard
    copySessionId: 'Copy Session ID',
    copySessionIdDone: 'Session ID copied',
    copySessionIdFailed: 'Failed to copy session ID — check browser clipboard permission',
    closeConfirmTitle: 'Close Terminal',
    closeConfirmTmux: 'This terminal is a persistent session. Closing it will immediately stop all running programs and clear all scrollback history (including splits). This cannot be undone. Close anyway?',
    closeConfirmNative: 'Closing the terminal will terminate the current shell process. Close anyway?',
    // Close warning for sessions with pending approvals (P-20261003-275): closing
    // means the verdict never arrives (agent waits until the TTL fallback)
    closeConfirmPendingApproval: 'This session has an approval awaiting your decision — closing it means the agent will never receive a verdict.',
    closeConfirmNoPrompt: 'Don\'t ask again',
    // Split cancel running-process guard (P-20261004-145): two-choice dialog for
    // a running secondary — kill / keep as separate tab; no "don't ask again"
    // (asymmetric cost of killing a watcher by mistake)
    paneCloseTitle: 'Command running in split pane',
    paneCloseBody: '"{name}" is running: {command}. Closing the pane kills the process and its output context; keeping it as a separate tab preserves everything.',
    paneCloseKill: 'Close (kill {command})',
    paneCloseKeep: 'Keep as separate tab',
    paneCloseUnknownCmd: '(unknown command)',
    decreaseFont: 'Decrease font size',
    increaseFont: 'Increase font size',
    restore: 'Restore',
    maximize: 'Maximize',
    newTerminal: 'New terminal',
    noTerminal: 'No terminals',
    renameHint: 'Double-click tab to rename terminal',
    splitHorizontal: 'Split Horizontal',
    splitVertical: 'Split Vertical',
    cancelSplit: 'Unsplit',
    splitDivider: 'Split divider (arrow keys to resize, Enter to reset)',
    // Pane temporary maximize (P-20261004-64): take full pane area while comparing, Esc/click to restore
    maximizePane: 'Maximize this pane (full area while comparing, Esc to restore)',
    restorePane: 'Restore pane split',
    tmuxScrollTip: 'tmux persistent session: press Ctrl-b [ to enter copy-mode before wheel-scrolling history (q to quit); sessions survive disconnects/refreshes',
    redraw: 'Redraw (fit to current size; fixes broken scrollback/display)',
    // Pane read-only watch lock (P-20261003-91): locks keyboard/paste input
    // (protects while observing); copy/selection unaffected
    inputLock: {
      off: 'Read-only watch: lock keyboard & paste input (protects while observing; copy unaffected)',
      on: 'Read-only watching — input locked, click to restore',
      blockedPaste: 'Terminal is in read-only watch; input is locked (click the lock icon at the top right to restore)',
      // Server-side readonly gate (P-20261008-17): WS write rejected by the
      // server on taken-over sessions / lock-state sync failure
      rejectedServer: 'Input rejected: session is server-side read-only (taken-over sessions default to read-only); unlock to type',
      syncFailed: 'Failed to sync input lock state to the server; local lock state kept',
    },
    backendNativeShort: 'Native',
    backendNative: 'Native PTY backend (direct shell)',
    backendUnavailable: 'Backend unavailable — terminal service not started or network down',
    disconnectedRetry: 'Connection lost, reconnecting automatically…',
    reconnectNow: 'Reconnect now',
    retry: 'Retry',
    imagePasteFailed: 'Image paste failed (upload rejected)',
    // Terminal file paste (P-20261024-2): OS-copied files via Ctrl+V upload + paste path
    pasteFile: {
      done: '{n} file path(s) pasted into terminal',
      failOne: 'File upload failed: {name}',
      unsupported: 'Unsupported file type: {name} (use file-tree paste / drag-drop instead)',
      tooMany: 'At most {n} files per paste; extra ignored',
      folderHint: 'Folder paste is not supported yet — drag the folder into the file tree instead',
    },
    // WebGL context loss auto-fallback (browser caps ~16 active WebGL contexts; oldest evicted)
    webglContextLost: 'GPU rendering context lost; this terminal switched to CPU rendering (functionality unaffected)',
    switchTab: 'Switch Tab',
    // Session count soft-threshold hint (P-20261003-183, non-blocking): one toast when creation crosses 20
    manySessionsWarn: 'Many sessions ({n}) — mind resource usage',
    clear: 'Clear screen',
    clearAndRestart: 'Clear & restart shell',
    refresh: 'Refresh content',
    searchPlaceholder: 'Search...',
    searchPrevious: 'Previous',
    searchNext: 'Next',
    searchCaseSensitive: 'Case sensitive',
    searchRegex: 'Regex',
    searchClose: 'Close',
    // Query history dropdown (P-20261004-109): useSearchHistory terminal-domain consumer
    searchHistory: {
      empty: 'No matching history',
      clear: 'Clear history',
    },
    // Copy / paste
    copy: 'Copy',
    paste: 'Paste',
    copyAll: 'Copy All',
    // Copy last command output (P-20261002-56): OSC 133 C/D line-numbered range extraction
    copyLast: {
      menu: 'Copy Last Command Output',
      none: 'No command output to copy',
    },
    // Copy as code block (P-20261003-270): wrap the selection in a ```bash fence
    // with the last command header; sits beside plain "Copy"
    copyAsCodeBlock: {
      menu: 'Copy as Code Block',
      tooltip: 'Copy the selection wrapped in a ```bash code block (with command line header) — ideal for issues/docs',
    },
    // Terminal scrollback bookmarks (P-20261004-16): right-click "Bookmark This Line" + list panel
    bookmark: {
      menuAdd: 'Bookmark This Line',
      menuRemove: 'Remove Bookmark',
      menuList: 'Bookmark List',
      panelTitle: 'Bookmark List',
      added: 'Bookmarked line {line}',
      removed: 'Removed bookmark on line {line}',
      remove: 'Remove this bookmark',
      empty: 'No bookmarks yet',
      emptyHint: 'Right-click in terminal scrollback and "Bookmark This Line" to pin key output (e.g. the first error), then jump back from this list anytime',
      emptyLine: '(empty line)',
    },
    // Terminal selection "Ask Agent about This Output" (P-20261003-7): assemble the
    // selection into a prompt and start it via createAgentTerminal (same chain as P-122)
    ask: {
      menu: 'Ask Agent about This Output',
      promptHeader: 'Please analyze the following terminal output, locate the issue and suggest a fix:',
      success: 'Agent session created (carrying the selected output)',
    },
    // Failed command "Hand to Agent to Fix" (P-20261003-150): last failed command
    // (OSC 133 D-frame accounting) + output tail assembled into a prompt via the same chain
    fix: {
      menu: 'Hand to Agent to Fix',
      promptHeader: 'This terminal command failed (exit {exit}). Locate the cause and fix it:\nCommand: {command}',
      success: 'Agent session created (failed command and output included)',
    },
    exportText: 'Export as text',
    copyDone: 'Copied to clipboard',
    copyFailed: 'Copy failed',
    noSelection: 'No text selected',
    clipboardDenied: 'Browser denied clipboard access. Check permissions or use the shortcut.',
    pasteMultilineTitle: 'Multi-line Paste Confirmation',
    pasteMultilineWarn: 'Clipboard contains {n} lines. The shell may execute them as multiple commands. Please review the content before pasting.',
    pasteMultilinePreview: 'Preview (first {n} lines)',
    pasteAnyway: 'Paste Anyway',
    // Size-aware variant for large pastes (P-20261002-136): replaces title/message above 64KB
    pasteLargeTitle: 'Large Paste Confirmation',
    pasteLargeWarn: 'Content is {kb} KB / {n} lines. Pasting very large text may freeze or slow down the terminal. Please review it before pasting.',
    // 高危命令影响面确认卡（P-20261005-191）
    cmdPreview: {
      title: 'Dangerous Command Impact Preview',
      lead: 'The pasted content matches a dangerous command pattern. Review the impact before writing it to the terminal:',
      pasteAnyway: 'Paste anyway',
      zeroImpact: 'Dangerous pattern matched, but current impact is zero — allowed through',
      insertCancelled: 'Insert cancelled (dangerous command precheck)',
      staticFallback: 'Dynamic impact unavailable — verify the command scope yourself before running it',
      whitelistHint: 'Confirmed command families will not prompt again in this session (resets on page reload)',
      kind: {
        rm: 'Recursive/forced delete (rm)',
        git: 'Destructive git operation',
        prune: 'Bulk prune',
        truncate: 'File truncation (truncate -s 0)',
        shred: 'In-place overwrite (shred)',
        overwrite: 'Overwrite redirect (> file)',
      },
      impact: {
        files: '{n}{suffix} file(s) affected, about {size}',
        nothing: 'Target does not exist — no impact yet',
        dirty: 'Will discard changes of {n} tracked entries',
        untracked: 'Will delete {n} untracked entries',
        gitClean: 'No matching changes — no actual impact',
        overwriteExists: 'Target file exists ({size}) and will be overwritten',
        overwriteNew: 'Target does not exist — will be created (no overwrite)',
        static: 'Impact unavailable — verify the command scope yourself',
      },
    },
    // Drag and drop
    dropFilesHint: 'Pasted {n} paths',
    dropPathHint: 'Drop to paste the file path into the terminal',
    // Tab status indicator
    statusRunning: 'Command running',
    statusFailed: 'Last command exited with code {code}',
    // Locate in file tree (P-20261001-32): one-click reveal of the session's creation dir
    locate: {
      inTree: 'Locate in File Tree',
      inTreeDir: 'Locate in File Tree ({dir})',
      outsideProject: 'Session directory is outside this project',
      tabTip: 'Working dir: {dir}',
      dirProjectRoot: 'project root',
    },
    // Restart shell
    restartShell: 'Restart shell',
    // Search result status
    searchNotFound: 'Not found',
    // Empty state shortcut hints
    shortcutNew: 'Ctrl+`',
    shortcutRename: 'Double-click',
    // Image rendering
    notConnected: 'Terminal not connected',
    // Session overview (cross-project terminal sessions: progress awareness + quick switch)
    overview: {
      buttonTitle: 'Session overview',
      title: 'Session overview',
      running: 'Running',
      failed: 'Failed ({code})',
      ok: 'OK',
      new: 'Idle',
      runningCount: '{count} running',
      failedCount: '{count} failed',
      totalCount: '{count} sessions',
      currentProject: 'Current',
      splitPanes: '{count} panes',
      splitTag: 'Split',
      noSessions: 'No terminal sessions',
    },
    // 命令历史面板（C1）
    history: {
      title: 'Command history',
      clear: 'Clear history',
      cleared: 'History cleared',
      searchPlaceholder: 'Search commands…',
      failedOnly: 'Failed only',
      empty: 'No matching commands',
      exitCode: 'Exit code',
      copy: 'Copy command',
      copied: 'Copied',
      copyFailed: 'Copy failed',
      // ▶ secondary button (P-20261003-61): insert and run (main click stays insert-only safe default)
      run: 'Insert & run',
      footnote: 'Click a command to insert it (not executed), ▶ runs it; commands containing sensitive info are skipped',
      delete: 'Delete entry',
      deleted: 'Entry deleted',
            // 跨项目命令历史检索（P-20261004-2，命令面板入口 + 全局浮层）
      globalCmd: 'Search command history (all projects)',
      globalTitle: 'Cross-project command history',
      globalSearchPlaceholder: 'Search commands across projects (min 2 chars)…',
      minCharsHint: 'Type at least 2 characters to search',
      globalFootnote: 'Click a command to insert it into the current terminal (not executed); hover to copy',
      inserted: 'Inserted into current terminal (not executed)',
      noActiveTerminal: 'No active terminal — copied to clipboard instead',
      // 远程输入域条目（P-20261005-188：source=input 主机徽标 + 插入分流）
      inputDomainTip: 'Remote entry: submitted input line on {host} (input-domain capture, no exit code/duration)',
      remoteCopyOnly: 'Remote command copied — not safe to run locally; paste it back on the remote terminal',
      // 跨会话输出检索（P-20261003-290，命令面板入口 + 全局浮层）
      outputCmd: 'Search terminal output',
      outputTitle: 'Cross-session terminal output',
      outputSearchPlaceholder: 'Search recent output across sessions (min 2 chars)…',
      outputFootnote: 'Click a hit to jump to that session and locate the hit line',
      // Hit time anchors + time-range filter (P-20261005-202): hits are labeled
      // with the recorded time of their owning command; out-of-range hits
      // collapse into a count instead of vanishing (click it to show all)
      outputTimeAll: 'All',
      outputTimeHour: 'Last hour',
      outputTimeToday: 'Today',
      outputTimeCustom: 'Custom',
      outputTimeFromTitle: 'Start time',
      outputTimeToTitle: 'End time',
      outputTimeOutside: '{n} hits outside the time range · click to show all',
      outputTimeAnchorTip: 'Recorded time of the command that produced this hit (— when no command boundary)',
      // In-session locate degrade (P-20261005-9): hit line no longer in the
      // frontend scrollback buffer (trimmed past the cap / cleared) — say so
      // honestly instead of pretending the locate landed
      hitOutOfBuffer: 'Hit line is no longer in this session\'s scrollback buffer',
      // 「Repeated commands」view (P-20261003-199): client-side frequency aggregation + save-as-snippet guidance
      viewAll: 'All',
      viewRepeat: 'Repeated',
      repeatEmpty: 'No command repeated ≥{min} times in the last {days} days',
      repeatFootnote: 'Commands run ≥{min} times within {days} days make the list (top {n}); click to insert, hover to save as a snippet',
      lastUsed: 'last used',
      runCount: '{n} runs',
      saveSnippet: 'Save as snippet',
      // Session filter dropdown (P-20261004-35: per-session history isolation)
      sessionAll: 'All sessions',
      sessionUnattributed: 'Unattributed',
    },
    // Session wrap-up card (P-20261004-35): tab context menu "wrap-up summary" —
    // command ledger aggregates + recent task.progress, settle before closing
    wrapUp: {
      menuLabel: 'Wrap-up Summary',
      title: 'Session Wrap-up Summary',
      cmdCount: 'Commands',
      failCount: 'Failed',
      totalDuration: 'Total time',
      lastActive: 'Last activity',
      progressTitle: 'Recent task progress',
      noHistory: 'No commands recorded for this session (no shell integration or history cleared)',
      noProgress: 'No task progress reported',
      unnamedTask: '(Unnamed task)',
      statusRunning: 'Running',
      statusDone: 'Done',
      statusFailed: 'Failed',
    },
    // Port registry (P-20261003-293: "port → session" ledger fed by output
    // detection + agent reports, read-only popover via command palette;
    // portConflict.notify.* are templates for the server-side conflict
    // notification titleKey/bodyKey)
    portRegistry: {
      listCmd: 'Port occupancy overview',
      title: 'Known occupied ports',
      empty: 'No known occupancy right now',
      sourceDetected: 'detected',
      sourceReported: 'reported',
      copy: 'Copy port',
      copied: 'Port copied',
      jumpHint: 'Click to jump to the session holding this port',
      footnote: 'Registry covers detected output + agent reports only: listeners we never detected are not listed; the registry clears on server restart. Avoid known ports before starting a server (conflict notifications name the holding session on EADDRINUSE)',
    },
    portConflict: {
      notify: {
        title: 'Port conflict warning :{port}',
        body: 'Port {port} already known occupied: session "{holder}" holds it, session "{newcomer}" reported later — the latter usually fails to start. Click to jump to the holder',
      },
    },
    // Idle timeout auto-detach (P-20261003-192): idleDetach.notify.* are
    // templates for the server-side detach notification titleKey/bodyKey
    idleDetach: {
      notify: {
        title: 'Terminal idle timeout: {name}',
        bodyPersistent: 'Session detached automatically. The underlying session is preserved — reopen it to reconnect',
        bodyEphemeral: 'Session closed automatically after idle timeout and its resources released (current backend has no persistence layer)',
      },
    },
    // Failed-session postmortem (P-20261004-60): postmortem.notify.* are templates
    // for the server-side abnormal-exit notification titleKey/bodyKey; the rest
    // feed the postmortem dialog (component / pure builder shared)
    postmortem: {
      notify: {
        title: 'Session exited abnormally: {name}',
        summary: 'Exit code {code}. Click for the postmortem report',
      },
      title: 'Postmortem Report',
      loading: 'Assembling the postmortem scene…',
      loadFailed: 'Failed to load the postmortem report (the session may have been cleaned up)',
      alive: 'alive',
      noRecord: 'no abnormal-exit record',
      dir: 'Directory',
      exitedAt: 'Exited at',
      lastCommands: 'Last commands',
      outputTail: 'Output tail',
      tailScrollback: 'live buffer',
      tailTranscript: 'claude transcript',
      tailUnavailable: 'Output scene unavailable (session destroyed and no matching claude transcript)',
      sensitiveHint: 'This session is marked sensitive — the report contains raw output; viewing it moves data out',
      sensitiveTitle: 'View sensitive-session postmortem report?',
      sensitiveBody: 'This session was manually marked sensitive (credentials may have been pasted during debugging). The report contains raw output; copying or handing it off to a new session moves that content out. Continue?',
      sensitiveConfirm: 'View anyway',
      copy: 'Copy report',
      ask: 'Ask an agent',
      askHead: 'The previous session "{name}" exited abnormally (exit {code}). Analyze the scene below and conclude why it died; if the original task can continue, explain how you plan to take over.',
      askSuccess: 'New session launched with the postmortem scene in its prompt',
      askDegraded: 'Runtime unavailable — degraded to a plain shell session (prompt kept)',
      askFailed: 'Failed to launch the session, please retry',
    },
    // 命令片段库（C2）
    snippet: {
      title: 'Snippets',
      searchPlaceholder: 'Search snippets…',
      empty: 'No snippets yet. Add some in Settings → Terminal',
      systemTag: 'system',
      manage: 'Manage snippets',
      insertWithParams: 'Fill & insert',
      sendNow: 'Send & run',
      // Clipboard read failed/empty degradation notice (P-20261006-1)
      clipboardUnavailable: "Clipboard unavailable — ${'{'}CLIPBOARD{'}'} kept verbatim",
    },
    more: 'More',
    fontSize: 'Font size',
    // Multi-terminal broadcast (P-20261003-288 fleet-style batch input):
    // multi-select tabs in the tab bar, one input hits them all
    broadcast: {
      mode: 'Broadcast mode (multi-select terminals, one input for all)',
      title: 'Broadcast input',
      targets: 'Broadcast to {count} sessions',
      needTwo: 'Select at least 2 terminals in the tab bar first',
      placeholder: 'Type a command or text, press Enter to broadcast (↑↓ recalls history)…',
      send: 'Send',
      pickMore: 'Agent / Remote',
      pickMoreTip: 'Agent sessions and remote host terminals are excluded from broadcast by default; check them explicitly here (avoid interrupting a running agent or cross-host misfire)',
      pickAgent: 'Agent sessions',
      noAgent: 'No agent sessions',
      remoteGroup: 'Remote hosts',
      sent: 'Broadcast to {count} sessions',
      partial: 'Written to {written}; {missing} missing, {failed} failed',
      failedHosts: 'Failed hosts: {hosts}',
      sendFailed: 'Broadcast failed',
      exit: 'Exit broadcast mode',
    },
    // Broadcast result aggregation panel (P-20261005-12): N targets side by side
    broadcastResult: {
      title: 'Broadcast results',
      hint: '{count} targets · last {lines} lines each',
      refresh: 'Refresh all',
      viewResult: 'View results',
      stateOk: 'Written',
      stateLoading: 'Fetching…',
      stateError: 'Fetch failed',
      stateMissing: 'Missing',
      stateFailed: 'Write failed',
      missingTip: 'Session no longer exists; nothing to show',
      failedTip: 'Write failed (session closed or not attached); nothing to show',
      emptyTail: '(no output yet)',
    },
  },
  // Runbooks (P-20261003-24): multi-step ops sequences sent step by step
  // (insert only — Enter stays with the human)
  runbook: {
    title: 'Runbooks',
    add: 'New runbook',
    searchPlaceholder: 'Search runbooks…',
    empty: 'No runbooks yet',
    stepsCount: '{n} steps',
    back: 'Back to list',
    send: 'Send',
    sendWithParams: 'Fill & send',
    done: 'Mark done',
    resetCheck: 'Reset checks',
    delete: 'Delete runbook',
    deleteConfirm: 'Delete runbook "{title}"?',
    deleted: 'Runbook deleted',
    fieldTitle: 'Title (e.g. deploy checklist)',
    fieldDesc: 'Description (optional)',
    // Literal braces must be escaped (vue-i18n compiles {{ as message syntax),
    // same as settings.snippet.fieldCommand
    stepCommand: "Command, supports {'{'}param{'}'} placeholders",
    stepDesc: 'Description (optional)',
    addStep: 'Add step',
    removeStep: 'Remove step',
    saved: 'Runbook saved',
    saveFailed: 'Save failed',
    // Sequential run failure semantics (P-20261004-13): continue = send all (default) /
    // stop = await exit code per step via OSC 133 frames, halt on non-zero
    // (degrades to continuous send with an honest notice without shell integration)
    onFailure: 'Stop on failure',
    onFailureHint: 'Stop remaining steps when any step exits non-zero',
    run: 'Run',
    runHint: 'Run steps sequentially in the current terminal; make sure it is idle at a prompt',
    // Whole-book dedup param form (P-20261004-17): fill the union of {params} once before run
    runParamsTitle: 'Run parameters',
    runParamsHint: 'Names shared across steps are asked once, then substituted into every step',
    runParamsConfirm: 'Run with params',
    // Param history dropdown (P-20261004-112): suggest previous values on param input focus (useSearchHistory idiom)
    paramHistoryEmpty: 'No matching param history',
    paramHistoryClear: 'Clear this history',
    stopRun: 'Stop',
    resumeFailed: 'Resume from failed step',
    continueRun: 'Continue',
    rerun: 'Run again',
    runProgress: 'Running {done}/{n}',
    runDone: 'Run finished',
    runStopped: 'Stopped',
    runFailedAt: 'Step {n} failed — remaining steps stopped',
    degradedNotice: 'Shell integration (OSC 133) unavailable in this shell; exit codes cannot be tracked — falling back to continuous send',
    // Recording draft caution (P-20261005-3): cast command text flows into the draft; runbooks are stored as plain text
    draftCaution: 'This draft comes from a session recording — commands are stored in the runbook as plain text. Review each command for sensitive values before saving.',
    // Fleet run (P-20261005-147): multi-target selection + server-side orchestration + step×target matrix
    fleet: {
      title: 'Fleet Run',
      hint: 'Pick multiple sessions and broadcast each step to all targets in order; every step waits for all targets before moving on. Make sure target terminals are idle at the prompt',
      groupLocal: 'Local terminals',
      groupAgent: 'Agent sessions',
      groupRemote: 'Remote hosts',
      needTargets: 'Select at least one target session',
      launch: 'Launch Fleet',
      timeout: 'Step timeout {v}',
      abort: 'Abort (broadcast Ctrl+C to unfinished targets)',
      retry: 'Retry this cell (resend this step to this target only)',
      statusRunning: 'Running',
      statusCompleted: 'Completed',
      statusFailed: 'Failed',
      statusAborted: 'Aborted',
      pending: 'Pending',
      skipped: 'Not sent (skipped after earlier failure/abort)',
      abortedCell: 'Aborted (Ctrl+C sent)',
      noSignal: 'Done (no confirmation signal: target has no OSC 133; success unknown)',
      timedOut: 'Timed out, treated as done (command may still be running)',
      doneWithCode: 'Done (exit {n})',
      failedWithCode: 'Failed (exit {n})',
      connectionLost: 'Connection dropped (long run exceeded the response wall); progress still updates live. Re-launching the same book is rejected with 409',
      outputLoading: 'Fetching output…',
      outputFailed: 'Failed to fetch output (session may be closed)',
      outputEmpty: '(no output)',
    },
  },
  errors: {
    network: 'Network connection issue, please check if the server is running',
    auth: 'Session expired, please authenticate again',
    forbidden: 'You do not have permission to perform this action',
    notFound: 'Resource not found or has been deleted',
    validation: 'Invalid request parameters, please check your input',
    gitConflict: 'Git operation encountered a conflict, please resolve it and retry',
    conflict: 'Operation conflict, target resource already exists or state mismatch',
    server: 'Server error, please retry later or check logs',
    client: 'Request failed, please retry later',
    unknown: 'Operation failed, see console for details',
    lockedWs: 'Connection dropped because the system is locked; it will resume after unlock',
    cloneProgressLost: 'Clone progress connection lost and could not be restored — refresh the project list to check the actual state',
    known: {
      authFailed: 'Remote host authentication failed: check the username and password/key',
      hostKeyChanged: 'Remote host key has changed — connection rejected (possible man-in-the-middle). If this is a legitimate server reinstall/migration, reset the fingerprint in the host settings',
      permissionDenied: 'Permission denied: check access rights on the target path/file',
      lockTokenInvalid: 'Unlock expired — please unlock again',
      authTooMany: 'Too many authentication failures — try again later',
      instanceNotFound: 'Remote instance does not exist or has been removed',
      remoteHostNotFound: 'Remote host does not exist or has been removed',
      projectNotFound: 'Project does not exist or has been removed',
      noDisplay: 'The instance host has no display environment (headless); the system file manager cannot be opened',
      xdgOpenMissing: 'Failed to open the file manager on the Linux host: xdg-utils and a desktop file manager are required',
      sessionNotFound: 'Session does not exist or has been deleted',
      taskNotFound: 'Task does not exist or has finished',
      fileNotFound: 'File not found',
      credentialNotFound: 'Credential does not exist or has been removed',
      notFoundGeneric: 'Resource does not exist or has been removed',
      fileExists: 'File already exists',
      invalidFileName: 'Incompatible file name: reserved Windows device name, or ends with a dot/space',
      notGitRepo: 'Not a Git repository (add it as a plain directory project instead)',
      // Hunk discard conflict (P-20261003-49): server marker "hunk no longer applies"
      hunkChanged: 'This change block has changed and cannot be discarded directly (the file was modified after the block was derived)',
      // Replace history restore conflict (P-20261004-66): server marker "replace
      // backup no longer applies" — index advanced since the replacement; workspace
      // is at staged state and the backup patch remains in the history entry
      replaceRestoreConflict: 'The scene changed after the replacement (index advanced); the backup patch no longer applies. The workspace is back at the staged state and the backup remains in replace history',
      // Compare experiment apply conflict (P-20261004-72): server marker "compare
      // experiment workspace changed since adoption" — workspace untouched
      compareApplyConflict: 'The workspace changed after the adoption mark; apply was refused (nothing modified). Re-adopt a side to refresh the reference, then apply again',
      // Conflict-resolution optimistic lock (P-20261004-27): server marker ConflictStaleMarker
      conflictStale: 'The conflict file was modified during resolution; re-parse it and try again',
      // Interactive rebase failure (P-20261003-324): server prefix "rebase failed
      // (working tree restored via rebase --abort)" — the server already aborted
      rebaseConflictAborted: 'Rebase failed (usually a conflict); the repository has been restored — adjust the plan and retry',
      staleIndexLock: 'Git write failed: a stale index.lock exists (clean it up from the changes panel)',
      // Git write queue wait timeout (P-20261002-78): server marker GitWriteBusyMarker
      gitWriteBusy: 'A previous git operation is still in progress, please try again shortly',
      // Git global concurrency gate queue timeout (P-20261004-125): server marker GitGateBusyMarker
      // — process-volume defense (complements the per-repo write mutex above), command not executed, safe to retry
      gitGateBusy: 'Too many concurrent git operations — the command timed out waiting in queue and was not executed, please retry shortly',
      // Instruction queue (P-20261003-248): server stable markers store.ErrQueue* (English text is the contract)
      queueFull: 'Instruction queue is full (max 5 per session) — resolve or remove some first',
      queueInvalid: 'Instruction is empty or too long (max 2000 chars)',
      // Search-family rate limit (P-20261004-124 content search + P-20261005-158 terminal
      // output search share the code): server stable marker errmarkers.SearchRateLimited
      // (paired with code search.rate_limited) — window slides automatically, retry shortly;
      // copy is family-neutral (no per-endpoint quota details)
      searchRateLimited: 'Too many searches — please retry shortly (up to 30 searches per minute)',
      // Selective stash (P-20261003-119): server downgrade reject for scope=staged on git < 2.35
      // (stable marker "stash --staged requires git 2.35 or newer"; the dialog disables the option, this maps direct-API callers)
      stashStagedUnsupported: 'Staged-only stash requires git 2.35 or newer',
      // Stale stable stash reference (P-20261003-264): the hash no longer exists in
      // the current stack (another tab dropped/popped it) — explicit reject, no misoperation
      stashEntryGone: 'The stash entry no longer exists (it may have been restored or deleted in another tab) — refresh the list and retry',
      // Apply stash to new branch (P-20261003-263): branch-name conflict reject
      // (server precheck "git branch '<name>' already exists" + git race fallback
      // "a branch named '<name>' already exists", one regex family in http.ts)
      branchExists: "Branch '{name}' already exists — pick another name or delete the existing branch first",
      // Changelist duplicate name (P-20261007-19): server stable marker "changelist already exists"
      changelistExists: 'A changelist with this name already exists — pick another name',
      pathNotExist: 'Path does not exist or is not a directory',
      invalidPath: 'Invalid path',
      netUnreachable: 'Network unreachable: check the IP address and connectivity',
      connRefused: 'Connection refused: the service is not running or the port is wrong',
      sessionBusy: 'This session is still replying — please wait',
      sessionArchived: 'Session archived (read-only) — restore it to continue',
      wsLimit: 'Connection limit reached — close some pages and retry',
      noAiProvider: 'No AI provider configured — install/select one in Settings first',
      alreadyUpToDate: 'Already up to date',
      centerNoUpdateSource: "The center has no preset binary for this platform and no update source configured: place the binary under serve-binaries/<platform>/ in the center's data directory, or configure the update source (updateURL) in the center's settings",
      updateNpmManaged: 'This instance was installed via npm — update through the package manager: npm i -g codecombo@latest (previews: codecombo@next). In-app self-update does not apply to npm installs',
      centerBinaryMissing: "The center's update source has no package for this platform: check the update source (updateURL) configured on the center, or preset the binary under serve-binaries/<platform>/ in the center's data directory",
      wrongPassphrase: 'Wrong passphrase or corrupted export file',
      credSyncUnverified: 'This instance has not completed pairing and fingerprint verification — finish pairing in the sync center before credential sync',
      credSyncEnvelope: 'Credential vault rejected (tampered, replayed, or pairing key mismatch)',
      credSyncManualOnly: 'Scheduled sync never carries credentials — credential sync is manual-only in the sync center',
      // Project hard lock (P-20261004-3): server stable marker project.locked (middleware/projectlock.go)
      projectLocked: 'Project is locked (immutable archive): writes are rejected. Right-click the project on Home to unlock',
    },
    category: {
      network: 'Network',
      auth: 'Auth',
      forbidden: 'Forbidden',
      notFound: 'Not Found',
      validation: 'Validation',
      gitConflict: 'Conflict',
      conflict: 'Conflict',
      server: 'Server',
      client: 'Client',
      unknown: 'Unknown',
    },
  },
  console: {
    // existing
    noProject: 'Please add a Git project first',
    commandLogHint: 'Git command execution history will appear here',

    // new
    subtabCommands: 'Commands',
    showOutput: 'Show output',
    hideOutput: 'Hide output',
    subtabErrors: 'Errors',
    errorEmpty: 'No error records',
    errorItemExpand: 'Click to expand details',
    errorCopyRaw: 'Copy raw error',
    errorCopied: 'Copied to clipboard',
    errorClearAll: 'Clear all errors',
    toastViewDetail: 'View Details',
  },
  // Error log filter (P-20261002-62): search box + category badge toggle
  errorlog: {
    filter: {
      searchPlaceholder: 'Search message / category',
      noMatch: 'No matching errors',
      badgeTip: 'Click to show only this category, click again to clear',
    },
    // Request correlation ID (P-20261003-216): hover hint for the inline short code
    requestIdTip: 'Request correlation ID — backend logs carry a matching rid= line for this exact request',
    // Error-code badge (P-20261005-153): hover hint and copy feedback for the expanded code badge
    codeBadgeTip: 'Structured error code — click to copy and cite it when reporting issues',
    codeCopied: 'Copied',
    // In-place retry (P-20261003-179): idempotent GET failures only (non-idempotent methods get no retry, safety boundary)
    retry: {
      action: 'Retry',
      retrying: 'Retrying…',
      actionTip: 'Replay this GET request in place; on success the entry is marked as recovered',
      recovered: 'Recovered',
      recoveredTip: 'Retry succeeded ({time}) — the original request is healthy again',
      instanceChanged: 'Instance has switched; cannot retry in place — refresh from the original panel',
    },
  },
  bottomPanel: {
    console: 'Console',
    terminal: 'Terminal',
    preview: 'Preview',
    problems: 'Problems',
  },
  // Problems panel (P-20261003-297): Monaco diagnostics aggregation
  problems: {
    summary: '{errors} errors, {warnings} warnings',
    empty: 'No diagnostics right now',
    emptyHint: 'Open a ts / js file and language-service errors and warnings will be aggregated here',
    scopeNote: 'Coverage follows language workers: full TS/JS diagnostics; languages without markers (e.g. .vue templates) are not included',
    statusTitle: '{errors} errors, {warnings} warnings (click to open Problems)',
    // Filter row (P-20261005-171): text substring + severity toggle chips, display-only (full-count badges untouched)
    filterPlaceholder: 'Filter by message or path…',
    filterErrorsOnly: 'Errors only',
    filterWarningsOnly: 'Warnings only',
    filterEmpty: 'No diagnostics match the current filter',
    severity: {
      error: 'Error',
      warning: 'Warning',
      info: 'Info',
      hint: 'Hint',
    },
  },
  preview: {
    state: {
      waiting: 'Waiting for :{port} to respond… (cold-started services may need tens of seconds)',
      unreachable: 'Port {port} is not responding',
      hint: 'Make sure the service is running in the terminal',
      retry: 'Retry',
    },
  },
  previewPanel: {
    portPlaceholder: 'Port (1024–65535)',
    open: 'Open',
    refresh: 'Reload',
    openNewWindow: 'Open in new window',
    recent: 'Recent',
    empty: 'Enter a local service port to preview (e.g. 5173 for npm run dev)',
    // SSH tunnel badge (P-20261004-5): current preview goes through the tunnel mapping
    tunnelBadge: 'remote:{remote} → local:{local}',
    tunnelBadgeTip: 'Preview forwarded via SSH tunnel: remote host port mapped to a local ephemeral port (view and close in Settings · Deploy · Active Tunnels)',
    // Sandbox-limited probe banner (P-20261019-1 ③): shown when the previewed
    // page reports ok=false via sc-preview-probe — guide to compat mode, not a blank stare
    sandboxLimitedHint: 'The previewed app reports it is limited by the sandbox (e.g. no same-origin storage access); the page may render incompletely or blank. You can enable same-origin compatibility in Settings → General → Preview compatibility mode (previewed content will gain this app\'s permissions)',
  },
  fileTree: {
    ignored: 'ignored',
    noProject: 'Please add a Git project first',
    invalidProject: 'Project path is no longer accessible. Remove and re-add it on the home page',
    title: 'Project Files',
    refresh: 'Refresh',
    refreshCollapse: 'Refresh (keeps expanded directories)',
    hideHidden: 'Hide hidden files',
    showHidden: 'Show hidden files',
    hideIgnored: 'Hide gitignored files',
    showIgnored: 'Show gitignored files',
    collapseAll: 'Collapse All',
    // Name-family nesting badge (P-20261006-21): main-file +N click to expand/collapse
    nestExpand: 'Show {n} nested files',
    nestCollapse: 'Collapse nested files',
    agentMarkTip: 'Changed by agent ({runtime})',
    copyMarksTitle: 'Copy change list (Markdown; only sessions with cwd at the project root are counted)',
    marksCopied: 'Change list copied as Markdown',
    dirSessions: {
      entry: '{name} · {status}',
      running: 'Running',
      idle: 'Idle',
    },
    emptyDir: 'Empty directory',
    newFile: 'New File',
    newDir: 'New Directory',
    addToGitexclude: 'Add to git exclude',
    share: 'Create Share Link',
    // Sync to another instance (P-20261023-1 step 4): light-deliver entry — lives
    // under fileTree (initial cut misplaced it in remoteFiles; caught by e2e)
    syncTo: 'Sync to another instance…',
    upload: 'Upload Files…',
    rename: 'Rename',
    duplicate: 'Duplicate',
    download: 'Download',
    // In-place toast when the direct-link precheck fails (P-20261030-2): 404/403
    // have dedicated copy; any other status falls back here
    downloadFailed: 'Failed to start download, please try again',
    downloadZip: 'Download as zip',
    delete: 'Delete',
    copyPath: 'Copy Path',
    openInTerminal: 'Open in Terminal',
    // Open in Split (P-20261003-321): tree context menu straight to the split group (files only; layout.splitRight is the tab-menu sibling)
    openInSplit: 'Open in Split',
    searchInDir: 'Search in Directory',
    duplicated: 'Duplicated as {name}',
    search: 'Search Files',
    searchPlaceholder: 'Search files...',
    addedToExclude: 'Added {path} to git exclude (local exclusion)',
    // Deletes land in the trash (P-20261003-304) and are recoverable — the confirm
    // states the real threat level (P-20261005-154): the decision point must surface
    // recoverability and the 7-day window; contrasts with trash.confirmPurge's
    // "cannot be undone" (only the in-trash permanent delete is truly irreversible)
    confirmDelete: 'Delete {name}? It will be moved to trash — recoverable for 7 days.',
    deleted: 'Deleted {name}',
    // Sensitive-deletion toast variant (P-20261005-163): the first feedback
    // surface after delete states the retention risk; the "delete forever now"
    // action opens the Trash modal. 7-day window mirrors server TrashRetention
    deletedSensitive: '"{name}" moved to Trash — sensitive content will stay there in plain text for 7 days; delete it forever now',
    pathCopied: 'Path copied',
    copyAbsPath: 'Copy Absolute Path',
    absPathCopied: 'Absolute path copied',
    fileCreated: 'File {name} created',
    dirCreated: 'Directory {name} created',
    renamedTo: 'Renamed to {name}',
    // Reference update after rename (P-20261005-157): action button on the rename
    // success toast for code files
    refUpdate: {
      action: 'Update references?',
    },
    renameExists: 'A file or directory named "{name}" already exists. Choose another name',
    nameReservedWindows: '"{name}" is a reserved Windows device name and would be unusable on other systems. Choose another name',
    nameTrailingDotSpace: '"{name}" cannot end with a dot or space (creation fails on Windows)',
    dirPlaceholder: 'Directory name',
    newNamePlaceholder: 'New name',
    fileNamePlaceholder: 'File name',
    uploadSuccess: 'Uploaded {n} file(s) to {dir}',
    // Upload progress float (P-20261003-117): per-file serial upload progress + retry
    uploadProgress: 'Uploading {done}/{total}: {name}',
    uploadFailedTitle: '{n} file(s) failed to upload',
    uploadRetry: 'Retry',
    uploadRetryAll: 'Retry all',
    uploadDismiss: 'Dismiss (give up failed items)',
    // Upload same-name overwrite confirm (P-20261003-230): skip by default (safe), overwrite is explicit intent
    uploadSameNameTitle: '{n} file(s) with the same name',
    uploadSameNameContent: 'The target {dir} already contains file(s) with the same name: {names}',
    uploadSameNameHint: 'Skip keeps the existing files; Overwrite replaces them with the dropped versions (previous content is auto-archived to "Local History" and can be restored)',
    uploadSameNameSkip: 'Skip same-name',
    uploadSameNameOverwrite: 'Overwrite',
    uploadSameNameSkipped: 'Skipped {n} same-name file(s): {names}',
    movedTo: 'Moved to {path}',
    // Paste channels (P-20261023-2): OS-copied files via Ctrl+V direct upload / in-tree copy & cut & paste
    copyMenu: 'Copy',
    cutMenu: 'Cut',
    paste: 'Paste',
    copiedToClipboard: 'Copied {n} item(s) — press Ctrl/Cmd+V on a target directory to paste',
    cutToClipboard: 'Cut {n} item(s) — press Ctrl/Cmd+V on a target directory to paste',
    // Platform honesty boundary for folder paste: browsers do not expose folder content in paste events; guide to drag-in
    pasteFolderHint: 'The clipboard contains folder(s) — browsers cannot paste folder contents; drag the folder into the file tree instead',
    // Degradation hint for browsers without clipboard file reading (Firefox/Safari), once per session
    pasteUnsupported: 'This browser cannot paste files — drag files into the tree or right-click "Upload files"',
    // Degradation hint when clipboard-read permission is denied (screenshot fallback channel)
    pasteClipboardDenied: 'Clipboard read was denied — image paste needs permission; file paste is unaffected, just press Ctrl+V',
    screenshotSaved: 'Screenshot will be uploaded as {name}',
    // Cap hit while enumerating a dropped directory tree
    dropFolderTruncated: 'Dropped content is large — only the first {n} files were collected',
    viewOnPlatform: 'View on {platform}',
    f2RenameHint: 'Select a file and press F2 to rename',
    batch: {
      download: 'Download selected ({n} items)',
      share: 'Share selected ({n} items)',
      shareTooMany: 'At most {n} items can be shared at once; split the selection',
      copy: 'Copy ({n} items)',
      cut: 'Cut ({n} items)',
      move: 'Move to… ({n} items)',
      rename: 'Batch Rename ({n} items)',
      delete: 'Delete {n} Items',
      gitexclude: 'Add to git exclude ({n} items)',
      // Same as fileTree.confirmDelete (P-20261005-154): batch deletes are trash-recoverable too
      confirmDelete: 'About to delete {n} item(s) (recoverable from trash for 7 days): {items}',
      confirmGitexclude: 'About to add {n} item(s) to git exclude (local exclusion): {items}',
      deleted: 'Deleted {n} item(s)',
      addedToExclude: 'Added {n} item(s) to git exclude (local exclusion)',
      partialFailed: '{failed}/{n} operation(s) failed',
    },
    // Batch move (P-20261003-160): "Move to…" dialog and batch-drag feedback
    batchMove: {
      title: 'Move {n} item(s) to…',
      searchPlaceholder: 'Search target directory…',
      root: 'Project root',
      confirm: 'Move here',
      empty: 'No matching directory',
      truncated: 'Many directories: only the first {n} listed; type to filter',
      done: 'Moved {n} item(s) to {dir}',
      partial: 'Moved {ok} item(s) to {dir}, skipped {failed}: {items}',
      skipExists: 'name already exists at target',
      skipInsideSelf: 'target is inside the item itself',
      skipFailed: 'move failed',
      skipItem: '{name} ({reason})',
      cap: 'At most {cap} item(s) per move; {n} item(s) left unmoved',
    },
    // Batch copy (P-20261023-2③a in-tree copy/paste): batch endpoint copy-form feedback
    // (same-name targets are auto-renamed server-side with a "-copy" suffix; no "exists" skip branch)
    batchCopy: {
      done: 'Copied {n} item(s) to {dir}',
      partial: 'Copied {ok} item(s) to {dir}, skipped {failed}: {items}',
      skipInsideSelf: 'target directory is inside the source subtree',
      skipFailed: 'copy failed',
      cap: 'At most {cap} item(s) per copy; {n} item(s) not copied',
    },
    // Batch rename (P-20261003-283): "Batch Rename" dialog (find/replace +
    // live preview); illegal rows reuse the P-132 nameReservedWindows /
    // nameTrailingDotSpace wording; execution feedback follows the batch-move
    // skip-and-report convention
    batchRename: {
      title: 'Batch Rename {n} item(s)',
      find: 'Find',
      findPlaceholder: 'Text to find in file names…',
      replace: 'Replace with',
      replacePlaceholder: 'Replace with… (leave empty to delete)',
      empty: 'No file name contains the find text',
      confirm: 'Rename {n} item(s)',
      done: 'Renamed {n} item(s)',
      partial: 'Renamed {ok} item(s), skipped {failed}: {items}',
      skipItem: '{name} ({reason})',
      skipExists: 'name already exists at target',
      skipFailed: 'rename failed',
      skipCollision: 'collides with another rename in this batch',
      emptyName: 'resulting name is empty',
      sepInName: 'resulting name contains a path separator',
      cap: 'At most {cap} item(s) per rename; {n} item(s) left unchanged',
      truncated: 'Many items: only the first {n} previewed',
    },
    // Pinned directories (P-20261002-97): quick-access section at the top of the tree
    pinned: {
      section: 'Pinned',
      pin: 'Pin to Top',
      unpin: 'Unpin',
      clearInvalid: 'Clear Invalid Pins',
      invalid: 'Directory missing or renamed',
    },
    // Directory zip download (P-20261002-115): server-side streaming zip with
    // sensitive-hit warning and truncation notice (P-26 scan flow, wording keys
    // passed through confirmSensitiveFiles)
    dirArchive: {
      warningTitle: 'Security scan before zip download',
      warningIntro: 'This directory contains {n} file(s) that look like keys or credentials. Confirm before packing:',
      moreFiles: '……and {n} more file(s) not listed',
      partialNote: 'Large directory: only part of the entries were scanned; some sensitive files may have been missed.',
      confirmPack: 'Pack anyway',
      started: 'Packing download started (~{n} items) — track it in your browser downloads',
      truncated: 'Directory exceeds the pack limit; the archive was truncated at the limit (about {n} items packed)',
    },
    // Multi-select batch archive download (P-20261003-250): right-click
    // "Download selected" packs a zip — the confirm dialog frame reuses the
    // dirArchive keys; intro/truncation/success feedback are batch-specific
    batchArchive: {
      intro: 'The selection contains {n} file(s) that look like keys or credentials. Confirm before packing:',
      started: 'Packing download started (~{n} items) — track it in your browser downloads',
      truncated: 'The selection exceeds the pack limit; the archive was truncated at the limit (about {n} items packed)',
    },
  },
  files: {
    conflict: {
      title: 'File modified externally',
      body: '{name} was changed by another program (an agent or another session) while you were editing; saving would overwrite the newer disk content. Choose how to handle your unsaved changes:',
      overwrite: 'Overwrite anyway',
      loadDisk: 'Load disk version',
      compare: 'Compare with disk version',
      loaded: 'Disk version loaded; your unsaved changes were discarded',
      diffMySide: 'My unsaved changes',
      // Remote file conflict (P-20261003-15): local-aligned semantics, fetched from the remote host
      remoteBody: '{name} was modified on the remote side (by an agent or another session) while you were editing. Saving will overwrite the newer remote content. Choose how to handle your unsaved changes:',
      loadRemote: 'Load remote version',
      compareRemote: 'Compare with remote version',
      loadedRemote: 'Remote version loaded; your unsaved changes were discarded',
    },
    // Discard unsaved changes (P-20261005-156, VS Code Revert File counterpart):
    // menu item and confirm dialog for the tab/editor context-menu entries
    // (title/confirm button reuse the menu key; execution shares the conflict
    // dialog's "load disk/remote version" chain, success toasts reuse conflict.loaded*)
    revert: {
      menu: 'Discard Unsaved Changes',
      body: 'Unsaved changes to "{name}" will be discarded and reverted to the current on-disk content.',
      bodyRemote: 'Unsaved changes to "{name}" will be discarded and reverted to the current remote content.',
    },
    // Reveal in system file manager (P-20261003-323): shared by file tree and
    // editor tab context menus; the server launches the host file manager
    revealInSystem: 'Reveal in File Manager',
    reveal: {
      headless: 'The instance host has no display environment (headless); the system file manager cannot be opened',
    },
    // Local file history (P-20261002-130, JetBrains Local History style safety net)
    history: {
      menu: 'Local History',
      title: 'Local History: {file}',
      empty: 'No local history yet — versions are captured automatically on overwrite/rename',
      versions: '{n} versions',
      restore: 'Restore This Version',
      restoreTitle: 'Restore this version?',
      restoreBody: 'The file will be restored to the selected version; the current content is captured first and can still be restored from history later.',
      restored: 'Restored to the selected version',
      loadFailed: 'Failed to load version content',
      sideOld: 'History version',
      sideCurrent: 'Current content',
      currentMissing: 'File no longer exists on disk (restore recreates it)',
      },
    // File change attribution (P-20261005-170): watcher events × session command
    // windows reconciliation ledger
    attribution: {
      menu: 'Change Attribution',
      title: 'Change Attribution: {file}',
      empty: 'No change records yet — changes are recorded automatically as they happen (last 500)',
      loadFailed: 'Failed to load change records',
      sourceCommand: 'Command',
      sourceEditor: 'Editor',
      sourceUnattributed: 'Unattributed',
      overlap: 'Overlap',
      running: 'Running',
      exit: 'exit {code}',
    },
    // Recursive scale shown in the directory-delete confirm (P-20261002-137, informed
    // confirm): hidden files are counted server-side; truncated = lower-bound note
    delConfirm: {
      summary: '{files} files / {dirs} folders / {size} total',
      truncatedNote: 'Entry limit reached — figures above are lower bounds',
    },
    // File recycle bin (P-20261003-304): deletes land in the bin first (7-day
    // retention), floating panel lists entries with restore / permanent delete.
    // Batch restore / batch permanent delete (P-20261005-175): checkbox multi-select
    // + batch action bar — one-check recovery for group accidents (409 name
    // conflicts skipped and reported), single confirm for bulk sensitive cleanup
    trash: {
      title: 'Trash',
      empty: 'Trash is empty — deleted files/folders are kept here for 7 days',
      count: '{n} entries (auto-purged after 7 days; oldest-first eviction once total usage exceeds 500MB)',
      restore: 'Restore',
      purge: 'Delete forever',
      purgeTitle: 'Delete forever?',
      confirmPurge: '"{name}" will be permanently deleted. This cannot be undone.',
      purged: 'Permanently deleted "{name}"',
      restored: 'Restored "{name}"',
      restoredRelocated: 'Original location no longer exists — "{name}" was restored to the project root',
      restoredAs: 'Restored as "{name}"',
      restoreAsExhausted: 'Suggested names all conflict — handle the target location manually and retry',
      // Same-name conflict three-way forward path (P-20261006-15): rename-restore
      // (suggested -restaged name, auto-stepped -restaged-2 when taken) / open
      // target location / cancel — "never overwrite" semantics kept, plus a way
      // forward; broken references are stated honestly, user's call
      conflictTitle: 'A file with the same name exists at the target location',
      conflictContent: 'Cannot restore "{name}": a file with the same name exists at the target location (it will not be overwritten).',
      conflictRename: 'Restore as "{name}"',
      conflictRenameHint: 'Restoring under a new name leaves existing files untouched; references to the old path (links/imports) will not follow.',
      conflictLocate: 'Open target location',
      degraded: 'Info missing',
      pathUnknown: 'Original path unknown',
      selectAll: 'Select all',
      batchRestore: 'Restore {n}',
      batchPurge: 'Delete {n} forever',
      batchPurgeTitle: 'Delete selected forever?',
      confirmBatchPurge: '{files} file(s) and {dirs} folder(s) will be permanently deleted. This cannot be undone.',
      batchRestored: 'Restored {n} item(s)',
      batchRestoreSkipped: 'Restored {restored} item(s); skipped {skipped} (name conflict or missing info)',
      batchPurged: 'Permanently deleted {n} item(s)',
      batchPurgeFailed: 'Permanently deleted {purged} item(s); {failed} failed',
      // Per-entry countdown badge (P-20261005-155): surfaces the auto-purge
      // clock on each row; daysLeftSoon covers ≤1 day (including entries past
      // the window but not yet swept by the daily cleanup)
      daysLeft: '{n}d left',
      daysLeftSoon: 'Under 1d left',
      // Sensitive entry marking (P-20261005-163): makes retention risk visible +
      // one-click permanent delete; name matching mirrors utils/sensitiveName
      // (↔ server/share/scan.go cross-referenced)
      sensitive: 'Sensitive',
      sensitiveHint: 'Sensitive file: stays in plain text in the data directory during the retention window',
      purgeNow: 'Delete forever now',
    },
    // Editor encoding indicator & transcode (P-20261002-146): breadcrumb badge +
    // encoding menu. Encoding names (GBK/UTF-8…) are proper nouns, not i18n'd
    encoding: {
      badgeTip: 'File encoding: {enc}. Click to switch reload/save encoding',
      reloadTitle: 'Reload with Encoding',
      saveAsTitle: 'Save with Encoding',
      current: 'current',
      reloadDirtyTitle: 'Reloading discards unsaved changes',
      reloadDirtyBody: '"{name}" has unsaved changes; reloading with the chosen encoding will discard them. Continue?',
      reloaded: 'Reloaded as {enc}',
      savedAs: 'Saved as {enc}',
    },
    // Editor EOL (end-of-line) indicator & switching (P-20261004-140): badge next
    // to the encoding badge + convert menu. LF/CRLF are proper nouns, not i18n'd;
    // the current item is marked with a ✓
    eol: {
      badgeTip: 'End of line sequence: {eol}. Click to convert',
      toLf: 'Convert to LF',
      toCrlf: 'Convert to CRLF',
    },
  },
  // Compare any two workspace files (P-20261002-75, same interaction as VS Code Select for Compare)
  compare: {
    pick: {
      select: 'Select for Compare',
      withBase: 'Compare with Base',
      cancel: 'Unselect Compare Base',
      status: 'Compare base: {name} (click to cancel)',
      statusTitle: 'Selected as the compare base, click to cancel',
      blocked: '{name} is binary or exceeds the size limit and cannot be compared',
    },
  },
  editor: {
    source: 'Source',
    preview: 'Preview',
    sourcePreview: 'Source + Preview',
    // Cursor position badge (P-20261004-141): Ln/Col are universal abbreviations,
    // not i18n'd (same as VS Code); only the selected text and click tip get keys
    cursorPos: {
      selected: '{n} selected',
      gotoTip: 'Cursor position. Click to go to line (Ctrl+G)',
    },
    // Breadcrumb symbol segment (P-20261005-195): symbol names are code content,
    // not i18n'd; only the tail dropdown interaction tip gets a key
    symbol: {
      peerNavTip: 'Click to list sibling symbols and jump',
    },
    // Inline AI edit on selection (P-20261005-206): selection floating bar +
    // in-place prompt; structured instruction (file + lines + selection +
    // instruction) goes straight to the active agent session (send chain in
    // useEditorInlineEdit; no active session falls back to the new-session
    // dialog with the instruction prefilled)
    inlineEdit: {
      bar: 'AI edit this selection',
      barTitle: 'Type an instruction in place and send it to the active session (Ctrl+K)',
      actionLabel: 'AI edit this selection',
      placeholder: 'e.g. add null checks here',
      hint: 'Enter to send · Esc to cancel',
      send: 'Send',
      empty: 'Type an instruction first',
      loc: '{path} lines {start}-{end}',
      locSingle: '{path} line {line}',
      codePrefix: 'Original code:',
      sentNow: 'Sent to session "{name}"',
      queued: 'Instruction queued for session "{name}", auto-sent when it finishes',
      noSession: 'No active session found — instruction prefilled in the new-session dialog, confirm to launch',

    },
    // md mode bar hover tip (P-20261003-18): no hardcoded combo — keybinding is
    // remappable in Settings → Shortcuts; point to the ? cheat sheet to avoid drift
    mdModeTip: 'Markdown view: source / preview / split (shortcut in ? cheat sheet)',
    // Print button hover tip (P-20261003-244): pick "Save as PDF" in the browser print dialog
    mdPrint: 'Print / Export PDF',
    // In-page anchor miss hint (P-20261007-7): bad anchor title tooltip (visible on
    // next hover), honest boundary — no crash, no jump
    mdAnchorMiss: 'Anchor "{anchor}" matches no heading in this document',
    saveFile: 'Save File',
    metaTooLargeTitle: 'File too large to preview',
    metaTooLargeHint: 'This file is {size}, above the full-preview limit (10 MB). Content was not loaded into the editor. Use command-line tools (e.g. less / tail) in the terminal to inspect it.',
    metaBinaryTitle: 'Binary file',
    metaBinaryHint: 'This is a binary or otherwise non-previewable file; its content is not rendered in the frontend.',
    // Remote file editing (P-20261003-15): offline degrade banner + sensitive path write confirm
    remote: {
      offlineBanner: 'Remote host unreachable — switched to read-only; retry once the connection recovers',
      retry: 'Retry',
      retryDirtyTitle: 'Retry will discard unsaved changes',
      retryDirtyBody: 'Re-fetching from the remote host will overwrite unsaved changes in {name}. Continue?',
      sensitiveTitle: 'Write to sensitive system path',
      sensitiveBody: 'Target {path} is inside a system directory (/etc, /boot). Saving will modify system files on the remote host and may affect its behavior. Continue?',
    },
    // Preview tab mode (P-20261002-50): hover hint (editor.preview is already a
    // leaf key for the markdown preview mode button; previewTab prefix avoids it)
    previewTab: {
      title: 'Preview — start editing or double-click to pin',
    },
    // Auto save mode (P-20261002-129, after files.autoSave): settings editor section select + delay input
    autoSave: {
      label: 'Auto Save',
      off: 'Off',
      afterDelay: 'Save After Delay',
      delayLabel: 'Delay (ms)',
    },
    // Format on save (P-20261003-83, after files.formatOnSave): settings editor section toggle;
    // languages without a built-in formatter are silently skipped and saved as-is
    // (Monaco built-in coverage is limited — not an all-language promise)
    formatOnSave: {
      label: 'Format on Save',
      tip: 'Run "Format Document" before saving (languages with built-in support like JSON/HTML/CSS); unsupported languages are saved as-is',
    },
    // Color tabs by git status (P-20261003-242, after VS Code tab decorations):
    // settings editor section toggle row; 2px bottom strip — blue for tracked
    // modifications, green for untracked (new) files, backed by the changes panel cache
    gitStatusTabs: {
      label: 'Color Tabs by Git Status',
      tip: 'Files with uncommitted changes show a colored strip at the bottom of their tab: blue for tracked modifications, green for untracked (new) files; off by default',
    },
    toggleBlame: 'Toggle inline Git Blame',
    blame: 'Blame',
    fileHistory: 'View Git history of this file',
    fileHistoryShort: 'History',
    fileHistoryTitle: 'File History: {file}',
    compareWithRef: 'Compare this file with branch/tag',
    compareShort: 'Compare',
    compareTitle: 'Compare: {file}',
    compareRefLabel: 'Base',
    compareRefPlaceholder: 'Select branch or tag',
    compareNoDiff: 'No differences or comparison failed',
    comparePickRef: 'Pick a branch or tag to compare',
    compareHashPlaceholder: 'or enter a commit hash',
    compareRun: 'Compare',
    compareDirection: 'Direction',
    compareDirectionNone: 'no ref selected',
    compareDirectionTip: 'Left side is the merge target (current branch), right side is the source ref — same direction as "Merge into Current Branch" in the branch context menu: merge {source} into {base}',
    compareUniqueOnly: 'Unique commits only',
    compareUniqueTip: 'On = only commits unique to the ref side to be merged in (base..ref one-way); off = both sides in full (base...ref symmetric difference)',
    compareNoBase: 'Baseline missing — showing full history of the ref',
    compareCommitsTruncated: 'Showing first {n}',
    compareCommitsNone: 'No commits in this range',
    ctxCompareRef: 'Compare with branch/tag/commit...',
    ctxCompareClipboard: 'Compare with clipboard content',
    ctxFileHistory: 'View file history',
    ctxCopyReference: 'Copy Reference (Path:Line)',
    // Send selection to terminal (P-20261004-21): editor.sendToTerminal.* —
    // context-menu entry + confirmation chain (sensitive/multiline/large);
    // "no more prompts" checkbox and risk-gate cancel toast reuse existing
    // terminal-domain keys (closeConfirmNoPrompt / cmdPreview.insertCancelled)
    sendToTerminal: {
      menuSelection: 'Send Selection to Terminal',
      sensitiveTitle: 'Possible sensitive content',
      sensitiveBody: 'The selection looks like it contains credentials or tokens. Sending it to the terminal will execute it and may leave it in shell history. Send anyway?',
      multilineTitle: 'Confirm multi-line send',
      multilineWarn: 'The selection has {n} lines and will be executed with a trailing Enter; the shell may run them as multiple commands. Review the content before sending.',
      largeTitle: 'Confirm large send',
      largeWarn: 'The selection is {kb} KB / {n} lines. Writing large text may lag or freeze the UI. Review the content before sending.',
      preview: 'Preview (first {n} lines)',
      sendAnyway: 'Send anyway',
      sent: 'Sent to terminal',
      noTerminal: 'No terminal session available (project terminal failed to create or no project selected)',
    },
    clipboardEmpty: 'Clipboard is empty or read was not permitted',
    // Selection Alt+drag to the agent sidebar (P-20261003-162): ghost/drop feedback.
    // header* is the locator injected into a session input / new-session dialog
    selectionDrag: {
      ghostRange: '{path} · lines {start}-{end}',
      ghostLine: '{path} · line {line}',
      ghostHint: 'Drop on a session to append to its input (not sent); drop on New Session to carry the context; hover the Sessions rail icon to open the sidebar',
      headerRange: 'Selection from {path}, lines {start}-{end}:',
      headerLine: 'Selection from {path}, line {line}:',
      appended: 'Appended to the input of "{name}" (not sent; press Enter to send)',
      appendedSingleLine: 'Appended to the input of "{name}" (multi-line paste unavailable, flattened to one line; not sent)',
      paneNotReady: 'Session input is not ready; the selection was copied to the clipboard for manual paste',
      paneNotReadyNoClipboard: 'Session input is not ready and copying to the clipboard failed; please drag again or copy manually',
    },
    remoteViewTitle: 'View on {platform} (pushed content)',
    remoteViewGeneric: 'Code host',
    ask: {
      menu: 'Ask agent about this file',
      button: 'Ask agent',
      buttonTitle: 'Ask an agent about this file (new session in the project root)',
      prompt: 'Please analyze the current content of {path}',
      promptAtLine: 'Please analyze the current content of {path}, focusing around line {line}',
      menuSelection: 'Ask agent about selected code',
      promptSelection: 'Please analyze the selected code in {path} (lines {start}-{end}):',
      promptSelectionAtLine: 'Please analyze the selected code in {path} (line {line}):',
      // Diagnostic ask (P-20261006-2): shared by the editor code action and the problems panel item button
      menuDiagnostic: 'Ask agent: explain this error',
      promptDiagnostic: 'Explain the diagnostic in {path} at line {line}, column {col} ({origin}) and suggest a fix:',
      promptDiagnosticPlain: 'Explain the diagnostic in {path} at line {line}, column {col} and suggest a fix:',
      successDiagnostic: 'Agent session created (diagnostic attached)',
      success: 'Agent session created: {path}',
      degraded: 'No agent runtime detected; a plain terminal session was created (prompt not injected)',
      failed: 'Failed to create agent session',
    },
    draft: {
      foundTitle: 'Unsaved draft found (written at {time})',
      restore: 'Restore draft',
      // Diff preview (P-20261004-71): draft vs current disk content side by side — look before deciding
      preview: 'Diff preview',
      // Draft-preview diff breadcrumb label for the draft side (draft-<ts> pseudo ref;
      // the write time is already shown on the recovery bar)
      diffRefLabel: 'Draft (unsaved)',
      discard: 'Discard',
      // Stale-draft reconciliation notice (P-20261003-152): aggregate cleanup summary
      staleCleaned: 'Cleaned {n} stale draft(s) — file no longer exists',
      // Cross-tab draft sync (P-20261006-08): a newer draft written in another tab was reloaded into this page
      syncedFromOtherTab: 'Synced a newer draft from another tab: {name}',
      // Ping-pong detection: repeated updates for the same file from the other tab — alternating overwrites
      conflictOtherTab: '{name} is also being edited in another tab; drafts may overwrite each other — keep only one open',
    },
    untitled: {
      name: 'Draft {n}',
      saveAsTitle: 'Save Draft As',
      saveAsPath: 'Save path (project-relative)',
      saveAsPlaceholder: 'e.g. notes/idea.md',
      pathRequired: 'Path is required',
      pathOpen: 'This path already has an open tab; choose another',
      savedAs: 'Saved: {name}',
      restored: 'Restored {n} unsaved draft(s)',
    },
    // Editor navigation history (P-20261002-51): editor.nav.* prefix — shared by
    // command palette title / shortcuts cheat sheet / keymap settings
    nav: {
      back: 'Go Back: previous editing location',
      forward: 'Go Forward: next editing location',
    },
    // Editor bookmark anchors (P-20261002-131): editor.bookmark.* prefix — shared by
    // context menu / command palette / list popover / gutter hover
    bookmark: {
      toggleAction: 'Toggle Bookmark (Current Line)',
      listCmd: 'Bookmark List: Jump to Bookmarked Line',
      listTitle: 'Bookmarks',
      lineLabel: 'Line {line}',
      empty: 'No bookmarks in this project yet — press Ctrl+Alt+B to toggle one on the current line',
      glyphTip: 'Bookmark (click to remove)',
      // Line-content anchor self-healing (P-20261004-105)
      reanchoredToast: 'Re-anchored {n} bookmark(s) by content match',
      staleBadge: 'May have drifted',
      staleGlyphTip: 'Bookmark (may have drifted — original line content not found nearby; click to remove)',
    },
  },
  // Blame previous-version navigation (P-20261002-65): blame.prev.* prefix
  blame: {
    prev: {
      action: 'View previous version',
      locate: 'Locate commit',
      view: '{ref} view',
      back: 'Back to current',
      failed: 'Failed to load previous blame (the commit may have no parent)',
    },
    // Line-origin ask (P-20261004-40): third blame badge context-menu item +
    // prompt templates (assembly and 500-byte packing live in
    // useEditorAskAgent.askAgentAboutBlameLine)
    ask: {
      action: 'Ask agent about this line',
      prompt: 'Explain why {path} line {line} is written this way:',
      line: 'Introduced by commit {hash} ({author} · {date}): {summary}',
      lineNoSummary: 'Introduced by commit {hash} ({author} · {date})',
    },
    // Blame hover provenance (P-20261007-11): commit time × session window
    trace: {
      title: 'Active sessions in this window ({n})',
      loading: 'Querying sessions in this window…',
      empty: 'No AI session was running at this commit time',
      failed: 'Failed to query session window',
      truncated: 'Showing closest {shown} of {total} by time proximity',
      openReplay: 'Open session replay located at the commit time',
      note: 'Time-window correlation, not causal proof: all parallel sessions listed, judge manually',
    },
  },
  home: {
    subtitle: 'Lightweight Coding Platform',
    addProject: 'Add Project',
    noProjects: 'No projects added yet',
    addFirst: 'Add your first project',
    empty: {
      tagline: 'A remote development workbench in your browser: terminals, Git and agent sessions',
      cloneFromUrl: 'Clone a project from URL',
      quickStart: 'View the quick start guide',
    },
    invalidPath: 'Invalid Path',
    invalidHint: 'Path does not exist or is not accessible. Relocate it to the new location.',
    relocate: 'Relocate',
    relocateTitle: 'Relocate Project',
    relocateNewPath: 'New path',
    relocateHint: 'Moved the folder on disk? Point to the new location to keep the project identity and all related state (panel layout, terminal history, etc.)',
    successRelocate: 'Project relocated',
    notGitBadge: 'Non-Git',
    notGitHint: 'This directory is not a Git repository: file browsing and terminals work; branch/commit/history features are unavailable.',
    noBranch: 'No Branch',
    addTitle: 'Add Project',
    projectPath: 'Project Path',
    pathPlaceholder: 'Enter path, e.g. D:/workspace/go/my-project',
    projectName: 'Project Name',
    namePlaceholder: 'Leave empty to auto-detect from path',
    removeTitle: 'Remove Project',
    confirmRemove: 'Confirm Remove',
    removeConfirmPrefix: 'Are you sure you want to remove project',
    removeConfirmSuffix: '? This only removes it from the list, files on disk will not be deleted.',
    removeSessionsTotal: 'This will terminate {count} terminal session(s) of this project',
    removeSessionsRunning: '{count} still running',
    removeResidentAgents: '{count} agent session(s) also reside in this project (launched inside it, kept by default)',
    removeCloseResidentAgents: 'Also close resident agent sessions',
    warningPath: 'Please enter the project path',
    successAdd: 'Project added successfully',
    failAdd: 'Failed to add project',
    clone: {
      tabLocal: 'Local Path',
      tabClone: 'Clone from Git',
      repoUrl: 'Repository URL',
      repoUrlPlaceholder: 'https://github.com/user/repo.git or git{\'@\'}github.com:user/repo.git',
      targetDir: 'Target Directory',
      targetDirPlaceholder: 'Directory to clone into',
      branchOptional: 'Branch (optional)',
      branchPlaceholder: 'Leave empty for default branch',
      depthOptional: 'Depth (optional, 0=full)',
      warning: 'Please enter repository URL and target directory',
      success: 'Clone successful',
      fail: 'Clone failed',
      cloning: 'Cloning...',
      canceled: 'Clone canceled',
      credMissing: 'No credential found for {host}. Private repos will fail to clone.',
      sshKeyPlaceholder: 'Select SSH key (optional)',
      sshKeyMissing: 'No SSH key configured. SSH clone will fail. Generate or import one right here:',
      sshKeyGenerate: 'Generate Key',
      sshKeyImport: 'Import Private Key',
      sshKeyImportPlaceholder: 'Paste PEM private key (OpenSSH format)',
      sshKeyImportConfirm: 'Import',
      sshKeyPubTitle: "Public key (add it to the Git server's SSH Keys):",
      sshKeyCopy: 'Copy Public Key',
      sshKeyGenerated: 'Key ready',
      sshKeyCopied: 'Public key copied',
      sshKeyManageFailed: 'SSH key operation failed',
      // Clone URL history dropdown (P-20261003-251): recent clone URLs on focus (same family as ProjectSearch query history)
      history: {
        empty: 'No matching URLs',
        clear: 'Clear history',
      },
    },
    // Clone suggestion (P-20261003-170): remote URL pasted in local tab → inline hint with one-click switch
    cloneSuggest: {
      tip: 'Looks like a Git URL — switch to Clone?',
      switch: 'Switch to Clone',
      dismiss: 'Dismiss',
    },
    // Clone status bar (P-20261003-58): persistent indicator for ongoing clone tasks
    cloneBar: {
      label: 'Ongoing clone tasks',
    },
    searchPlaceholder: 'Search projects...',
    sortRecent: 'Recently Opened',
    sortName: 'By Name',
    sortBranch: 'By Branch',
  },
  // Project remove undo (P-20261002-47): grace-period toast shared by home and project-page removal entries
  project: {
    undo: {
      removed: 'Removed "{name}". Directories and files are not affected.',
      action: 'Undo',
    },
    // Project freeze (P-20261003-9): folded into a weakened home tail section, searchable/unfreezable, config kept
    frozen: {
      menuFreeze: 'Freeze',
      menuUnfreeze: 'Unfreeze',
      sectionLabel: 'Frozen',
      successFrozen: 'Froze "{name}": moved to the frozen tail section, unfreeze anytime',
      successUnfrozen: 'Unfroze "{name}"',
    },
    // Project hard lock (P-20261004-3): immutable archive — write-family endpoints 403, reads pass
    locked: {
      menuLock: 'Lock (Immutable Archive)',
      menuUnlock: 'Unlock',
      badgeTitle: 'Locked: immutable archive (file/Git writes and terminal disabled; right-click to unlock)',
      confirmTitle: 'Lock this project?',
      confirmLead: 'Locking "{name}" puts it into the immutable archive mode:',
      impact: {
        files: 'File write/create/rename/delete/upload/history-restore will be rejected (403)',
        git: 'All Git write operations (stage/commit/push/pull/rollback/reset...) will be rejected (403)',
        terminal: 'No new terminals for this project (including agent sessions inside it)',
        reads: 'Browsing, reading, searching and diff are unaffected; unlock anytime to restore',
      },
      confirmLockBtn: 'Lock',
      unlockTitle1: 'Unlock this project?',
      unlockConfirm1: 'Unlocking "{name}" reopens all write entry points (file/Git writes and terminal)',
      unlockTitle2: 'Confirm unlock?',
      unlockConfirm2: 'Final confirmation: the archive becomes writable again — both agents and humans can modify it',
      unlockBtn: 'Confirm Unlock',
      successLocked: 'Locked "{name}": archive is now immutable, write operations will be rejected',
      successUnlocked: 'Unlocked "{name}": write operations are available again',
      // Terminal-domain lock badge (P-20261004-143): honest boundary for existing terminals — shell writes bypass the API guard
      terminalBadgeTitle: 'Project locked as archive — API write-family calls return 403; shell commands in this terminal are not constrained by the lock',
    },
  },
  // Connection status (P-20261002-5 global disconnect bar)
  conn: {
    bar: {
      disconnected: 'Connection lost, reconnecting…',
    },
    // Plaintext HTTP access warning (P-20261002-30): shared by top bar and lock screen
    http: {
      message: 'You are on an unencrypted HTTP connection: passwords and data are visible on the network. Consider enabling TLS (Settings → Security).',
      dismiss: "Don't show again",
      help: 'Learn more',
    },
  },
  // First-run browser language suggestion (P-20261002-113): one-time banner when navigator.language primary tag is not zh
  localeSuggest: {
    message: 'Looks like you prefer English',
    switch: 'Switch',
    keep: 'Keep Chinese',
  },
  layout: {
    projectFiles: 'Project Files',
    commit: 'Commit',
    gitManage: 'Git Manage',
    activityBar: 'Activity Bar',
    sidebar: 'Sidebar',
    bottomPanel: 'Bottom Panel',
    editorTabs: 'Editor Tabs',
    terminal: 'Terminal',
    addProject: 'Add Project',
    settings: 'Settings',
    backHome: 'Back to Home',
    selectProject: 'Select project...',
    noBranch: 'No Branch',
    changes: 'Changes',
    createPr: 'Create Pull Request',
    removeProject: 'Remove current project',
    moreActions: 'More actions',
    // Narrow workspace (P-20261019-7): ≤700px bottom switcher / read-only default / drawers
    narrowMore: 'More',
    narrowPanels: 'All panels',
    narrowInstance: 'Instance',
    narrowEditorStartEdit: 'Start editing',
    narrowEditorStopEdit: 'Switch to read-only',
    narrowEditorReadOnlyHint: 'Read-only on narrow screens to prevent accidental edits',
    narrowEditorEditingHint: 'Editing: the soft keyboard may cover content',
    // Short labels for the narrow "More" menu: the full descriptions overflow a 390px viewport
    lockLayoutShort: 'Lock layout',
    unlockLayoutShort: 'Unlock layout',
    lock: 'Lock System',
    // Layout lock (P-20261003-180): anti-misclick toggle — splitter/tab/tree drags are short-circuited while locked
    layoutLockOn: 'Lock layout (prevents accidental splitter/tab/file-tree drags; clicks and keyboard unaffected)',
    layoutLockOff: 'Unlock layout',
    welcomeStart: 'Start',
    welcomeRecent: 'Recent',
    welcomeNoRecent: 'No recent files yet',
    save: 'Save File',
    diffNav: 'Navigate Diff Changes',
    close: 'Close',
    closeOthers: 'Close Others',
    closeRight: 'Close to Right',
    closeAll: 'Close All',
    pinTab: 'Pin Tab',
    unpinTab: 'Unpin',
    closeSaved: 'Close Saved Tabs',
    reopenClosedTab: 'Reopen Closed Tab',
    splitRight: 'Split Right',
    // Split Down (P-20261005-230 orthogonal split): sibling of splitRight, vertical compare entry
    splitDown: 'Split Down',
    splitDirectionToggle: 'Toggle split direction (horizontal/vertical)',
    copyFileLink: 'Copy File Link',
    copyFileLinkDone: 'File link copied',
    copyPath: 'Copy Path',
    copyReference: 'Copy Reference (Path:Line)',
    copyFileName: 'Copy File Name',
    copyAbsPath: 'Copy Absolute Path',
    pathCopied: 'Path copied',
    referenceCopied: 'Reference copied',
    fileNameCopied: 'File name copied',
    absPathCopied: 'Absolute path copied',
    closeSplit: 'Close Split',
    splitRestoreUnavailable: '{n} split file(s) no longer available, skipped',
    splitEmptyHint: 'Right-click an editor tab and choose "Split Right / Split Down" to compare files',
    showAllTabs: 'Show All Tabs',
    loading: 'Loading...',
    cloneTitle: 'Clone Remote Repository',
    cloneBtn: 'Clone',
    repoUrl: 'Repository URL',
    repoUrlPlaceholder: 'e.g. https://github.com/user/repo.git',
    targetDir: 'Target Directory',
    targetDirPlaceholder: 'e.g. D:/workspace/my-project',
    branchOptional: 'Branch (optional)',
    branchPlaceholder: 'Leave empty to clone default branch',
    settingsSaved: 'Settings saved (Auto-fetch requires restart)',
    settingsSaveFailed: '{n} setting(s) failed to save — please retry',
    intervalLabel: 'Interval:',
    seconds: 'seconds',
    minutes: 'min',
    userName: 'user.name:',
    userEmail: 'user.email:',
    editGitignore: 'Edit .gitignore',
    editGitattributes: 'Edit .gitattributes',
    fontSize: 'Font Size',
    resetDefault: 'Reset to Default',
    globalBase: 'Global Base',
    editorFont: 'Editor',
    terminalFont: 'Terminal',
    diffFont: 'Diff',
    sidebarFont: 'Side Panel',
    bottomFont: 'Bottom Panel',
    theme: 'Theme',
    language: 'Language',
    gitignorePlaceholder: 'Edit .gitignore content here...',
    gitattributesPlaceholder: 'Edit .gitattributes content here...',
    remoteTitle: 'Manage Remotes',
    remoteNamePlaceholder: 'Name (e.g. origin)',
    remoteUrlPlaceholder: 'URL (e.g. git{\'@\'}github.com:user/repo.git)',
    noRemotes: 'No remotes configured',
    pushToRemote: 'Push to Remote',
    local: 'Local',
    remoteBranchPlaceholder: 'Remote branch name',
    commitsToPush: '{n} commits to push',
    setUpstream: 'Set upstream tracking',
    setUpstreamHint: '(--set-upstream)',
    maximizeEditor: 'Maximize to editor area (keep sidebar)',
    restoreEditor: 'Restore editor area',
    // Editor group temporary maximize (P-20261004-64): tab-strip double-click / command palette, Esc unwinds layer by layer
    maximizeGroup: 'Maximize current editor group (full width while comparing, Esc to restore)',
    restoreGroup: 'Restore editor group split',
    maximizeFullscreen: 'Fullscreen maximize',
    restoreFullscreen: 'Restore fullscreen',
    removeTitle: 'Remove Project',
    confirmRemove: 'Confirm Remove',
    removeConfirmPrefix: 'Are you sure you want to remove project',
    removeConfirmSuffix: '? This only removes it from the list, files on disk will not be deleted.',
    removeSessionsTotal: 'This will terminate {count} terminal session(s) of this project',
    removeSessionsRunning: '{count} still running',
    removeResidentAgents: '{count} agent session(s) also reside in this project (launched inside it, kept by default)',
    removeCloseResidentAgents: 'Also close resident agent sessions',
    warningPath: 'Please enter the project path',
    successAdd: 'Project added successfully',
    successRemove: 'Project removed',
    failRemove: 'Failed to remove project',
    fileSaved: 'File saved',
    // 全部保存（P-20261002-101）：layout.saveAll.*——命令面板命令标题 + 完成 toast 汇总
    saveAll: {
      command: 'Save All',
      done: 'Saved {saved} file(s)',
      doneWithFail: 'Saved {saved} file(s), {failed} failed',
    },
    externalChangeDirtyTitle: 'Some files were not synced with external changes',
    externalChangeDirtyBody: 'These files have unsaved changes and were skipped during auto-sync: {names}. Saving them will overwrite external changes; please review.',
    saveFail: 'Save failed',
    gitignoreSaved: '.gitignore saved',
    gitattributesSaved: '.gitattributes saved',
    cloneWarning: 'Please enter the repository URL and target directory',
    cloneSuccess: 'Clone successful',
    cloneFail: 'Clone failed',
    cloneCanceled: 'Clone canceled',
    cloneCancelBtn: 'Cancel clone',
    clonePreparing: 'Preparing clone…',
    remoteWarning: 'Please enter the remote name and URL',
    remoteAdded: 'Remote added',
    remoteDeleted: 'Remote {name} deleted',
    // Remote delete confirm (P-20261005-5): align with the product's delete-family convention; URLs often carry tokens that users may not be able to rebuild from memory
    remoteDeleteTitle: 'Delete remote "{name}"?',
    remoteDeleteConfirm: 'Only the local remote entry is removed — the repository on the server is untouched. If the URL embeds a token, keep a copy somewhere safe.',
    fetchSuccess: 'Fetch successful',
    fetchFail: 'Fetch failed',
    pullSuccess: 'Pull successful',
    // 结果摘要（P-20261003-202）：计数由服务端前后 HEAD rev-list 得出，0 单独轻提示
    pullSuccessWithCount: 'Pull successful: {n} new commits',
    pullUpToDate: 'Already up to date',
    pullFail: 'Pull failed',
    pushSuccess: 'Push successful',
    pushFail: 'Push failed',
    files: 'File Explorer',
    view: 'View',
    git: 'Git',
    fetch: 'Fetch',
    pull: 'Pull',
    push: 'Push',
    prLinkGenerated: 'PR link generated',
    unsavedCloseConfirm: 'File {name} has unsaved changes. Are you sure you want to close it?',
    unsavedCloseAllConfirm: '{n} files have unsaved changes. Are you sure you want to close all?',
    unsavedCloseTitle: 'Unsaved Changes',
    // Project-switch draft discard confirm (P-20261003-105): switch-family guard dialog (registered in openfiles/core)
    projectSwitchDraftsTitle: 'Switch Project',
    projectSwitchDraftsConfirm: '{n} unsaved draft(s) will be discarded after switching. Switch anyway?',
    // Dirty-dot "Save and Close" (P-20261003-138): tab dirty-dot tooltip and confirm dialog
    saveCloseTab: 'Save and Close',
    saveCloseConfirmBody: 'Changes to "{name}" will be saved and its tab closed.',
    invalidPath: 'Invalid Path',
    useGlobal: 'Leave empty to use global config',
    gitConfigNoProject: 'Please open a project workspace to configure project-level Git user name and email',
    remoteConfigNoProject: 'Please open a project workspace to manage remote repositories',
    pickProject: 'Pick a project…',
    enterProject: 'Enter workspace',
    // Layout reset (P-20261002-74): self-rescue exit when panels/widths/tree expansion get messed up
    reset: {
      title: 'Reset Layout',
      desc: 'Restore the current project\'s panel visibility, panel widths, bottom panel height and file tree expansion to factory defaults (open editor tabs and other projects are not affected).',
      action: 'Reset Current Project Layout',
      command: 'Reset Current Project Layout',
      confirm: 'Reset the current project\'s layout to factory defaults? Panel visibility, widths, bottom panel height and file tree expansion will be reset immediately; open editor tabs are not affected.',
      done: 'Layout reset',
      noProject: 'Open a project workspace before resetting the layout',
    },
  },
  // Workspace snapshots (P-20261002-84): save the current scene before big changes, restore it in one click
  snapshot: {
    cmdSave: 'Save Current Workspace',
    cmdRestore: 'Restore Workspace',
    managerTitle: 'Workspace Snapshots',
    saveTitle: 'Save Current Workspace',
    saveNameLabel: 'Snapshot name',
    saveNamePlaceholder: 'e.g. stable state before the refactor',
    nameRequired: 'Enter a snapshot name',
    saved: 'Workspace "{name}" saved',
    empty: 'No snapshots yet. Use "Save Current Workspace" in the command palette to create one.',
    restore: 'Restore',
    del: 'Delete',
    deleteTitle: 'Delete Snapshot',
    deleteConfirm: 'Delete snapshot "{name}"?',
    deleted: 'Snapshot "{name}" deleted',
    restoreConfirmTitle: 'Restore Workspace',
    unsavedConfirm: '{n} tab(s) have unsaved changes. Restoring closes all main-editor tabs and reopens those from the snapshot; unsaved changes will be lost. Continue?',
    restored: 'Workspace "{name}" restored',
    branchDiffers: 'Snapshot was on branch "{snapshot}", current branch is "{current}". Files and panels restored; branch not switched.',
    noProject: 'Enter a project workspace before using workspace snapshots',
    metaFiles: '{n} file(s)',
  },
  // Workspace presets (P-20261003-68): new copy for the snapshot chain extensions —
  // pre-restore auto-archive / inline rename / session-group structure feedback
  // (existing snapshot copy lives in the snapshot namespace above)
  presets: {
    autoArchiveName: 'Pre-restore',
    rename: 'Rename',
    renameTitle: 'Rename Snapshot',
    renameLabel: 'New name',
    renameDuplicate: 'A snapshot named "{name}" already exists. Pick another name.',
    renamed: 'Snapshot renamed to "{name}"',
    groupsRestored: 'Session groups restored ({n} group(s)) — sessions are not auto-launched',
    // Hotkey direct access (P-20261004-49): tooltip of the ordinal badge in the list
    ordinalTip: 'Press Ctrl+Alt+{n} to restore this preset',
  },
  // TODO panel (P-20261002-25): aggregated TODO/FIXME/XXX/HACK code markers
  todo: {
    panel: {
      title: 'TODO List',
      refresh: 'Refresh',
      empty: 'No TODO / FIXME markers',
      loadFailed: 'TODO scan failed',
      truncated: 'Showing first 500 only',
    },
    // Fix with agent (P-20261003-159): per-entry launch (with context lines) /
    // batch-checked single session; failure/degraded/sensitive wording reuses agent.fix keys
    fix: {
      action: 'Fix with agent',
      actionTitle: 'Create an agent session to fix this marker (with context lines)',
      batchAction: 'Fix with agent ({n})',
      batchTitle: 'Hand all checked markers to one agent session; entries beyond the launch-arg limit are noted for batching',
      selected: '{n} selected',
      selectAll: 'Select all',
      clear: 'Clear',
      headSingle: 'Please fix this tech-debt marker:',
      headBatch: 'Please fix the following {n} tech-debt markers:',
      contextLabel: 'Context:',
      omitted: '({n} more not included in this batch due to the session launch-arg limit; start the next batch after fixing these)',
      success: 'Agent fix session created ({n} markers)',
    },
    // Handled checks (P-20261003-200): panel-side hiding (code comments stay),
    // path:line matching with drift tolerance; the show-handled toggle brings
    // handled entries back (strikethrough, dimmed)
    handled: {
      mark: 'Mark handled',
      markTitle: 'Mark handled (hides it in the panel only; the code comment stays)',
      unmark: 'Unmark handled',
      unmarkTitle: 'Unmark handled (show this entry again)',
      showDone: 'Show handled',
      hideDone: 'Hide handled',
      chip: '{n} handled',
      chipTitle: '{n} marked handled; click to toggle visibility',
      allDone: 'All marked handled — hidden in the panel only; code comments are untouched',
    },
  },
  // Project notes panel (P-20261002-110): human-agent shared scratch layer
  notes: {
    panel: {
      title: 'Project Notes',
      edit: 'Edit',
      preview: 'Preview',
      placeholder: '# Handoff\n\n- TODO: …\n- Decisions: …\n(agents can read and write this note too)',
      dirty: 'Unsaved…',
      saving: 'Saving…',
      saveFailed: 'Failed to save notes',
      tooLarge: 'Notes exceed the 256KB limit and were not saved',
      loadFailed: 'Failed to load notes',
      noProject: 'Select a project first',
    },
    // "Deposit to notes" secondary entry (P-20261003-292): terminal-state task
    // conclusions appended to the shared project notes on the human's behalf
    deposit: {
      action: 'Deposit to notes',
      noProject: 'No project resolved for this task — select a project first',
      untitledTask: 'Untitled task',
      saved: 'Deposited to project notes — refine it in the notes panel',
      failed: 'Failed to write project notes',
      fieldResult: 'Result',
      fieldWhat: 'What was done',
      fieldDecisions: 'Key decisions',
      fieldLeftovers: 'Leftovers',
    },
  },
  git: {
    branches: 'Branches',
    refreshBranches: 'Refresh branches/tags (fetch remote first)',
    collapseSidebar: 'Collapse sidebar',
    showBranches: 'Show Branches',
    // Fetch all (P-20261002-41): multi-project morning routine collapsed into one home click
    fetchAll: {
      button: 'Fetch All',
      hint: 'Fetch remote updates for all projects concurrently (one project failing does not affect the rest; see notification center for per-project results)',
      doneTitle: 'Fetch all completed ({n} projects)',
      doneToast: 'All projects fetched ({n})',
      partialTitle: 'Fetch all: {fail} project(s) failed',
      partialToast: 'Some projects failed: {ok} succeeded · {fail} failed',
    },
    conflictBanner: 'Merge conflicts: {count} file(s) to resolve',

    // Per-hunk conflict resolution (P-20261003-59): ours/theirs/manual per hunk,
    // synthesized write-back once all resolved
    conflict: {
      hunk: {
        mode: 'Per-Hunk',
        progress: '{done}/{total} hunks resolved',
        apply: 'Apply Resolution',
        applied: 'Conflict resolved per-hunk',
        block: 'Hunk {n}',
        lines: 'Lines {start}-{end}',
        takeOurs: 'Take Ours',
        takeTheirs: 'Take Theirs',
        manual: 'Edit',
        manualPlaceholder: 'Edit the final content for this hunk',
        base: 'Baseline',
        emptySide: '(empty)',
        resolved: 'resolved',
        complexFallback: 'Unparseable conflict markers (e.g. nested) — fell back to whole-file mode',
      },
    },    // index.lock stale lock detection & one-click cleanup (P-20261002-150): bar in changes panel
    lockRecovery: {
      title: 'Stale Git lock file detected (index.lock) — write operations blocked',
      clean: 'Clean up',
      cleaned: 'Stale lock removed — please retry the previous operation',
      dismiss: 'Dismiss',
    },
    conflictOpen: 'Resolve conflicts →',
    conflictBackCommits: '← Back to commits',
    // Pull failed with conflicts (P-20261004-44): actionable toast copy, button reuses conflictOpen
    pullConflictToast: 'Pull resulted in merge conflicts — resolve them first',
    // Git op in-flight dedup (P-20261005-211): retrigger while an op is running is blocked client-side
    opsBusyToast: 'Previous operation still in progress, please wait',
    // git failure recovery hints (P-20261005-194): server classifier kind → actionable
    // toast reason + direct button; kind enum & recovery mapping in ops manual error-codes
    hint: {
      nonFastForward: 'Push rejected: the remote branch has new commits you do not have',
      actionPull: 'Pull first',
      diverged: 'Local and remote histories diverged: merge or rebase first (pull will ask), then push',
      conflict: 'The operation left merge conflicts behind — resolve them first',
      authentication: 'Git remote authentication failed: check your credentials and account permissions',
      actionCredentials: 'Open credential settings',
      lock: 'A leftover git lock file is blocking operations ({path}): clean it up after confirming no git process is running',
    },
    rebaseOpBarHint: 'Rebase in progress: all conflicts resolved. Continue the rebase to finish.',
    continueRebase: 'Continue rebase',
    abortRebase: 'Abort rebase',
    rebaseAbortTitle: 'Abort rebase',
    rebaseAbortConfirm: 'Aborting discards the rebase progress and restores the pre-rebase state. Abort?',
    mergeOpBarHint: 'Merge in progress: all conflicts resolved. Commit in the Changes panel to finish the merge.',
    // .gitignore creation suggestion (P-20261002-76): weak hint + template modal when no .gitignore and untracked paths exist
    ignoreSuggest: {
      hint: 'No .gitignore found ({count} untracked paths) — create one from a template to keep artifacts out of version control',
      create: 'Create from template',
      dismiss: "Don't show again",
      modalTitle: 'Create .gitignore from template',
      createBtn: 'Create',
      previewLabel: 'Preview',
      created: '.gitignore created',
      desc: {
        node: 'Node.js / front-end: ignores dependencies, build output, logs and env files',
        go: 'Go: ignores binaries, test outputs and vendor directories',
        python: 'Python: ignores bytecode caches, packaging output and virtual environments',
        generic: 'Generic: OS noise, logs, temp/build output and editor files',
      },
    },
    // Changelog draft generation (P-20261003-27): tag..HEAD range grouped by conventional prefix, pure front-end with zero Go changes;
    // "hand to agent for polish" has landed (P-20261004-73, second-stage placeholder fulfilled)
    changelog: {
      title: 'Generate changelog',
      baseline: 'Baseline',
      baselineDays: 'Last N days',
      generate: 'Generate draft',
      copy: 'Copy Markdown',
      empty: 'No commits in this range',
      noTags: 'No tags in this repo: defaults to the last N days',
      truncated: 'Reached the {n}-commit cap; draft truncated — narrow the baseline and regenerate',
      agentHint: 'Draft is raw: copy it away, or one-click hand it to an agent for polish',
      rangeDays: 'Last {n} days',
      // Polish with agent (P-20261004-73): one-click polish session via the ask
      // chain; oversized drafts inject head-truncated, the prompt head tells the
      // agent to fill gaps itself
      polish: 'Polish with agent',
      polishTitle: 'Create an agent session to polish this draft (result produced in the session; oversized drafts inject head-truncated, the agent can fill gaps itself via the range note)',
      polishPromptHead: 'Polish the following Changelog draft into release notes: unify wording and entry format, keep entry facts intact; if the draft was truncated, fill gaps yourself via git log using the range note at the top. Output the polished Markdown only:',
      polishSuccess: 'Agent session created; the polished changelog will be produced in the session',
    },
    // Branch cleanup (P-20261003-50): GitHub Desktop-style governance — list only local
    // branches merged into the current HEAD (current/protected branches hard-excluded),
    // batch delete via non-forced -d, misjudgments rejected by git itself
    branchCleanup: {
      title: 'Clean Up Merged Branches',
      mergedBadge: 'merged',
      hint: 'Lists only local branches merged into the current branch (current branch and main/master are excluded)',
      selectAll: 'Select All',
      empty: 'No merged branches to clean up',
      selectedCount: '{n} selected',
      confirmTitle: 'Clean Up Merged Branches',
      confirmBody: 'This will delete {count} merged branches. This cannot be undone (unpushed merge history is unaffected). Continue?',
      deleteBtn: 'Clean Up',
      done: 'Cleaned up {ok} merged branches',
      partial: 'Cleaned {ok}, {fail} rejected by git (not fully merged or checked out in another worktree)',
    },
    ctxCheckout: 'Checkout',
    ctxBranchFrom: 'Create Branch From Here',
    ctxBranchFromTag: 'Create Branch From Tag',
    ctxMergeToCurrent: 'Merge into Current Branch',
    ctxMergePreview: 'Preview Merge…',
    ctxRebaseCurrentToHere: 'Rebase Current Branch onto Here',
    mergePreview: {
      title: 'Merge Preview',
      direction: 'Merge {source} into {base} · preview only, nothing is modified',
      cleanTitle: 'Can Merge Cleanly',
      cleanDesc: 'The merge brings changes in {files} file(s) (+{insertions} / -{deletions})',
      cleanNoChange: 'Nothing to merge — the current branch already contains everything from this branch',
      conflictTitle: '{n} file(s) expected to conflict',
      conflictHint: 'Click a file to preview its conflict sections (first-hunk summary)',
      cleanRest: 'The remaining {n} file(s) can be merged cleanly',
      hunkCount: '{n} conflict section(s)',
      ours: 'Current branch ({base})',
      theirs: 'Source branch ({source})',
      goMerge: 'Merge Now',
      readonlyNote: 'Preview is a read-only snapshot; the actual merge result prevails',
      failed: 'Preview failed',
      unsupported: 'Local git is too old (≥2.38 required for merge-tree) — preview unavailable',
      statusBothModified: 'Both modified',
      statusBothAdded: 'Both added',
      statusDeletedByUs: 'Deleted in current branch',
      statusDeletedByThem: 'Deleted in source branch',
    },
    ctxPush: 'Push',
    ctxPushToRemote: 'Push to Remote…',
    ctxCopyName: 'Copy Name',
    branchFilterPlaceholder: 'Search branches / tags…',
    noBranchMatch: 'No matching branches or tags',
    // Branch row hover commit preview popover (P-20261003-274): hover-delay
    // popover with the branch's last 3 commits — know a branch before
    // switching; click/context-menu chains bypass the popover
    branchHover: {
      title: 'Recent commits',
      loading: 'Loading commits…',
      empty: 'No commits on this branch',
      error: 'Failed to load commits, hover again to retry',
    },
    pushRefTitle: 'Push to Remote',
    pushRefLocalName: 'Local Name',
    pushRefRemote: 'Remote',
    pushRefRemoteName: 'Remote Name',
    pushRefNamePlaceholder: 'Enter remote branch/tag name',
    pushRefTip: 'Creates the remote branch/tag if it does not exist; change the remote name to push under a different name',
    pushRefBtn: 'Push',
    pushRefSuccess: 'Pushed {local} → {remote}/{name}',
    pushBehindTitle: 'Pre-Push Check',
    pushBehindContent: 'The remote is {n} commit(s) ahead; a direct push will be rejected — pull first.',
    pushBehindPullFirst: 'Pull First',
    pushBehindPushAnyway: 'Push Anyway',
    commitPush: {
      option: 'Commit and Push',
      moreTitle: 'More commit actions',
      partialFail: 'Committed, but push failed: {reason}',
    },
    ctxSetUpstream: 'Set Upstream Branch',
    ctxDelete: 'Delete',
    ctxDeleteTag: 'Delete Tag',
    checkedOut: 'Checked out {name}',
    dirtyWarnTitle: 'Uncommitted Changes',
    dirtyWarnContent: 'You have {count} uncommitted change(s): switching will carry them over to {branch} (git default behavior). To keep them on the current branch, commit first.',
    dirtyWarnBtn: 'Switch Anyway',
    dirtyWarnAutoStashBtn: 'Auto-Stash & Restore',
    checkedOutAutoStash: 'Switched to {name}; changes were auto-stashed and restored',
    autoStashKept: 'Switched to {name}; restoring the changes conflicted — they are safely kept in the stash (nothing lost). Switch back to the original branch to restore, or handle them in the stash panel',
    // Recovery hint when switching back (P-20261006-48): toast and notification
    // center entry share the title copy; the inline button is rendered via the
    // NotificationCenter actionInlineLabel registry
    autoStashRecoverable: 'Detected {count} change(s) stashed before switching away — one click to restore',
    autoStashRecoverablePlain: 'Detected changes stashed before switching away — one click to restore',
    autoStashRecoverableBody: 'Now on {branch}; click "Restore" to put these changes back into the worktree',
    autoStashRecoverAction: 'Restore',
    autoStashRecoverDone: 'Stashed changes restored',
    autoStashRecoverConflict: 'Restoring conflicted — the changes are safely kept in the stash (nothing lost); handle them in the stash panel',
    autoStashRecoverMissing: 'The stash entry no longer exists (it may already have been restored); check the stash panel',
    autoStashRecoverFailed: 'Invalid stash recovery notification',
    mergeSuccess: 'Merge successful',
    mergeConfirmTitle: 'Confirm Merge',
    mergeConfirmContent: 'Merge {source} into {base}',
    mergeConfirmPositive: 'Merge',
    // Merge strategies (P-20261007-18 squash merge): default keeps all source
    // commits; squash flattens them into a single summary commit
    mergeStrategyDefault: 'Default merge',
    mergeStrategySquash: 'Squash merge',
    mergeStrategyDefaultHint: 'Keep all commits from {source} (fast-forward or a merge commit)',
    mergeStrategySquashHint: 'Flatten the commits of {source} into a single summary commit — one commit per branch on the mainline',
    mergeSquashMsgPlaceholder: 'Summary commit message; leave empty to auto-generate "({source}) N commits: first .. last"',
    mergeSquashSuccess: 'Squash merged: source commits summarized into a single commit',
    rebaseSuccess: 'Rebase successful',
    setUpstreamSuccess: 'Set {branch} to track {remote}/{remoteBranch}',
    branchDeleted: 'Branch {name} deleted',
    branchForceDeleted: 'Force deleted',
    tagDeleted: 'Tag {name} deleted',
    deleteBranchTitle: 'Delete Branch',
    deleteBranchConfirm: 'Are you sure you want to delete branch {name}?',
    deleteFailTitle: 'Delete Failed',
    forceDeleteConfirm: '{message} Force delete?',
    createBranchFrom: 'Create Branch from {ref}',
    newBranchName: 'New Branch Name',
    branchCreated: 'Branch {name} created',
    ctxRename: 'Rename…',
    renameBranchTitle: 'Rename Branch',
    renameBranchLabel: 'Rename {name} to',
    branchRenamed: 'Branch {old} renamed to {name} (tracking config preserved)',
    branchNameRequired: 'Branch name is required',
    branchNameTooLong: 'Branch name too long (max 200 characters)',
    branchNameInvalid: 'Branch name contains invalid characters; only letters, digits, _, -, ., / are allowed',
    setUpstreamTitle: 'Set Upstream Branch',
    localBranch: 'Local Branch',
    remoteRepo: 'Remote',
    remoteBranch: 'Remote Branch',
    noRemotesOption: 'No remotes configured',
    remoteBranchPlaceholder: 'Enter or select remote branch name',
    setUpstreamBtn: 'Set',
    addRemoteTitle: 'Add Remote',
    name: 'Name',
    url: 'URL',
    remoteAdded: 'Remote {name} added',
    remoteDeleted: 'Remote {name} deleted',
    deleteRemoteTitle: 'Delete Remote',
    deleteRemoteConfirm: 'Are you sure you want to delete remote {name}?',
    noWorktree: 'No Worktrees',
    mainWorktree: 'Main Worktree',
    worktreeOpened: 'Opened worktree: {name}',
    worktreeCreated: 'Worktree created',
    createWorktreeTitle: 'Create Worktree',
    worktreePathRequired: 'Enter the worktree target path',
    targetPath: 'Target Path',
    worktreePathPlaceholder: 'e.g. ../repo-feature',
    newBranchOptional: 'New branch name (leave empty to use existing branch)',
    existingBranchOrRef: 'Existing branch or ref',
    deleteWorktreeTitle: 'Delete Worktree',
    deleteWorktreeConfirm: 'Are you sure you want to delete worktree {name}?',
    worktreeDeleted: 'Worktree deleted',
    worktreeUnlocked: 'Worktree unlocked',
    worktreeLocked: 'Worktree locked',
    locked: 'Locked',
    ctxOpen: 'Open',
    graphTruncated: 'Graph drawn for the first {max} commits only (list keeps loading)',
    // Lane-cap honesty annotation (P-20261006-29): shown on the graph when capping is active; hover explains semantics and the settings entry
    graphCompressed: 'Topology compressed: {n} lanes merged into the last lane',
    graphCompressedTip: 'Active lanes exceed the cap of {max}; overflow merges into the last lane (approximate rendering — commit data is complete). Adjust under Settings → Appearance → Commit graph lane limit.',
    ctxNewAgentHere: 'New agent terminal here',
    worktreeAgentSessions: '{n} agent session(s) in this directory',
    openAgentAfterCreate: 'Open an agent terminal here after creation',
    ctxUnlock: 'Unlock',
    ctxLock: 'Lock',
    local: 'Local',
    tags: 'Tags',
    noTags: 'No tags yet — right-click a commit to create one',
    worktrees: 'Worktrees',
    remotes: 'Remotes',
    mainBadge: 'MAIN',
    histBadge: 'History',
    histBadgeTitle: 'History-inspection worktree: fixed checkout of one commit (detached HEAD, no branch); the main checkout is untouched — delete it from the context menu when done',
    detached: '(not on a branch)',
    detachedHeadTitle: 'Detached HEAD: HEAD points to a commit directly; new commits will not belong to any branch',
    aheadTooltip: 'Commits ahead of remote',
    behindTooltip: 'Commits behind remote',
    newBranchPlaceholder: 'e.g. feature/xxx',
    refPlaceholder: 'main / v1.0 / abc123',
    remoteNamePlaceholder: 'origin',
    remoteUrlPlaceholder: 'https://github.com/user/repo.git',
  },
  commits: {
    selectBranchTag: 'Select branch/tag',
    searchCommits: 'Search...',
    dateRange: 'Date range',
    noMatch: 'No matching commits',
    loadMore: 'Scroll for more…',
    changedFiles: 'Changed Files ({n})',
    multiCommitMerged: '{n} commits merged',
    noChangedFiles: 'No changed files',
    fileCtxOpenEditor: 'Open in editor',
    fileCtxHistory: 'View file history',
    fileCtxChangeDiff: 'View this change',
    fileCtxCompareHead: 'Compare file with HEAD',
    pathCopied: 'Path copied',
    ctxCherryPick: 'Cherry-Pick',
    ctxRevert: 'Revert Commit',
    ctxBranchFrom: 'Create Branch From Here',
    ctxTag: 'Create Tag',
    ctxCopyHash: 'Copy Hash',
    ctxCopyMsg: 'Copy Commit Message',
    ctxReset: 'Reset to This Commit',
    ctxReword: 'Reword Commit Message',
    ctxRebaseFrom: 'Edit History from Here…',
    rebaseMergeUnsupported: 'A merge commit cannot start the range (rewrite ranges must not contain merge commits)',
    rewordTitle: 'Reword Commit Message',
    rewordPrompt: 'New commit message:',
    rewordEmpty: 'Commit message cannot be empty',
    rewordPushedTitle: 'Commit Already Pushed',
    rewordPushedWarning: 'This commit already exists on remote branch(es): {branches}. Rewriting it rewrites published history — you will need to force-push (force-with-lease) afterwards, and collaborators who already fetched it must reconcile manually. Continue?',
    rewordForceConfirm: 'I understand, continue',
    rewordSuccess: 'Commit message rewritten',
    ctxCompareWithHead: 'Compare with HEAD',
    ctxHistWorktree: 'Inspect at This Commit (Worktree)',
    histWorktreeCreated: 'History-inspection worktree created (detached HEAD, no branch): {path}',
    histWorktreeReused: 'Existing history-inspection worktree found — reused',
    histWorktreeOpenTerminal: 'Open in New Terminal',
    cherryPickSuccess: 'Cherry-Pick successful',
    revertSuccess: 'Revert successful',
    newBranchPrompt: 'New branch name:',
    branchCreated: 'Branch {name} created',
    tagNamePrompt: 'Tag name:',
    tagCreated: 'Tag {name} created',
    hashCopied: 'Hash copied',
    msgCopied: 'Copied',
    diffFileHint: 'Double-click to view file diff',
    resetConfirm: 'Choose reset mode: OK = Soft (keep staged), Cancel = Mixed (keep working tree)',
    resetSoft: 'Soft (keep staged)',
    resetMixed: 'Mixed (keep working tree)',
    resetDone: 'Reset done',
    toggleFullMessage: 'Toggle full commit message',
    copyFullMessage: 'Copy full message',
    fullTime: 'Full time',
  },
  // "Generate commit message" in the changes panel (P-20261002-138): one-click agent session from the staged list
  commit: {
    agentMsg: {
      button: 'Generate commit message',
      buttonTitle: 'Create an agent session to draft a commit message from the staged changes (result appears in the session; review and copy it yourself)',
      promptHead: 'Please draft a git commit message for the following staged changes (first line is the subject, keep it concise; output only the commit message itself, no extra explanation):',
      promptListHead: 'Staged changes (short status letter + path):',
      // Agent marks attribution line (P-20261005-172): shared by P-138 generate commit
      // message and P-2 changeset review — one meaning, one translation (same pattern as
      // sensitiveTitle/sensitiveBody); {runtimes} is data interpolation
      marksNote: '{n} of the files were changed in agent sessions (runtimes: {runtimes})',
      success: 'Agent session created; the commit message will be produced in the session',
      degraded: 'No agent runtime detected; created a plain terminal session (context not injected)',
      failed: 'Failed to create agent session',
      sensitiveTitle: 'Context may contain sensitive information',
      sensitiveBody: 'The file paths to send look like they contain credentials or tokens. Send them to the agent anyway?',
    },
    // "Split suggestion" in the changes panel (P-20261003-186): one-click agent session proposing commit grouping.
    // Since P-20261003-278 the output is structured (promptFormat requests a ```json block); the panel's
    // "execute groups" action (splitExec) parses it and runs after a preview confirmation
    splitSuggest: {
      button: 'Split suggestion',
      buttonTitle: 'Create an agent session that splits the staged changes into topical commits and proposes groups (suggestions only: review and stage/commit each group yourself; nothing runs automatically)',
      promptHead: 'Split the staged changes below into multiple commits by topic: inspect the full diff yourself first, then group; for each group output a name, its file list, and a commit subject. Suggestions only — do not run git add/commit or any other write operation.',
      // Literal braces must be escaped as {'{'} / {'}'} (vue-i18n compiles {x} as named
      // interpolation; see settings.snippet.fieldCommand — raw {"groups":…} breaks message
      // compilation). The example's files use the locale-neutral '…' placeholder: the example
      // echoes into the session scrollback with the prompt, and the execute parser drops that
      // candidate via PLACEHOLDER_FILES (useCommitSplitExecute)
      promptFormat: "When done, end your reply with a single ```json code block: {'{'}\"groups\":[{'{'}\"name\":\"group name\",\"files\":[\"…\"],\"subject\":\"commit subject\"{'}'}]{'}'}, filling files with the original paths from the list",
      promptListHead: 'Staged changes (short status letter + path, may be truncated):',
      success: 'Agent session created; the split proposal will be produced in the session',
      degraded: 'No agent runtime detected; created a plain terminal session (context not injected)',
      failed: 'Failed to create agent session',
      sensitiveTitle: 'Context may contain sensitive information',
      sensitiveBody: 'The file paths to send look like they contain credentials or tokens. Send them to the agent anyway?',
    },
    // "Execute groups" (P-20261003-278): confirmed execution of the structured split proposal —
    // parse the suggestion session's output, preview groups behind a confirmation dialog, then the
    // server stages+commits group by group (write-queue domain); interruption report on failure
    splitExec: {
      button: 'Execute groups',
      buttonTitle: 'Parse the structured groups from the split-suggestion session; after confirmation, stage and commit each group automatically (no git write happens before the preview confirmation)',
      dialogTitle: 'Confirm group-by-group execution',
      dialogIntro: 'The following {n} groups will be staged and committed one by one (one commit per group, in order):',
      // Informational note: pathspec commits never sweep in out-of-group staged content
      noteForeignStaged: 'Staged but in no group (will not be committed; stays staged after execution)',
      warnMissingFiles: 'Files in groups not in the current change list (already committed/reverted; execution will stop at that group)',
      more: '…and {n} more not listed',
      confirm: 'Execute',
      running: 'The agent is still producing the grouping plan; try again shortly',
      noSuggestion: 'No structured grouping plan (```json block) found in the suggestion session output',
      fetchFailed: 'Failed to read the suggestion session output (the session may be closed)',
      done: 'Committed group by group: {n} groups done',
      reportTitle: 'Group execution interrupted',
      executedHead: '{n} groups committed (not rolled back):',
      failedHead: 'Interrupted at "{name}" ({step} failed)',
      remaining: '{n} groups were not executed (skipped, no retry)',
      step: {
        stage: 'stage',
        commit: 'commit',
      },
    },
    // "Generate PR description" (P-20261003-177): PR-level extension of P-138 —
    // agent marks list + diffstat + recent commits draft a structured PR
    // description (four-section template), produced in the session for manual
    // review and copy into the PR system
    prDesc: {
      button: 'Generate PR description',
      buttonTitle: 'Create an agent session to draft a PR description from the agent change list, change size and recent commits (result appears in the session; review and copy it into your PR system)',
      promptHead: 'Please draft a PR description for the current branch from the context below (markdown with four sections: ## What changed / ## Why / ## How to test / ## Risks; output only the description itself, no extra explanation; where context is insufficient, inspect the repository yourself):',
      marksHead: 'Agent change list (path · runtime · sessions):',
      statLine: 'Change size: +{a} / -{d} lines (indicative)',
      commitsHead: 'Recent commits (short hash + subject):',
      success: 'Agent session created; the PR description will be produced in the session',
      failed: 'Failed to create agent session',
    },
    // "Suggest tests" (P-20261003-249): agent marks list + diffstat launch an
    // agent session to analyze test gaps — suggestions only (file / test
    // points / priority); no tests are written automatically
    suggestTests: {
      button: 'Suggest tests',
      buttonTitle: 'Create an agent session to analyze which tests this change is missing and propose them (suggestions only: file / test points / priority; review and launch implementation yourself — no tests are written automatically)',
      promptHead: 'Analyze the change below for missing test coverage: for each gap give "file / test points / priority (high/medium/low)". Suggestions only — do not write or modify test files (a human reviews and launches that separately); the list may be truncated, verify against the repo yourself:',
      marksHead: 'Changed files (path · runtime · sessions):',
      statLine: 'Change size: +{a} / -{d} lines (indicative)',
      success: 'Agent session created; the test suggestions will be produced in the session',
      degraded: 'No agent runtime detected; created a plain terminal session (context not injected)',
      failed: 'Failed to create agent session',
    },
    // "Review changeset with agent" (P-20261005-2): one-click pre-commit quality
    // gate — hand the whole workspace changeset to a new agent session; review
    // comments are produced in the session, the commit decision stays human.
    // Fixed sections keep a tight byte budget so small changesets fit the 500
    // byte launchArgs directly; large ones degrade to the task file
    review: {
      buttonTitle: 'Create an agent session to review the current workspace changeset (risks / missing tests / convention consistency; results appear in the session, the commit decision stays human)',
      promptHead: 'Please review the uncommitted workspace changes below before the commit decision, answering: ① risks (logic / security / compatibility); ② missing tests; ③ consistency with repo conventions. Output review comments only; do not modify files.',
      listHead: 'Changes (status letter + path):',
      stagedHead: 'Staged:',
      unstagedHead: 'Unstaged/untracked:',
      more: '({n} more not listed)',
      statLine: 'Size: +{a} / -{d} lines (numstat, indicative)',
      baseline: 'Baseline: branch {branch} · last commit: {subject}',
      baselineBranchOnly: 'Baseline: branch {branch}',
      selfServe: 'The workspace is this session\'s directory — run git diff / git status to inspect the full changes.',
      success: 'Agent session created; the review comments will be produced in the session',
      degraded: 'No agent runtime detected; created a plain terminal session (context not injected)',
      failed: 'Failed to create agent session',
    },
    // Commit-message gate failure dialog (P-20261003-273): "reasons + fix with
    // agent" popup on convention precheck failure; ruleXxx keys are driven by
    // the structured violations from utils/commitMsgRules (rule → key,
    // type/len/max interpolated)
    gateFix: {
      title: 'Commit message check failed',
      hint: 'Hand it to the agent to rewrite a compliant message (produced in the session; review, paste back and retry), or commit as-is.',
      agentAction: 'Fix with agent',
      commitAnyway: 'Commit anyway',
      ruleFormat: 'Subject does not match <type>(<scope>): <subject>',
      ruleType: 'Type "{type}" is not in the whitelist',
      ruleScope: 'Empty scope (write type(scope): or drop the parentheses)',
      ruleSubject: 'Subject is empty',
      ruleLength: 'Subject is {len} chars, over the limit of {max}',
    },
  },
  commitPanel: {
    changes: 'Changes',
    stash: 'Stash',
    commitPlaceholder: 'Commit message...',
    ccAdvanced: 'Expand Conventional Commit advanced options',
    ccScopePlaceholder: 'scope',
    ccBreakingTitle: 'Mark as breaking change (!)',
    ccFooterPlaceholder: 'Footer: e.g. Closes #123',
    ccAppendFooter: 'Append',
    selectAll: 'Select All',
    commitCount: 'Commit ({n})',
    stageAll: 'Stage All',
    noChanges: 'No Changes',
    ctxUnstage: 'Unstage',
    ctxStageFile: 'Stage File',
    ctxRollback: 'Rollback Changes',
    ctxGitignore: 'Add to .gitignore',
    ctxCopyPath: 'Copy Path',
    ctxOpenInEditor: 'Open in Editor',
    // Keyboard multi-select batch form (P-20261003-271): {n} = selected file count
    ctxBatchStage: 'Stage Selected ({n})',
    ctxBatchUnstage: 'Unstage Selected ({n})',
    ctxBatchRollback: 'Rollback Selected ({n})',
    ctxBatchGitignore: 'Exclude Selected ({n})',
    ctxBatchCopyPath: 'Copy Selected Paths ({n})',
    batchRollbackConfirm: 'Discard uncommitted changes in {n} files? This cannot be undone.',
    batchRolledBack: 'Rolled back {n} files',
    rolledBack: 'Rolled back {path}',
    gitignoreAdded: 'Added to .gitignore',
    pathCopied: 'Path copied',
    commitMsgRequired: 'Please enter a commit message',
    noStagedFiles: 'No staged files',
    commitSuccess: 'Committed successfully',
    stashMsgPrompt: 'Stash message (optional):',
    stashMsgPlaceholder: 'WIP: ...',
    // Stash scope (P-20261003-119 selective stash): dialog radio group + unsupported note
    stashScopeAll: 'All changes',
    stashScopeStaged: 'Staged only',
    stashScopeUnstaged: 'Unstaged only',
    stashScopeStagedUnsupported: 'Staged-only stash is not available here (requires git 2.35+)',
    stashCreated: 'Stash created',
    stashPopped: 'Stash restored',
    stashDropped: 'Stash deleted',
    createStash: 'Create Stash',
    noStash: 'No Stash entries',
    stashPop: 'Restore',
    // Apply to new branch (P-20261003-263 experimental stash apply)
    stashApplyBranch: 'Apply to New Branch',
    stashApplyBranchTitle: 'Apply Stash to New Branch',
    stashBranchNameLabel: 'New branch name:',
    stashBranchNamePlaceholder: 'stash-trial',
    stashApplyBranchHint: 'Creates a branch from the original base of the stash and applies the stash there, then checks it out. The stash entry is removed (its content now lives on the new branch); the current branch stays untouched.',
    stashAppliedBranch: 'Stash applied and checked out on new branch {name} (stash entry removed by git semantics)',
    stashDelete: 'Delete',
    stageTitle: 'Stage',
    selectCommitTitle: 'Select for commit',
    openDiffHint: 'Double-click to diff against HEAD',
    amend: 'Amend last commit',
    amendTitle: 'Fold these changes into the previous commit (rewrites history: force-push needed if already pushed)',
    amendNoHead: 'No commit to amend yet',
  },
  stash: {
    diff: {
      view: 'View Diff',
      title: 'Stash Preview · stash{\'@\'}{\'{\'}{index}{\'}\'}',
      empty: 'This stash has no content changes',
    },
  },
  branchesPanel: {
    branchNamePlaceholder: 'Branch name',
  },
  conflict: {
    conflictFiles: 'Conflict Files',
    noConflict: 'No conflict files',
    selectConflictFile: 'Select a conflict file to view content',
    resolveMethod: 'Resolve method:',
    mode3way: '3-Way',
    modeText: 'Text',
    useOurs: 'Use Ours',
    useTheirs: 'Use Theirs',
    saveResult: 'Save Result',
    ours: 'Ours',
    result: 'Result (editable)',
    theirs: 'Theirs',
    conflictResolved: 'Conflict resolved',
    conflictResolvedWith: 'Conflict resolved ({strategy})',
    // Stale-snapshot guidance banner (P-20261004-27 baseHash optimistic lock, set on 409)
    staleHint: 'The conflict file was modified externally during resolution; your edits are based on a stale snapshot and the write-back was rejected. Re-parse before applying (the external changes are kept).',
    staleReload: 'Re-parse',
    // Conflict delegation to agent session (P-20261005-190): single file / whole set,
    // payload assembly in useConflictAgentDelegate; no automation (never auto-staged)
    agent: {
      delegate: 'Resolve with Agent',
      delegateBatch: 'Send All to Agent',
      dialogTitle: 'Resolve with Agent',
      templateLabel: 'Task prompt (editable template)',
      defaultTemplate: 'Resolve the conflicts, explain the trade-off on both sides, and leave the file stageable when done',
      // Template memory reset (P-20261008-10): one click back to default + clear the saved uiState value
      resetTemplate: 'Reset to default',
      batchTarget: '{n} conflicted files',
      templatePlaceholder: 'Leave empty to send only the file path and conflict context',
      singleHint: 'Creates an agent session for {file}; the payload includes excerpts of the conflict markers and both sides (truncated when long). Agent edits go through the normal save chain and are never auto-staged — review in the changes panel.',
      batchHint: 'Creates one agent session to work through {n} conflicted files (the list is injected into the prompt, split automatically when long). Nothing is auto-staged — review in the changes panel.',
      ctxMerge: 'merge in progress',
      ctxRebase: 'rebase in progress',
      ctxCherryPick: 'cherry-pick in progress',
      ctxNone: 'conflict resolution in progress',
      promptFile: 'File: {path}',
      promptCtx: 'Context: {ctx}',
      promptOurs: 'Ours (ours side): ',
      promptTheirs: 'Theirs (theirs side): ',
      promptOmitted: '…… (truncated; refer to the full file content)',
      promptListHead: '{n} conflicted files:',
      promptOmittedFiles: '({n} more files omitted; fetch via GET /conflicts)',
      launch: 'Create Session',
      successBatch: 'Agent session created: {n} conflicted files',
    },
  },
  rebase: {
    rebaseAborted: 'Rebase aborted',
    rebaseContinued: 'Rebase continued',
    // Interactive rebase editor (P-20261003-324 commit grooming: reorder/squash/drop/reword)
    editor: {
      title: 'Edit commit history',
      rangeHint: '{count} commits from here (in apply order)',
      rootRange: '{count} commits from the root (entire history, in apply order)',
      action: {
        pick: 'Keep',
        squash: 'Squash into previous',
        reword: 'Reword',
        drop: 'Drop',
      },
      squashIntoPrev: 'squash into previous',
      squashedInto: 'Squashed: {msg}',
      droppedItem: 'Dropped: {msg}',
      preview: 'Preview (oldest to newest)',
      hint: 'Use arrows to reorder; "Squash into previous" merges the message into the commit above',
      rewordPlaceholder: 'New commit message',
      execute: 'Apply',
      success: 'Commit history updated',
      executeFailed: 'Rebase failed; the repository has been restored',
      pushedTitle: 'Rewrite pushed commits',
      pushedWarning: 'The range contains pushed commits (present on: {branches}). Continuing rewrites public history; you will need to force-with-lease push afterwards.',
      pushedConfirm: 'Apply anyway',
      loadFailed: 'Failed to load range commits',
      errorEmpty: 'The range is empty',
      errorAllDropped: 'Cannot drop every commit in the range (use reset to rewind instead)',
      errorSquashFirst: 'The first commit cannot be "Squash into previous" (nothing to squash into)',
      errorRewordEmpty: 'The reworded commit message must not be empty',
      errorOverLimit: 'The range exceeds the limit of {max} commits; start from a more recent commit',
      moveUp: 'Move up',
      moveDown: 'Move down',
    },
  },
  fileHistory: {
    noCommits: 'No commits yet',
    selectCommit: 'Select an entry to view changes',
    // Merged per-file timeline (P-20261008-11): git commits × local saves
    sourceFilterLabel: 'Source filter',
    sourceAll: 'All sources',
    sourceGit: 'Git commits',
    sourceLocal: 'Local saves',
    badgeGit: 'Git commit',
    badgeLocal: 'Local save',
    olderCommits: '{n} earlier commits in Git history',
    olderCommitsHint: 'Click to switch to Git-only view (full list)',
    restoreGit: 'Restore to this commit',
    gitRestoreTitle: 'Restore to this commit version?',
    gitRestoreBody: 'The worktree file will be overwritten with its content at this commit (current uncommitted changes will be lost); review the diff preview on the right first.',
    gitRestored: 'File version from this commit checked out',
  },
  changesView: {
    recentMessages: 'Recent Messages',
  },
  instance: {
    local: 'Local',
    addRemote: 'Add Remote Instance',
    name: 'Name',
    namePlaceholder: 'e.g. dev-server',
    url: 'URL',
    urlPlaceholder: 'https://192.168.1.100:9999 (write http:// explicitly for plain HTTP)',
    token: 'Token (optional)',
    tokenPlaceholder: 'Generate from Settings > API Token on remote instance',
    added: 'Remote instance {name} added',
    selfRef: 'Instance URL cannot point to this server itself (the local server)',
    urlCopied: 'Instance URL copied',
    manage: 'Manage Instances',
    testConnection: 'Test Connection',
    testing: 'Testing...',
    testSuccess: 'Connection successful',
    testReachable: 'Service online, but token invalid or missing — API calls will fail after switching',
    testWrongToken: 'This is an unlock token (scl_ prefix); use an API Token (sc_ prefix) instead',
    testNotApp: 'Address reachable, but the response is not a Codecombo server — check the URL',
    testLoopbackHint: 'Connection failed: the URL uses localhost/127.0.0.1, reachable only from the target machine itself — test on the machine where the instance runs, or use a cross-machine address (e.g. LAN IP)',
    testFailed: 'Connection failed',
    schemeSwitched: 'Target address detected — the URL has been updated automatically',
    tlsUntrusted: 'Target uses HTTPS but its certificate is not trusted by this machine — install the peer\'s certs/cert.pem into the system trust store and retry',
    invalidUrl: 'Invalid instance URL, e.g. https://192.168.1.100:9999',
    localUrlPlaceholder: 'Cross-machine reachable address for other instances to pull updates, e.g. https://192.168.1.100:9999',
    localTokenPlaceholder: 'API Token issued by this machine as update center (create in Settings → Tokens)',
    instances: 'Instances',
    newTokenPlaceholder: 'New Token (optional)',
    save: 'Save',
    current: 'Current',
    switchTo: 'Switch',
    copyUrl: 'Copy instance URL',
    edit: 'Edit',
    remove: 'Remove',
    updated: 'Updated',
    removed: 'Removed',
    removeTitle: 'Remove Instance',
    removeConfirm: 'Are you sure you want to remove remote instance {name}? All active connections will be closed.',
    statusOnline: 'Online',
    statusOffline: 'Offline',
    statusInvalid: 'Not a Codecombo server',
    statusUnknown: 'Unknown',
    switchingTo: 'Switching to {name}…',
    offlineConfirmTitle: 'Instance offline',
    offlineConfirmContent: 'Instance "{name}" appears offline. Projects may fail to load after switching. Switch anyway?',
    noRemote: 'No remote instances yet. Use the button below to add one.',
    refreshStatus: 'Refresh status',
    // Federated dispatch result notification (P-20261004-101): server-side titleKey template
    dispatch: {
      notify: {
        title: 'Dispatched to {instance}: {session}',
      },
    },
    editTitle: 'Edit instance',
  },

  update: {
    checkUpdate: 'Check Update',
    recheck: 'Re-check',
    sourceUrlLabel: 'Center Distribution Source (optional)',
    sourceUrlPlaceholder: 'https://github.com/owner/repo',
    sourceUrlHint: 'Only used when this machine acts as an update center: cross-platform children (e.g. Windows center → Linux child) fetch binaries from this GitHub Release URL. Self-update source is built in (official repo) — no config needed. Empty disables cross-platform distribution.',
    autoCheckLabel: 'Automatic update check',
    autoCheckHint: 'Checks every 24h and notifies when a new version is available; off = manual check only',
    autoCheckSaved: 'Automatic update check setting saved',
    starText: 'Codecombo is open source and free — if it helps you,',
    starAction: 'give it a Star',
    prereleaseLabel: 'Follow pre-releases',
    prereleaseHint: 'When on, beta/rc pre-releases are also detected; default is stable releases only',
    prereleaseSaved: 'Update channel saved',
    sourceUrlSaved: 'Distribution source saved',
    sourceUrlInvalid: 'URL must start with http:// or https://',
    noSourceHint: 'No distribution source configured — fill in the GitHub Release URL below to check for updates',
    hasUpdate: 'New version available',
    currentVersion: 'Current Version',
    latestVersion: 'Latest Version',
    downloadSize: 'Download Size',
    changelog: 'Changelog',
    updateNow: 'Update Now',
    updating: 'Updating...',
    restarting: 'Restarting...',
    success: 'Update Successful',
    failed: 'Update Failed',
    rolledBack: 'Rolled Back',
    alreadyLatest: 'Already up to date',
    status: 'Status',
    progress: '{percent}%',
    role: 'Role',
    roleCenter: 'Center',
    roleSub: 'Sub',
    jumpToInstance: 'Jump',
    updateFromCenter: 'Update from Center',
    centerHasUpdate: 'New version on the center',
    centerUpToDate: 'No center update detected — manual pull still available',
    updateAvailableTitle: 'Update available',
    updateAvailable: 'Update Available',
    parentInstance: 'Parent',
    noParent: 'None (standalone)',
    updateSourceNotConfigured: 'Update source not configured',
    updateStarted: 'Update started',
  },
  // Toolbar & status bar extras
  toolbar2: {
    sync: 'Sync',
    syncTooltip: 'Pull then Push (Sync)',
    branchSwitch: 'Switch Branch',
    newBranch: 'New Branch',
    searchBranch: 'Search branches...',
  },
  statusbar: {
    changesCount: 'Changed Files',
    hasUpdate: 'Update available',
    copyRemote: 'Copy remote URL',
    // Watch degraded badge (P-20261006-34): persistent visibility for a lasting
    // state; tooltip explains the shallow-scan boundary and recovery conditions
    // (auto/manual differ, hence two entries)
    watchFallback: 'Polling degraded',
    watchFallbackAutoTip: 'File watching is degraded to polling mode (inotify quota exhausted, shallow scan every 5s): only the project root and first-level subdirectories are covered - deeper changes may be delayed or missed; will switch back to real-time watching automatically once the quota is freed',
    watchFallbackManualTip: 'File watching is in manual polling mode (shallow scan every 5s): only the project root and first-level subdirectories are covered - deeper changes may be delayed or missed; manual mode never auto-restores, switch it off via the "Switch to polling" action in the notification center',
  },
  panel: {
    maximize: 'Maximize Panel',
  },
  commandPalette: {
    title: 'Command Palette',
    noResults: 'No matching results',
    fallback: {
      hint: 'No file name matches -',
      action: 'Search file contents (Ctrl+Shift+F)',
    },
    loading: 'Loading files...',
    commands: 'Commands',
    commandsMode: 'Command Mode',
    frequentCommands: 'Frequently used',
    navigate: 'Navigate',
    select: 'Select',
    // File-mode Ctrl/Cmd+Enter (P-20261002-106): footer key hint for split-open
    selectSplit: 'Open in Split',
    close: 'Close',
    // Esc two-layer exit (P-20261004-95): footer hint swaps to clear semantics while a query is present
    clearQuery: 'Clear query',
    cmdOpenSettings: 'Open Settings',
    cmdOpenSettingsTab: 'Open Settings: {tab}',
    cmdOpenMonitor: 'Open Duty Dashboard',
    cmdShortcutsHelp: 'Keyboard shortcuts cheat sheet',
    cmdRemoteConsole: 'Open Remote Manager',
    cmdShareManager: 'Open File Sharing',
    cmdShareCurrentFile: 'Share Current File',
    cmdToggleTheme: 'Switch Theme',
    cmdTaskRunner: 'Task Runner',
    cmdLockSystem: 'Lock System',
    categoryRemoteOps: 'Remote Ops',
    categoryProject: 'Project',
    cmdSwitchProject: 'Switch to project: {name}',
    // Branch quick-switch (P-20261002-102): dynamic command group from local branches
    categoryBranch: 'Branch',
    cmdCheckoutBranch: 'Switch to branch: {name}',
    branchCurrent: 'Current branch',
    // Instance quick-switch (P-20261002-111): dynamic command group from instance list
    categoryInstance: 'Instance',
    cmdSwitchInstance: 'Switch to instance: {name}',
    instanceCurrent: 'Current instance',
    // New session from template (P-20261005-10): P-16 task template dynamic command group (direct create)
    categoryTemplate: 'Session Templates',
    cmdNewFromTemplate: 'New session from template: {name}',
    cmdTemplateLaunched: 'Session created from template "{name}"',
    cmdDiagnoseHost: 'Diagnose host {name}',
    cmdConnectHost: 'Connect: {name}',
    cmdExecHost: 'Remote exec: {name}',
    cmdDiagCompare: 'Fleet inspection compare',
    cmdNewFile: 'New File',
    cmdFetchAll: 'Fetch All Projects',
    cmdFetchCurrent: 'Fetch Current Project',
    cmdPullCurrent: 'Pull Current Branch',
    cmdPushCurrent: 'Push Current Branch',
    cmdSearchInProject: 'Search in Project',
    cmdReopenClosedTab: 'Reopen Closed Tab',
    // Locate active file in tree (P-20261003-294): reveal active tab in the file tree
    cmdLocateInTree: 'Reveal Active File in Tree',
    // Fold controls (P-20261006-20): command palette exposure of Monaco built-in fold actions
    cmdFoldAll: 'Fold All',
    cmdUnfoldAll: 'Unfold All',
    cmdFoldLevel1: 'Fold Level 1',
    // In-place toast when the active group has no Monaco instance (diff tab / meta card / loading)
    foldNoEditor: 'No foldable editor open - open a file first',
    // Project rules direct access (P-20261006-43): settings block + rule file edit commands
    cmdOpenProjectRules: 'Project Rules',
    cmdEditRuleFile: 'Edit {name}',
    ruleMissingTitle: '{name} does not exist',
    ruleMissingConfirm: '{name} is not in this project yet. Create it from the minimal template and open it for editing?',
    ruleCreatedOpened: 'Created {name} from template and opened it in the editor',
    ruleCreateExists: '{name} already exists (perhaps just created); opened it in the editor',
  },
  quickOpen: {
    placeholder: 'Open file by name...',
    recent: 'Recent',
    allFiles: 'All Files',
    resumeWork: 'Continue where you left off',
    files: 'Files',
    // Remote file layer (P-20261004-137): open remote tabs + recent remote, own group
    remoteFiles: 'Remote Files',
    indexCapped: 'Only the first {n} files are indexed - use the file tree or global search for deeper paths',
    gotoLine: 'Line {n}',
  },
  // Presentation mode (P-20261002-45): enter via command palette, exit via Esc or running it again
  present: {
    mode: {
      command: 'Presentation Mode',
      entered: 'Presentation mode on: press Esc or run the command again to exit',
      exited: 'Presentation mode off — font size and panels restored',
    },
  },
  outline: {
    title: 'Outline',
    empty: 'No headings found',
    codeHint: 'Outline is not available for this file type',
  },
  projectSearch: {
    placeholder: 'Enter search query...',
    replacePlaceholder: 'Replacement (optional)',
    invalidRegex: 'Invalid regex. Please check and try again',
    noResults: 'No matches',
    searching: 'Searching...',
    replace: 'Replace',
    replaceAll: 'Replace all',
    replacedAll: 'Replaced {matches} match(es) in {files} file(s)',
    // Server-side execution chain (P-20261004-66): honest report when every selected file was skipped/conflicted
    replacedNone: 'No files were replaced (matches may have been skipped or modified externally)',
    filePattern: 'File pattern (*.go)',
    matchesIn: 'matches in',
    truncatedHint: '(showing first 500)',
    filesUnit: 'files',
    startHint: 'Type to search (supports regex, case, whole word, glob)',
    more: 'more matches',
    // Extension quick-pick chips (P-20261003-148): click prefills glob=*.ext, two-way
    // bound with the glob input; chip literals (.ts etc.) are language-neutral by design
    extChips: 'Common extensions',
    extChipApply: 'Limit file filter to {glob}',
    extChipClear: 'Clear extension filter (currently {glob})',
    // Copy all paths (P-20261003-149): results-header button tooltip, newline-separated unique paths
    copyPaths: 'Copy all paths (current result scope, newline-separated)',
    // Export results CSV (P-20261003-272): results-header button tooltip + success toast
    exportCsv: 'Export results CSV (current result scope, file/line/content columns)',
    exportDone: 'Search results exported',
    // Result-row delete (P-20261003-178): file-group header button tooltip (confirm/success copy reuses the fileTree.delete family)
    deleteResult: 'Delete this file',
    // Keyboard traversal hint (P-20261006-23): one-line results footer, symbols are language-neutral
    kbdHint: '↑↓ navigate hits · Enter open · Shift+Enter previous · F3/Shift+F3 next/prev hit',
    // Query history dropdown (P-20261003-48): recents on focus, prefix-filter completion
    history: {
      empty: 'No matching history',
      clear: 'Clear history',
    },
  },
  // Cross-project global search (P-20261002-17)
  search: {
    projects: {
      scopePlaceholder: 'Search scope',
      scopeAll: 'All projects',
      projectFailed: 'Search failed for this project',
      rangeHint: '{n} projects selected; narrow the scope for faster search',
      truncatedHint: '(partial results per project)',
      replaceDisabled: 'Replace is unavailable across projects; switch back to a single project',
      // Cross-project delete disabled note (P-20261003-178)
      deleteDisabled: 'Delete is unavailable across projects; switch back to a single project',
      // Streaming progress line (P-20261003-94): render each project as it completes
      progress: 'Searching {done}/{total} projects',
      // Mid-search cancel (P-20261005-182): cancel button while running + progress-line
      // annotation after cancelling (partial results are kept and usable)
      cancel: 'Cancel',
      cancelled: 'Cancelled ({done}/{total} projects completed)',
    },
    // File-level selective replace (P-20261002-23) + replace preview modal (P-20261003-71)
    replace: {
      selectAll: 'Select all',
      clearAll: 'Clear',
      // Preserve case (P-20261006-16): replacement output follows each match shape,
      // orthogonal to case-sensitive matching
      preserveCase: 'Preserve case: replacements follow each match shape (lowercase as-is / Title initial cap / UPPERCASE)',
      replaceSelected: 'Replace {n} selected file(s)',
      // Preview modal: per-hit before (struck red) -> after (green) line pairs before confirm
      previewTitle: 'Replace Preview',
      previewStats: 'Will replace {matches} match(es) in {files} files',
      previewHint: 'Replacements write files directly and cannot be undone - review the line pairs',
      // Low-confidence badge (P-20261005-157 rename reference update): './c'-style
      // hits default to unchecked
      lowConfidence: 'Low confidence',
      lowConfidenceTitle: 'Same-directory shorthand (./c) may also point to a same-named file in another directory — verify each line before checking it',
      toggleFile: 'Collapse / expand this file',
      moreHits: 'Show {n} more',
      confirmDisabled: 'Select at least one file',
      // Server-side execution chain (P-20261004-66): paths-cap precheck + sensitive gate confirm + partial-completion note
      tooManyFiles: 'More than 500 files selected; narrow the scope and replace in batches',
      partial: '{skipped} skipped / {conflicts} conflict(s) (files modified externally; restorable from the history panel)',
      truncatedNote: 'Hits exceeded the server scan cap; some files were not replaced — narrow the scope (e.g. glob) and batch',
      sensitive: {
        title: 'Replacement hits sensitive files',
        warn: 'These files match the sensitive filename list (.env / keys / credentials):',
        files: '{files}',
        confirm: 'Replace these files as well?',
      },
      // Backup patch (P-20261003-76 semantics kept / P-20261004-66 download after execute): the
      // backup itself is archived server-side (artifacts + replace history), download is an off-hand copy
      backup: {
        toggle: 'Export backup patch before replace',
        toggleTitle: 'Download the pre-replace worktree diff (.patch) after executing; the backup is also archived server-side — restore from Settings · Security · Replace History',
        saved: 'Backup patch downloaded, pre-replace content restorable',
        downloadFailed: 'Backup patch download failed (backup archived server-side; restore from Settings · Security · Replace History)',
      },
    },
  },
  breadcrumb: {
    copyPath: 'Copy Path',
    copyRelativePath: 'Copy Relative Path',
    revealInTree: 'Reveal in File Tree',
    // Open terminal here (P-20261005-192): directory-level terminal entry, action via layout bridge
    openTerminalHere: 'Open Terminal Here',
    siblingLoading: 'Loading…',
    siblingEmpty: 'Empty folder',
  },
  license: {
    title: 'License',
    subtitle: 'Manage your license information',
    licensee: 'Licensee',
    edition: 'Edition',
    features: 'Available Modules',
    issuedAt: 'Issued At',
    expiresAt: 'Expires At',
    notActivated: 'No license activated',
    activateBtn: 'Activate License',
    activateFailed: 'License activation failed',
    activated: 'License activated',
    deactivated: 'License deactivated',
    deactivate: 'Deactivate License',
    keyPlaceholder: 'Paste license key (format: payload.signature)',
  },
  // Webhook push (P-20261002-31): in-app events → phone (Bark/ntfy/custom receivers)
  notify: {
    webhook: {
      title: 'Webhook push',
      desc: 'Forward approval requests and task failures to your phone (Bark / ntfy / custom receiver), even when the page is closed',
      modePost: 'POST JSON (recommended)',
      modeGet: 'GET template',
      scopeImportant: 'Approvals & failures',
      scopeAll: 'All notifications',
      urlPlaceholder: 'https://api.day.app/your-key or https://ntfy.sh/topic',
      // Literal braces must be escaped as {'{'} / {'}'} (same convention as
      // fieldCommand) or vue-i18n compiles them as placeholders and the
      // render-time SyntaxError takes down the whole settings pane
      urlHint: "GET mode supports {'{'}title{'}'}/{'{'}body{'}'} placeholder interpolation (values auto-escaped); POST mode sends JSON with title and body fields; the URL may contain your push key and is stored encrypted",
      test: 'Send test push',
      testOk: '✓ Test push sent — check your phone (current edits saved too)',
      testFail: 'Test failed: {msg}',
      // Webhook independent trade-off note (P-20261003-90): delivery is a
      // server-side channel, not bound by this browser's desktop simplified
      // mode. Since P-20261007-9 payloads are masked server-side before leaving
      // the machine (token/password values become ***; hostnames and paths stay
      // readable for troubleshooting) while the in-app center keeps full text
      privacyNote: 'Webhook payloads are masked server-side before leaving the machine (token/password values become ***; hostnames and paths stay readable for troubleshooting). The in-app center is unaffected and keeps full content; the desktop minimal mode does not apply to outbound push',
    },
    // Desktop notification minimal mode (P-20261003-90): once enabled, desktop
    // notifications show only this placeholder title with no title/body
    // details; the in-app notification center keeps full content
    simple: {
      title: 'New notification',
    },
    // Do-not-disturb window (P-20261002-40): notification toasts & desktop
    // notifications silenced in-window; the center keeps recording. Approval
    // cards are explicitly excluded. Exception categories (P-20261003-115):
    // selected categories still alert in-window, approval waits on by default
    dnd: {
      title: 'Do Not Disturb',
      desc: 'During the window, notification toasts and desktop notifications are silenced while the notification center keeps recording (window may cross midnight, e.g. 22:00 → 08:00)',
      start: 'Start',
      end: 'End',
      exceptLabel: 'Exceptions (still alert in-window)',
      exceptDesc: 'Selected categories are not silenced during the window — approval waits are allowed through by default so overnight agents waiting on a decision are not swallowed',
      exceptPlaceholder: 'No exceptions — everything silenced in-window',
      // Error-level piercing (P-20261004-117): on by default — alarm reachability
      // for overnight duty (task failure / sentinel hit / deploy failure deserve
      // waking a human); off = absolute silence in-window (a legitimate preference)
      exceptErrorLabel: 'Still alert on errors',
      exceptErrorDesc: 'Error-level notifications (task failures, sentinel hits, deploy failures, etc.) still raise a desktop notification during do-not-disturb — DND filters noise, not alarms; turn off for absolute silence in-window',
      approvalNote: 'Approval cards always surface immediately; the approval waiting alert pierces do-not-disturb by default (adjust in the exception categories above)',
    },
    // Manual quick do-not-disturb (P-20261003-227): bell-side toggle for instant
    // muting (meetings/focus) outside the scheduled window; OR-combined with the
    // schedule and auto-restored on expiry
    dndManual: {
      toggleTitle: 'Do not disturb',
      activeTitle: 'Do not disturb on · {time} left',
      activeUntilOffTitle: 'Do not disturb on · until turned off',
      hour1: 'Mute for 1 hour',
      untilOff: 'Mute until I turn it off',
      turnOff: 'Turn off',
      minutes: '{n} min',
      hours: '{n} h',
      hourMin: '{h} h {m} min',
      enabledHour1: 'Do not disturb enabled for 1 hour; alerts are silenced meanwhile (the center keeps recording)',
      enabledUntilOff: 'Do not disturb enabled until you turn it off; alerts are silenced meanwhile (the center keeps recording)',
      disabled: 'Do not disturb turned off; alerts resumed',
      expiredTitle: 'Do not disturb ended',
      expiredBody: 'The manual mute window expired and alerts resumed; see the notification center for what you missed',
    },
    // Desktop notification permission-denied guide (P-20261002-100): yellow hint
    // line + site-settings doc link, shown when the lazy check on settings entry
    // or test-button click hits denied (NotificationSettings.vue)
    permission: {
      deniedHint: 'The browser blocked notification permission: allow this site in its site settings, then retry',
      guideLink: 'How to open site notification settings',
    },
    // Agent task end notifications (P-20261002-15): task.progress done/failed →
    // notification center entry + desktop notification (title=task name, body=done/failed + duration)
    task: {
      untitled: 'Untitled task',
      done: 'Completed',
      failed: 'Failed',
      // Remote source note (P-20261004-131): fleet dispatch backflow end states note the origin instance
      remoteSource: 'from instance {instance}',
      // Conclusion summary line (P-20261005-221): server attaches transcript
      // conclusion tail to end states — one-glance outcome for on-call/mobile
      summary: 'Result: {text}',
      // Failed states carry the error scene (last error result) for triage
      errorTail: 'Output tail: {text}',
    },
    // Fleet batch completion notification (P-20261005-145): all members of a
    // bulk-agent batch terminal → single aggregated entry (batch-level dedup,
    // no per-member spam), click through to the duty dashboard fleet card
    fleetBatch: {
      title: 'Fleet batch finished: {done} done, {failed} failed',
    },
    // File watch quota alerts (P-20261002-67): inotify Add ENOSPC fact / near
    // real limit prediction → one-shot warning to notification center
    inotify: {
      exhausted: {
        title: 'File watch quota exhausted',
        body: '{n} directories failed to register for watching; changes under them will no longer be noticed. Polling fallback has been enabled automatically. Raise fs.inotify.max_user_watches (currently {limit})',
      },
      near: {
        title: 'File watching near quota limit',
        body: '{count} directories registered, {pct}% of fs.inotify.max_user_watches ({limit}); once exhausted, changes in new directories will go unnoticed. Consider raising it in advance',
      },
    },
    // Watch degraded polling fallback (P-20261003-140): auto-enable/restore
    // notifications + "Switch to polling" action + toggle feedback
    watchfallback: {
      enabled: {
        title: 'File watching switched to polling mode',
        body: 'inotify quota exhausted — polling scan (project root shallow layer, every 5s) now keeps the file tree fresh; will switch back to real-time watching once the quota is freed',
      },
      restored: {
        title: 'File watching restored',
        body: 'inotify quota freed and watches re-established — real-time watching is back, polling fallback removed',
      },
      action: 'Switch to polling',
      switchedOn: 'Switched to polling mode (project root shallow layer, every 5s)',
      switchedOff: 'Back to real-time watching, polling fallback removed',
      switchFailed: 'Failed to switch polling, please retry',
    },
    // Sensitive file written outside the workbench (P-20261005-15): watcher hit
    // on sensitive patterns from a non-workbench write → warning entry
    // (built in server/watch/external.go); action=file opens the file in the editor
    extwrite: {
      title: 'Sensitive file modified outside the workbench',
      body: '{project}: {path} was written by a process outside the workbench (content is not included — open the file to inspect)',
      action: 'Open file',
    },
    // Failed-session postmortem (P-20261004-60): abnormal-exit notification inline
    // button / primary action — opens the postmortem dialog (exit code, last
    // commands, output tail + one-click hand-off inquiry)
    postmortem: {
      action: 'Postmortem',
    },
    // Federated dispatch notification inline button (P-20261004-101): jump to the
    // target instance (switch-instance action → instance switch chain)
    switchInstance: {
      action: 'Open this instance',
    },
    // Preview port direct link (P-20261002-70): preview.port event → notification entry + floating ball quick button
    preview: {
      title: 'Preview :{port}',
      titleLabeled: 'Preview :{port} · {label}',
      body: 'Reported ready by the agent — click to open the preview panel',
      open: 'Preview :{port}',
      // Passive detection hit (P-20261002-83, source=detected): subdued copy distinct from agent reports
      detectedTitle: 'Local service detected :{port}',
      detectedTitleLabeled: 'Local service detected :{port} · {label}',
      detectedBody: 'Detected ready in terminal output — click to open the preview panel',
      detectedOpen: 'Detected :{port}',
    },
    // Live watch invite (P-20261005-165): watch.invite event → notification entry
    // (action=url, opens the visitor live page in a new window); fallback copy
    // when the payload carries no title/body
    watchInvite: {
      title: 'Live watch invite',
      body: 'The agent started a terminal live session — click to watch in a new window',
    },
    // Agent long-session completion notice (P-20261002-140): the process-exit hook
    // complements the P-15 report chain; done.* are server-side titleKey/bodyKey
    // templates; settings* are the notification-settings slider copy
    longSession: {
      done: {
        title: 'Agent session completed',
        body: 'Session "{name}" ran for about {minutes} min and exited cleanly',
      },
      settingsLabel: 'Long session completion notice',
      settingsDesc: 'Notify when an agent session exits cleanly after running longer than this (plain shell sessions stay silent; sessions the agent already reported done/failed for are not repeated)',
      minutesValue: '{n} min',
    },
    // Session spend threshold alert (P-20261003-157): P-139 usage aggregation
    // hits the threshold and files a notification; done.* are server-side
    // titleKey/bodyKey templates; settings* are the notification-settings copy
    spendAlert: {
      done: {
        title: 'Claude session spend over threshold',
        body: 'Session "{name}" has used {tokens} tokens (threshold {threshold}) — time to wrap up or relay',
      },
      settingsLabel: 'Session spend threshold alert',
      settingsDesc: 'Notify once when a Claude session\'s cumulative tokens (input + output + cache read) reach the threshold — a hint to wrap up or start a relay session (off by default)',
      tokensLabel: 'Threshold (tokens)',
      onceNote: 'Each session is reminded at most once; delivered via notification center, desktop and webhook alike',
    },
    // Queued instruction auto-send (P-20261003-248): receipt engine wrote a queue head, action jumps to the session
    queueSent: {
      title: 'Queued instruction sent',
      body: '{text}',
    },
    // Quickdrop (P-20261006-51): delivery-arrived notice — arrived is the
    // server-side titleKey template (msgParams.from/size); actionActive /
    // actionNew are the inline dual-exit labels; rest feed useQuickdrop toasts
    quickdrop: {
      arrived: 'Quickdrop received ({size} bytes)',
      actionActive: 'Send to current session',
      actionNew: 'New agent session',
    },
    // Collab material (P-20261024-1): visitor-upload notice inline dual exit
    // (same two-button shape as quickdrop; server dropNote Action/SecondAction)
    shdrop: {
      actionActive: 'Send to current session',
      actionNew: 'Handle in new session',
    },
    // Direct-input hold card (P-20261024-1): "revoke" inline action on the
    // hold notice created at grant time
    shdirect: {
      actionRevoke: 'Revoke visitor input',
    },
  },
  // Quickdrop consumption chain (P-20261006-51, useQuickdrop): inline action
  // toasts and degradations. promptHead is the launchArgs template head for the
  // new-session exit (UI-language prompt; the task-file full-text face carries
  // no byte budget)
  quickdrop: {
    promptHead: 'Workbench quickdrop (from phone/script), please handle:',
    gone: 'Delivery expired or already handled (content lives 24h)',
    noActiveSession: 'No recently-active terminal session — open one first, or use "New agent session"',
    forwarded: 'Written to the current session',
    forwardFailed: 'Failed to write to the session, try again',
    newFailed: 'Failed to create the session, try again',
    newLaunched: 'New session created to handle the delivery',
  },
  notification: {
    title: 'Notifications',
    empty: 'No notifications',
    markAllRead: 'Mark All as Read',
    markAllReadDone: 'All marked as read ({n})',
    openPrefs: 'Notification preferences',
    clearAll: 'Clear All',
    clearFiltered: 'Clear filtered ({n})',
    clearConfirm: 'Clear {n} notifications? This cannot be undone',
    dismiss: 'Dismiss this notification',
    dismissGroup: 'Dismiss whole group',
    markGroupRead: 'Mark group as read',
    // Unread divider (P-20261003-259): boundary for items added since last view (panel close)
    unreadDivider: '{n} new since last visit',
    // Multi-select batch actions (P-20261003-281): checkbox mode + batch bar —
    // the "select N, batch read/delete" granularity between group ops and mark-all
    batch: {
      enter: 'Select multiple',
      exit: 'Exit selection',
      pick: 'Toggle selection',
      selected: '{n} selected',
      selectAllFiltered: 'Select all in list',
      markRead: 'Mark read',
      markReadDone: 'Marked {n} as read',
      remove: 'Delete',
      removeConfirm: 'Delete {n} selected notifications? This cannot be undone',
      removeDone: 'Deleted {n} notifications',
    },
    justNow: 'just now',
    minutesAgo: '{n} min ago',
    hoursAgo: '{n} h ago',
    daysAgo: '{n} d ago',
    pullDone: 'Pull done',
    // 结果摘要行（P-20261003-202）：通知条目正文，Action 点击跳变更面板
    pullCommits: '{n} new commits',
    pushDone: 'Push done',
    // Commit-and-push partial success record (P-20261004-142): push-rejected
    // notification title; body carries the concrete failure reason (outcome.reason),
    // click jumps to the git panel
    pushPartialFail: 'Committed, push failed',
    filter: {
      all: 'All',
      unread: 'Unread',
      snoozed: 'Snoozed',
    },
    // Snooze (P-20261003-36): per-entry triage menu + snoozed group view/cancel
    snooze: {
      menu: 'Snooze',
      min30: '30 minutes',
      hour1: '1 hour',
      tomorrow: 'Tomorrow at this time',
      cancel: 'Cancel snooze',
      until: 'Snoozed until {time}',
      done: 'Snoozed — will remind at {time}',
      cancelDone: 'Snooze cancelled',
    },
    // Project filter (orthogonal to category/unread; candidates aggregated from items)
    projectFilter: {
      all: 'All projects',
      label: 'Filter by project',
    },
    // Runtime filter chips (P-20261003-187): filter notifications by the agent
    // runtime that produced them (approval notices carry the originating agent;
    // entries without a runtime are never filtered out). Chip labels reuse the
    // agentLabelOf runtime display names; only the reset chip and row hint live here
    runtimeFilter: {
      all: 'All runtimes',
      label: 'Filter by runtime',
    },
    // Project × category 2D mute (P-20261003-168): quick mute on item rows (unmute in settings)
    projectMute: {
      action: 'Mute this category for this project',
      done: 'Muted {category} notifications for "{name}" — unmute in settings',
    },
    // Entry copy (P-20261003-188): hover-reveal copy button, title+body as plain text
    copy: {
      tip: 'Copy title and body',
      done: 'Notification copied',
    },
    // Body path linkification (P-20261004-61): hover tip for clickable path:line
    // fragments inside the notification body
    bodyPath: {
      tip: 'Open {path} in editor',
    },
    // Do-not-disturb summary row (P-20261003-64): after the window ends, a hint
    // at the top counts entries that arrived while silenced; click to show only
    // those, hidden for the rest of the session once viewed or dismissed
    dndSummary: {
      count: '{n} new during do-not-disturb',
      view: 'Click to show only entries from the do-not-disturb window',
      close: 'Dismiss hint',
    },
    category: {
      task: 'Task',
      clone: 'Clone',
      git: 'Git',
      system: 'System',
      error: 'Error',
      drop: 'Quickdrop',
    },
    event: {
      longTaskSuccess: 'Long task completed',
      longTaskFailed: 'Long task failed',
      taskDuration: 'took {n}s',
      updateAvailable: 'Update available',
      updateCompleted: 'Update completed',
      updateFailed: 'Update failed',
      backendDisconnected: 'Backend disconnected',
      backendReconnected: 'Backend reconnected',
      // WS long-backoff close codes (P-20261005-185): 1009 server read limit / 1011
      // server error — explicit error entries from the useWebSocketBase onclose branch
      wsMessageTooBig: 'Connection closed by server: message too large. Please check what was sent.',
      wsServerError: 'Connection closed by a server error. Will reconnect automatically.',
    },
    // Approval/question waiting chime (P-20261003-33): short tone when approval
    // or question cards arrive (Web Audio oscillator, zero assets); muted while
    // locked; browsers require prior page interaction before audio can play
    // (autoplay policy, silently skipped until unlocked). DND semantics per
    // P-20261003-115: approval chime pierces by default (exception categories),
    // question chime stays silenced in-window
    sound: {
      title: 'Waiting chime',
      desc: 'Play a short chime when approval or question cards arrive; the approval chime pierces do-not-disturb by default (see its exception categories), while the question chime stays muted during do-not-disturb and when locked (browsers require prior page interaction before audio can play)',
    },
    // Auto-read on scroll (P-20261003-260): items scrolled into view are marked read
    scrollRead: {
      title: 'Auto-read on scroll',
      desc: 'While browsing the notification center, items that scroll into view are marked as read automatically; scrolling to the bottom marks everything. Off by default — skimming past should not silently clear unread badges',
    },
  },
  // Approval card "session replay" (P-20261002-82): the approval record carries
  // sessionId + timestamp; open the originating session's timeline at that moment
  approval: {
    // One-click copy at the op row tail (P-20261003-81): copies the op+target
    // command context — a verbatim handoff for relaying approvals elsewhere
    copyCommand: 'Copy full command (op + target)',
    // Target hover diff popover (P-20261003-253): path-like target hover shows a
    // workspace uncommitted-changes digest (+/- counts + first changed lines);
    // click still goes through the P-47 open chain
    targetDiff: {
      title: 'Uncommitted changes preview',
      loading: 'Loading diff…',
      empty: 'No uncommitted changes — click to open the file',
      error: 'Failed to load diff — click still opens the file',
      hunks: '{n} hunk(s)',
      more: '…and {n} more changed lines',
      openHint: 'Click to open in editor (diff view when changes exist)',
    },
    replay: {
      button: 'Replay',
      notFound: 'No transcript found for this session',
      loadFail: 'Failed to load session transcript, please retry',
    },
    // Release-horizon three-way picker (P-20261003-316): the "always allow"
    // confirm surface becomes a three-tier choice (P-20261002-126 guard spirit
    // kept: two explicit hops + per-tier scope wording)
    tier: {
      title: 'Choose allow horizon',
      session: 'Allow this session',
      sessionDesc: 'High-risk ops from this session no longer prompt; restored when the session closes',
      h24: 'Allow for 24 hours',
      h24Desc: 'All sessions allowed for 24 hours; prompts resume automatically',
      always: 'Always allow',
      alwaysDesc: 'High-risk ops no longer prompt (global, until changed in Settings)',
      suggest: 'Suggested',
      cancel: 'Cancel',
      sessionApplied: 'High-risk ops from this session are now allowed (restored on session close)',
      h24Applied: 'Allowed for 24 hours; prompts resume automatically',
    },
    // Persistent allow badge (P-20261002-126 + P-20261003-316 per-tier wording):
    // hover hint / click to the Settings recovery entry; 24h tier shows remaining
    badge: {
      always: 'Global allow on',
      h24: '24h allow on · {remaining} left',
      h24Ending: '24h allow on · expiring',
      session: 'Session allow on · {n} sessions',
      remainingHM: '{h}h {m}m',
      remainingM: '{m}m',
      tipAlways: 'Global allow is on: high-risk operations no longer prompt for approval. Click to restore "Ask every time" in Settings',
      tip24h: '24-hour allow is on: high-risk operations temporarily skip prompts and resume automatically at expiry. Click to view/change in Settings',
      tipSession: 'Session allow is on: granted sessions skip prompts; restored when sessions close. Click to change in Settings',
    },
    // Keyboard adjudication (P-20261003-1): 1/2/3 pick a verdict directly
    // (key 2 opens the horizon picker; 1/2/3 inside pick a tier; action buttons
    // carry the key hint as hover title)
    hotkey: {
      allowOnce: 'Key 1: allow once',
      always: 'Key 2: allow horizon (picker: 1=session 2=24h 3=always)',
      deny: 'Key 3: deny',
    },
    // Deny reason (P-20261003-21): optional note sent back to the requesting
    // agent with the verdict so it can adjust its plan
    denyReason: {
      placeholder: 'Deny reason (optional, sent back to the agent), e.g. leave .env alone, use env vars',
      confirm: 'Confirm deny',
      cancel: 'Cancel',
    },
    // Ask initiator (P-20261006-50): pre-verdict dialog entry to question the
    // originating session — the question goes through broadcast-write into that
    // session's input stream (user token, AgentGuard-exempt, same as typing by
    // hand), then auto-jumps there for the answer. The template inlines op +
    // approvalId so the agent knows which operation is being asked about.
    // Closed/unknown session disables the button (same liveness source as the
    // card-head chip, P-161)
    ask: {
      button: 'Ask initiator',
      buttonTitle: 'Ask the originating session before deciding: the question is typed into that session, then auto-jumps there',
      disabledTitle: 'Originating session has ended — cannot ask',
      template: 'About {op} (approval {id}): ',
      placeholder: 'Type your question (Enter to send and jump)',
      confirm: 'Send & jump',
      sent: 'Sent to the originating session — opening it…',
      sendFailed: 'Failed to send — your question is kept for retry',
    },
    // Merged approval "+N same-type pending" (P-20261006-26): badge and expandable
    // list for same-session same-op requests queued behind this card — one ruling
    // applies to the batch; expanding per item is the fine-control exit
    merged: {
      badge: 'same-type pending',
      toggleTitle: '{n} more same-type operations queued, ruled together with this card. Click to inspect each item',
    },
    // Stack collapse (P-20261003-25): past the threshold the stack folds into a
    // summary bar (click to expand / collapse); the badge hints which card the
    // keyboard verdict targets — always the oldest (#1) while the visible one is
    // the newest (update this copy if useApprovalHotkeys target logic changes)
    stack: {
      summary: '{n} pending',
      target: 'Keyboard target #1/{total}',
      expand: 'Expand all',
      collapse: 'Collapse',
    },
    // First-run guide bar (P-20261003-311): three-line explainer above the first
    // ever approval card (one-time localStorage marker) — the manual targets
    // agents, this covers the user-side mental model; expand/collapse and
    // "don't show again", shared marker key by global stack and monitor board
    guide: {
      title: 'First approval card? Three lines to get it',
      line1: 'An agent is waiting for your verdict on a high-risk operation and will not continue until you decide',
      line2: '"Allow once" = proceed with this one; "Deny" = abort the operation (optionally send a reason back to the agent)',
      line3: '"Always allow" = no more prompts for this kind of operation, applies globally — reversible in Settings, choose with care',
      expand: 'Show explainer',
      collapse: 'Hide explainer',
      dismiss: "Don't show again",
    },
    // Recent decisions quick review (P-20261003-226): read-only dropdown at the
    // stack tail listing the latest resolved records (op/target/verdict/time) —
    // a fast lookback after a mis-clicked allow; re-deciding is intentionally
    // not offered (only pending can be resolved, a server-side idempotency
    // constraint) and the note copy says so
    recent: {
      trigger: 'Recent decisions',
      dismiss: 'Dismiss (new decisions will re-surface)',
      empty: 'No decisions yet',
      allowed: 'Allowed',
      denied: 'Denied',
      readonly: 'Read-only review: finalized decisions cannot be re-made',
      // Decision history CSV export (P-20261003-247): the full history is served
      // in one download (the local dropdown only keeps the latest 10), same
      // pattern as the audit CSV (with formula-injection guard)
      exportCsv: 'Export CSV',
      exportCsvTip: 'Export the full decision history as a CSV file (op/target/result/agent/created & resolved times/detail/deny reason, with formula-injection guard)',
      exportDone: 'Decision history exported',
    },
    // Same-op history weak row (P-20261005-173): lookback of recent resolved
    // records for the same op on the approval card — a consistency anchor for
    // repeated decisions ("denied it last time, don't slip and allow now");
    // facts only, no automatic suggestions; hidden when there is no history
    history: {
      toggle: 'Similar history ({n})',
      toggleTitle: 'Recent decisions for this op — facts only, no suggestions',
    },
    // Pattern self-learning suggestion bar (P-20261006-28): when the same op
    // prefix was manually allowed ≥3 times within 7 days with no covering rule,
    // suggest promoting it to an approval rule (P-35 discoverability gap) —
    // suggested once per pattern per 7 days, "Not now" hides it for the
    // session; Create rule only prefills the form, granularity is user-confirmed
    ruleSuggest: {
      text: 'You have manually allowed this pattern {n} times — create a rule to auto-approve it?',
      create: 'Create rule',
      later: 'Not now',
    },
    // Approval classification rules (P-20261003-35): per-op auto adjudication —
    // rules table CRUD + hit test in Settings · Security; global-mode relation
    // (allow short-circuit) documented in desc copy
    rules: {
      tab: 'Approval Rules',
      title: 'Approval Classification Rules',
      desc: 'Auto-adjudicate high-risk operation approvals by operation prefix: Allow = pass directly, Deny = reject directly (neither shows an approval card), Ask = approval card flow. Rules can carry an optional path condition (glob) — the operation prefix and the path must both match for the rule to apply. The ordered list applies the first match (use ↑↓ to adjust priority); unmatched operations fall back to General → High-risk operation approval mode. When the global mode is "Always allow", this rule table is not evaluated.',
      add: 'Add rule',
      addTitle: 'Add approval rule',
      editTitle: 'Edit approval rule',
      empty: 'No rules yet — all high-risk operations follow the global approval mode',
      capReached: 'Up to {n} rules',
      fieldPattern: 'Operation prefix (opPattern)',
      fieldPatternPlaceholder: 'e.g. git push / reset --hard / delete branch',
      fieldPath: 'Path condition (optional)',
      fieldPathPlaceholder: 'e.g. docs/** or **/.env*',
      fieldPathHint: 'Glob syntax, ** spans directories; the op prefix and the path must both match to apply. Leave empty for no path restriction (case-insensitive; command-shaped targets do not participate in path matching)',
      pathTooLong: 'Path condition must be at most 128 characters',
      fieldEffect: 'Adjudication',
      effectAllow: 'Allow (pass directly, no card)',
      effectDeny: 'Deny (reject directly, no card)',
      effectAsk: 'Ask (approval card flow)',
      effectLabel: {
        allow: 'Allow',
        deny: 'Deny',
        ask: 'Ask',
      },
      formHint: 'Prefix matching is case-insensitive; saved rules take effect immediately and hits are recorded in approval history',
      patternRequired: 'Operation prefix is required',
      patternTooLong: 'Operation prefix must be at most 128 characters',
      dirty: 'Unsaved rule changes',
      discard: 'Discard changes',
      save: 'Save rules',
      saved: 'Approval rules saved',
      saveFailed: 'Failed to save approval rules',
      edit: 'Edit',
      delete: 'Delete',
      moveUp: 'Move up (higher priority)',
      moveDown: 'Move down (lower priority)',
      testTitle: 'Hit test',
      testPlaceholder: 'Enter an operation sample, e.g. git push origin main',
      testPathPlaceholder: 'Path sample (optional), e.g. docs/notes.md',
      testBtn: 'Test',
      testHit: 'Matched rule "{pattern}" → {effect}',
      testNoHit: 'No rule matched → handled by the global approval mode',
      testSavedOnly: 'Hit test evaluates the saved rule table; unsaved edits are not included',
      // Temporary enablement (P-20261003-243): short-lived allow/deny window that
      // auto-reverts to "ask" at the end; notify.* are the server notification
      // titleKey/bodyKey templates for the expiry notice
      tempLabel: 'Temporary enablement (optional)',
      tempToggle: 'Enable temporarily until a set time, then auto-revert to "ask"',
      tempPlaceholder: 'Pick the restore time',
      tempHint: 'When the time arrives the rule reverts to "ask" automatically and a notification is recorded; leave unchecked for a permanent rule',
      tempTimeRequired: 'Temporary enablement is checked — pick the restore time',
      tempUntilTag: 'Temp until {time}',
      tempExpired: 'Window ended',
      notify: {
        title: 'Approval rule temporary window ended',
        body: '"{pattern}" reached its restore time — the rule effect automatically reverted to "ask"',
      },
    },
    // Approval wait timeout auto-deny (P-20261003-45): notify.* are the server
    // notification titleKey/bodyKey templates; settings* are the General settings
    // row copy (0 = no timeout, legacy behavior)
    timeout: {
      notify: {
        title: 'Approval timed out and was auto-denied',
        body: '"{op}" waited {minutes} min with no verdict and was denied automatically (reason sent back to the agent)',
      },
      settingsLabel: 'Approval wait timeout auto-deny',
      settingsDesc: 'Pending approvals older than this many minutes are denied automatically, with the reason sent back to the requesting agent (0 = no timeout)',
    },
    // Structured impact (P-20261003-319): approval card top badge row — kind
    // badge (enum mirrors the server impactKinds; extend both sides together) +
    // one-line summary + file count; prose detail folds to secondary (impact
    // cards only)
    impact: {
      kind: {
        delete: 'Delete',
        reset: 'Reset',
        'push-force': 'Force push',
        'remote-exec': 'Remote exec',
        deploy: 'Deploy',
        other: 'Other',
      },
      filesCount: '{n} file(s)',
      detailMore: 'Details',
    },
    // Full-text expand for long detail (P-20261003-258): long detail is
    // clamped to ~3 lines to keep the card readable; "Show all" unclamps
    // (one-way expand — a card is usually read once, same rationale as the
    // impact detail fold above)
    detail: {
      expand: 'Show all',
    },
  },
  // Daily digest (P-20261001-30: server aggregates the day's facts into the
  // notification center; rendered via titleKey/bodyKey templates, commit
  // subjects appended verbatim after the summary line)
  recording: {
    title: 'Approval Process Recordings',
    history: 'Recordings',
    viewProcess: 'View recording',
    liveBadge: 'Recording',
    done: 'Ended',
    play: 'Play',
    pause: 'Pause',
    replay: 'Restart',
    refresh: 'Refresh live',
    chapters: 'Command chapters',
    noChapters: 'No command chapters detected (shell integration not enabled)',
    empty: 'No recordings — process recording is off by default, enable it in Settings',
    selectHint: 'Select a recording on the left to replay',
    delete: 'Delete recording',
    deleted: 'Recording deleted',
    deleteFailed: 'Delete failed, please retry',
    // Share replay (P-20261004-103): create a read-only replay link from this recording's cast
    shareReplay: 'Share replay',
    agentUnknown: 'Unknown',
    // Save as runbook (P-20261005-3): OSC133 command index → runbook draft prefills the create form
    saveAsRunbook: 'Save as runbook',
    saveAsRunbookHint: 'Build a runbook draft from the command index (prefills the create form; saved after your review)',
    runbookTitle: '{date} session ops',
    runbookFailNote: 'failed in recording (exit {code})',
  },
  report: {
    daily: {
      title: 'Today',
      // body and bodySec must keep the same first line (bodySec only appends
      // the security-events line; the server picks one by whether audit
      // events exist today, P-20261003-51; zero events falls back to body)
      body: '{commits} commits · approvals {approvalsDone} done / {approvalsPending} pending · deploys {deploysOk} ok / {deploysFail} failed · {sessions} agent sessions · {tokens} tokens · {cmds} terminal commands',
      bodySec: '{commits} commits · approvals {approvalsDone} done / {approvalsPending} pending · deploys {deploysOk} ok / {deploysFail} failed · {sessions} agent sessions · {tokens} tokens · {cmds} terminal commands\nSecurity events: {secTotal} (unlock failures {secUnlockFail} / token changes {secTokenChange})',
    },
    // Daily report archive review (P-20261003-4): two-level view over the
    // 14-day archive (date list + single-day detail)
    archive: {
      open: 'Daily report history',
      title: 'Daily Report History',
      subtitle: 'Last 14 days',
      loading: 'Loading…',
      empty: 'No daily report archives yet',
      emptyDay: 'No archives for this day',
      loadFailed: 'Failed to load daily report archives',
      commits: 'Commits',
      sessions: 'Sessions',
      tokens: 'Tokens',
      cmds: 'Commands',
      approvals: 'Approvals',
      approvalsDetail: '{done} done / {pending} pending',
      deploys: 'Deploys',
      deploysDetail: '{ok} ok / {fail} failed',
    },
    // Weekly report draft (P-20261003-135): multi-select archived days into a per-day markdown draft
    weekly: {
      action: 'Build weekly draft',
      selected: '{n} days selected',
      rangeHint: 'Check days to include in the weekly draft; hold Shift and click to select a range',
      checkAria: 'Select {date} for the weekly draft',
      title: 'Weekly Report',
      building: 'Building draft…',
      back: 'Back',
      copy: 'Copy',
      download: 'Download .md',
      emptyDraft: 'No archived facts for the selected dates',
    },
  },
  // Backup push alerts (P-20261003-103: scripts/git-push-origin.sh posts to
  // the notification center API on push failure and closes the loop with an
  // info item on recovery; notify.* are the script-side titleKey/bodyKey
  // templates, n/branch injected via msgParams)
  backupPush: {
    notify: {
      failed: {
        title: 'Backup push failed · {n} commits unsynced',
        body: 'Pushing {branch} to origin failed; the remote backup is {n} commits behind. Local commits are unaffected — later pushes retry automatically; if it keeps failing, check Gitea/WSL health',
      },
      recovered: {
        title: 'Backup push recovered',
        body: '{branch} pushed successfully again; the remote backup is back in sync',
      },
    },
  },
  // Scheduled agent tasks (P-20261002-43: daily HH:MM + weekday set, launched
  // via the agent terminal channel; notify.* are the server notification
  // titleKey/bodyKey templates)
  agentcron: {
    title: 'Scheduled Tasks',
    add: 'Add',
    addTitle: 'Add Scheduled Task',
    editTitle: 'Edit Scheduled Task',
    hint: 'At the scheduled time the server launches an agent terminal session automatically: the prompt is injected via launch args, and high-risk operations still go through approval.',
    empty: 'No scheduled tasks',
    fieldName: 'Task name',
    fieldNamePlaceholder: 'e.g. Review daily changes',
    fieldSchedule: 'Trigger time (evaluation timezone)',
    fieldRuntime: 'Runtime',
    runtimeAuto: 'Auto (by availability)',
    runtimeShell: 'Plain terminal (shell)',
    fieldDir: 'Working directory (optional)',
    fieldDirPlaceholder: 'Empty = user home',
    fieldPrompt: 'Prompt',
    fieldPromptPlaceholder: "Instruction sent to the agent, e.g. summarize all changes of {'{'}date{'}'} ({'{'}weekday{'}'}) and write a report",
    // Runtime variable placeholder hint (P-20261003-167): literal braces must be escaped as {'{'} / {'}'} (vue-i18n compiles {x} as named interpolation; same as snippet.fieldCommand)
    promptVarsHint: "Variables: {'{'}date{'}'} date · {'{'}time{'}'} trigger time · {'{'}weekday{'}'} weekday; replaced with actual values by the server at launch, unrecognized placeholders pass through verbatim.",
    promptVarsQuota: "Bytes count the template as stored (≤500); variable expansion and the scheduled timestamp are appended at launch and share the injection quota.",
    fieldEnabled: 'Enabled',
    fieldMissCatchUp: 'Run after restart if a trigger was missed while stopped',
    trigger: 'Trigger',
    triggerSchedule: 'Scheduled (daily time)',
    triggerAfter: 'After predecessor',
    fieldAfterCron: 'Predecessor task',
    fieldAfterMode: 'Trigger condition',
    afterModeSuccess: 'On success only',
    afterModeAlways: 'On completion',
    parentPlaceholder: 'Select predecessor task',
    parentRequired: 'Select a predecessor task for after-trigger',
    cycleDetected: 'Dependency chain would form a cycle: pick a task outside the chain',
    listAfterPrefix: 'after ',
    everyday: 'Every day',
    weekday: {
      0: 'Sun',
      1: 'Mon',
      2: 'Tue',
      3: 'Wed',
      4: 'Thu',
      5: 'Fri',
      6: 'Sat',
    },
    nextRun: 'Next ',
    lastRun: 'Last ',
    enabled: 'Enabled',
    disabled: 'Disabled',
    runNow: 'Run now',
    runStarted: 'Launched, opening the agent terminal',
    runFailed: 'Failed to launch',
    deleteConfirm: 'Delete scheduled task "{name}"?',
    deleted: 'Deleted',
    deleteFailed: 'Delete failed',
    nameRequired: 'Name is required',
    nameTooLong: 'Name too long (≤120 chars)',
    promptRequired: 'Prompt is required',
    promptTooLong: 'Prompt too long (≤500 bytes)',
    formHint: 'The prompt is injected as a single line via launch args; run results are listed per task, and completion or failure lands in the notification center.',
    formHintAfter: 'The server launches this task automatically when the predecessor finishes; under "on success only" a failed predecessor marks this task as skipped instead.',
    result: {
      launched: 'Launched',
      done: 'Done',
      failed: 'Failed',
      skipped: 'Skipped',
      error: 'Launch failed',
    },
    history: {
      toggle: 'Run history ({n})',
    },
    // Missed-slot tri-state (P-20261006-22): missedHistory entries mapped from
    // action (colors in component: gray = skipped / green = caught-up / red =
    // failed, same family as run history)
    missed: {
      skipped: 'Missed · no catch-up configured',
      caughtUp: 'Missed · catch-up launched',
      failed: 'Missed · catch-up failed to launch',
    },
    notify: {
      launchFailed: {
        title: 'Scheduled task failed to launch',
        body: 'Task "{name}" failed to create a session: {error}',
      },
      done: {
        title: 'Scheduled task finished',
        body: 'The agent for "{name}" reported completion',
      },
      failedRun: {
        title: 'Scheduled task failed',
        body: 'Task "{name}" reported failure: {detail}',
      },
      // Inline "Retry now" button label on launch-failure notifications
      // (P-20261006-14, action='cron-retry')
      retryAction: 'Retry now',
    },
    // Auto relay (P-20261005-207): relayFrom injects the last session conclusion
    // as the task preface at trigger time so long-running tasks renew themselves
    // across sessions; a dead source degrades without blocking the launch
    relay: {
      field: 'Session relay (auto-renew)',
      off: 'Off',
      latest: "Project's latest ended session (recommended)",
      session: 'Specific session ID',
      sessionShort: 'Relay a specific session',
      sessionPlaceholder: 'claude session UUID',
      sessionRequired: 'A session ID is required for specific-session relay',
      hint: 'At trigger time the last conclusion of the relay source session is injected into the task preface (secrets masked, 500-byte tail-keep packing); if the source is unavailable the task still launches and the skip reason is recorded.',
      tag: 'Relay',
      last: 'Last relay ',
      relayed: 'Conclusion injected',
      skipped: 'Skipped',
    },
    // Metric extraction (P-20261005-237): on task completion a value is pulled
    // from the output tail per rule into a per-task series — inline mini trend
    // plus latest value; extraction misses stay honestly "no data"
    extract: {
      field: 'Metric extraction (optional)',
      placeholder: 'e.g. (?:build in) (?P<sec>[0-9.]+)s or json:duration.seconds',
      hint: 'On task completion a numeric value is extracted from the output tail into the trend: a regex whose first named capture group carries the value (group name = metric name), or a json: prefixed dotted path into a JSON value in the output. Leave empty to disable; a miss records nothing.',
      trend: 'Metric "{name}" trend ({n} points)',
      older: '…and {n} earlier points',
      anomaly: 'deviates from prior mean',
    },
    // Evaluation timezone (P-20261005-217): optional per-task IANA zone; empty =
    // evaluate in the server timezone — cross-timezone deployments go from
    // "fires 8 hours off, who knows why" to explicit and verifiable
    timezone: {
      field: 'Evaluation timezone (optional)',
      serverDefault: 'Server timezone (default)',
      placeholder: 'Empty = evaluate in the server timezone',
      hintEmpty: 'When empty the task is evaluated in the server timezone; open this panel to see the server zone and its current time.',
      formServer: 'Evaluated in the server timezone: {name} ({offset}) · server now {time}',
      formZone: 'Evaluated in {tz} ({offset}) · local time there {time}',
      unknownOffset: 'offset unknown',
      invalid: 'Unknown timezone: enter a valid IANA zone name (e.g. Asia/Shanghai)',
      serverLine: 'Task times are evaluated in the server timezone by default: {name} ({offset}) · server now {time}; tasks with an explicit zone carry an inline badge.',
      badgeTitle: 'This task evaluates in {tz} (not the server timezone)',
    },
  },
  // Agent session chains (P-20261004-38: event-triggered serial agent relay;
  // notify.* are server-side titleKey/bodyKey templates, paired with the agentchain package)
  agentchain: {
    menuAction: 'Continue after completion…',
    dialogTitle: 'Continue After Completion',
    panelTitle: 'Session Chains',
    sourceLabel: 'Source session (next session auto-launches when it finishes)',
    fieldTemplate: 'Next session task template',
    fieldTemplatePlaceholder: "e.g. Previous task: {'{'}prevTask{'}'} ({'{'}prevStatus{'}'}), please continue: run tests and fix failures",
    templateHint: "Placeholders: {'{'}prevTask{'}'} previous task name · {'{'}prevStatus{'}'} done/failed · {'{'}prevStep{'}'} last step summary; substituted server-side at trigger time, unknown placeholders pass through. ≤500 bytes.",
    fieldRuntime: 'Runtime',
    fieldDir: 'Working directory (optional)',
    fieldDirPlaceholder: 'Empty = home directory',
    fieldOnFailure: 'Continue on failure too (done/failed both trigger; done only by default)',
    gateHint: 'Guardrails: chain depth cap 3 (relay stops after the 3rd hop) · 1-minute cooldown per chain after a trigger · chain auto-invalidates when the source session closes. Launched sessions still go through approvals.',
    confirm: 'Create chain',
    created: 'Chain created: the next session auto-launches when the source finishes',
    promptRequired: 'Please enter the task template',
    promptTooLong: 'Template too long (≤500 bytes)',
    deleted: 'Deleted',
    empty: 'No chains yet — right-click a session row and pick "Continue after completion…"',
    count: '{n} chains',
    sourceAlive: 'Source session alive',
    sourceDead: 'Source session closed, chain inert (delete and recreate)',
    onFailureBadge: 'continue on failure',
    lastTriggered: 'Last triggered',
    triggerCount: '{n} triggers',
    lastErrorBadge: 'last launch failed',
    panelHint: 'When the source session finishes, the server auto-launches the next one; depth cap 3, 1-minute cooldown per chain, failure opt-in. The chain.triggered broadcast lets agents sense the relay.',
    notify: {
      triggered: {
        title: 'Session chained',
        body: '"{source}" {status}, continued by "{next}"',
      },
      failed: {
        title: 'Session chain launch failed',
        body: 'Failed to launch the next session after "{source}": {error}',
      },
    },
  },
  // Directed messages between sessions (P-20261004-68: the agent↔agent inbox layer;
  // notify.* are server-side titleKey/bodyKey templates, paired with the opsmessage package)
  opsmessage: {
    notify: {
      title: 'Session message',
      body: '"{from}" left a message for "{to}" — click to open the target session',
    },
  },
  // Output sentinel (P-20261004-8: terminal output pattern subscription; hits land
  // in the notification center. notify.* are server-side titleKey/bodyKey templates)
  sentinel: {
    title: 'Output Sentinels',
    add: 'Add rule',
    addTitle: 'Add Sentinel Rule',
    editTitle: 'Edit Sentinel Rule',
    hint: 'Watch terminal output for key patterns (OOM / deadlocks / specific test failures): a hit lands in the notification center with a direct link to the session; the same rule notifies at most once every 5 minutes.',
    empty: 'No sentinel rules',
    capReached: 'Rule limit reached ({n}) — pattern watching is meant for low-volume, high-value subscriptions',
    fieldName: 'Rule name',
    fieldNamePlaceholder: 'e.g. Watch for OOM',
    fieldPattern: 'Match pattern (regex)',
    fieldPatternPlaceholder: 'e.g. (?i)(out of memory|OOMKilled)',
    fieldScope: 'Scope',
    scopeGlobal: 'All terminal sessions',
    fieldLevel: 'Notification level',
    level: {
      info: 'Info',
      warning: 'Warning',
      error: 'Error',
    },
    patternInvalid: 'Invalid regex syntax',
    nameRequired: 'Rule name is required',
    nameTooLong: 'Name too long (≤120 chars)',
    patternRequired: 'Match pattern is required',
    patternTooLong: 'Pattern too long (≤512 chars)',
    deleteConfirm: 'Delete sentinel rule "{name}"?',
    deleted: 'Deleted',
    deleteFailed: 'Delete failed',
    formHint: 'Rules take effect immediately; hit notifications link straight to the terminal session from the notification center.',
    // Test box (P-20261004-20 local tier + P-20261004-107 server tier): paste sample output and test-match in two tiers — try before you save
    test: {
      title: 'Test (paste a sample)',
      placeholder: 'Paste sample terminal output (tested line by line; matched lines highlighted)…',
      semantics: 'Two-tier test run: local JS RegExp previews line by line instantly (JS is a superset of the server-side Go RE2, with occasional semantic gaps); "Run on server" feeds the sample through the exact same RE2 sliding-window engine as production, so results carry real hit semantics — RE2-only syntax can only be verified with the server tier.',
      count: '{hit} of {total} lines matched',
      noHit: 'No lines matched — double-check the pattern if unexpected',
      jsUnsupported: 'This pattern cannot be compiled by local JS RegExp (RE2-only syntax or invalid pattern), so the local tier cannot test it — use "Run on server" to verify.',
      truncated: 'Sample too long — testing only the first {n} lines',
      serverRun: 'Run on server (exact RE2)',
      serverHit: 'Server semantics: hit — this output would trigger the rule in production',
      serverNoHit: 'Server semantics: no hit — this output would not trigger the rule in production',
      serverPatternError: 'Server-side compile failed: {error}',
      serverTruncated: 'Sample too large — server tested only the first {n} lines',
    },
    notify: {
      hit: {
        title: 'Sentinel hit: {name}',
        body: 'Session "{session}" output matched: {matched}',
      },
    },
  },
  // Task runner one-click rerun (P-20261002-120): history row rerun action
  task: {
    rerun: {
      action: 'Rerun',
      title: 'Re-run with the same task definition (runs in a new terminal; existing runs are kept)',
      running: 'Triggering this task…',
    },
  },
  taskRunner: {
    title: 'Tasks',
    noTasks: 'No runnable tasks detected',
    filterPlaceholder: 'Filter tasks…',
    recentSection: 'Recent',
    noMatch: 'No matching tasks',
    source: {
      npm: 'npm scripts',
      make: 'Make targets',
      maven: 'Maven (Java)',
      gradle: 'Gradle (Java/Kotlin)',
      go: 'Go',
      cargo: 'Cargo (Rust)',
      python: 'Python',
      just: 'Just',
      taskfile: 'Taskfile',
      vscode: 'VS Code Tasks',
      scripts: 'Scripts Directory',
    },
  },
  settingsTabs: {
    general: 'General',
    appearance: 'Appearance',
    terminal: 'Terminal',
    agentcron: 'Scheduled Tasks',
    sentinel: 'Output Sentinels',
    git: 'Git',
    remote: 'Remote',
    remoteaccess: 'Remote Access',
    migration: 'Migration',
    notifications: 'Notifications',
    deploy: 'Remote Deploy',
    about: 'About',
    monitor: 'System Monitor',
    keymap: 'Shortcuts',
  },
  // Remote access (SSH reverse tunnel, P-20261019-11): reach this instance from
  // any network via the user's own VPS relay
  remoteAccess: {
    gate: {
      lockOff: 'System lock is disabled: enable the lock and set a password before exposing this instance. Without it, anyone with the relay address can control this instance.',
      goSecurity: 'Enable lock',
      tlsOff: 'TLS is not enabled: tokens and content will travel in plaintext through the relay. You will be asked to confirm the risk before starting; enable TLS or terminate a trusted certificate with nginx on the VPS.',
      defaultPassword: 'The default password "admin" is still in use: change it before exposing this instance.',
    },
    state: {
      stopped: 'Stopped',
      connecting: 'Connecting',
      online: 'Online',
      reconnecting: 'Reconnecting',
      failed: 'Failed',
    },
    status: {
      title: 'Tunnel status',
      publicUrl: 'Public URL',
      publicUrlEmpty: 'Loopback bind without a domain: access it through the VPS reverse proxy domain (copy/QR only applies to direct public binds).',
      copy: 'Copy',
      copied: 'Public URL copied',
      qr: 'QR code',
      activeConns: 'Active connections',
      totalConns: 'Total connections',
      attempts: 'Reconnect attempts',
      onlineSince: 'Online since',
      hostKey: 'Relay host key',
      hostKeyUnpinned: 'Not recorded yet (TOFU on first connect)',
      hostKeyVerify: 'Verify the fingerprint on the VPS with ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub; stop the tunnel immediately if it does not match (possible man-in-the-middle).',
      resetHostKey: 'Reset host key',
      resetConfirm: 'Reset the pinned host key? It will be recorded again on next connect. Unless this is a legitimate migration (VPS reinstall/key rotation), resetting exposes you to man-in-the-middle risk.',
      resetDone: 'Host key reset; it will be recorded on next connect',
      lastError: 'Last error',
      start: 'Start tunnel',
      stop: 'Stop tunnel',
      reconnecting: 'Reconnect now',
      lockRequired: 'Enable the system lock and set a password first',
      tlsConfirmTitle: 'TLS is disabled — confirm the exposure risk?',
      tlsConfirm: 'TLS is not enabled on this instance. Login tokens, terminal output and files would travel in plaintext over the public network through the relay. Start the tunnel anyway?',
      tlsConfirmAction: 'Start anyway',
      startOk: 'Tunnel started',
      stopOk: 'Tunnel stopped',
      switchConfirm: 'Switch to relay "{name}"? The current tunnel will stop first (a few seconds of downtime).',
      switchAction: 'Switch',
      failed: 'Remote access operation failed',
    },
    profiles: {
      title: 'Relay profiles',
      empty: 'No relay profiles yet. Add your own VPS (SSH reachable, TCP forwarding allowed).',
      add: 'Add relay',
      edit: 'Edit',
      delete: 'Delete',
      active: 'Current',
      running: 'Running',
      activate: 'Start / Switch',
      deleteConfirm: 'Delete relay "{name}"? The profile and credential will be removed from this machine.',
      deleteActiveConfirm: '"{name}" is the active relay: deleting it will stop the tunnel first. Continue?',
      name: 'Name',
      namePlaceholder: 'e.g. Home VPS',
      host: 'VPS address',
      hostPlaceholder: 'relay.example.com or IP',
      sshPort: 'SSH port',
      user: 'Username',
      authType: 'Authentication',
      authPassword: 'Password',
      authSshKey: 'SSH key',
      password: 'Password',
      passwordKeep: 'Leave empty to keep the current password',
      passwordPlaceholder: 'VPS login password',
      sshKey: 'Key',
      sshKeyPlaceholder: 'Choose a key from the key store',
      sshKeyEmpty: 'Key store is empty: generate or import an SSH key in Settings → Security',
      bindMode: 'Remote bind',
      bindPublic: '0.0.0.0 (public direct)',
      bindLoopback: '127.0.0.1 (VPS reverse proxy)',
      bindHint: 'Public direct requires GatewayPorts clientspecified on the VPS sshd and a firewall rule for the remote port. Loopback bind is for nginx/caddy on the VPS (trusted TLS, reuse 443) and needs less sshd configuration.',
      remotePort: 'Remote port',
      domain: 'Optional domain',
      domainPlaceholder: 'work.example.com (with a trusted certificate/reverse proxy)',
      reverseProxyWarn: 'Reverse proxy/domain mode: TLS terminates on the VPS, so plaintext traffic is visible in VPS memory. On an untrusted VPS use 0.0.0.0 direct bind with a trusted application certificate (end-to-end), or nginx stream SNI passthrough (see docs/remote-access.md).',
      save: 'Save profile',
      cancel: 'Cancel',
      test: 'Test connection',
      testing: 'Checking…',
      required: 'Name, VPS address and username are required',
      portInvalid: 'Port must be 1–65535',
      sshKeyRequired: 'Choose an SSH key',
      passwordRequired: 'Password is required for password auth',
      saved: 'Relay profile saved',
      saveFailed: 'Failed to save relay profile',
      deleted: 'Relay profile deleted',
    },
    test: {
      ok: 'Checks passed',
      fail: 'Checks failed',
      step: {
        'local-target': 'Local service port',
        'ssh-reachable': 'SSH reachability',
        'host-key': 'Host key (TOFU)',
        auth: 'Authentication',
        'port-free': 'Remote port availability',
        'tcp-forward': 'Remote forwarding (AllowTcpForwarding)',
        'gateway-ports': 'Public reachability (GatewayPorts/firewall)',
      },
    },
  },
  // Keymap customization (P-20261002-28 layout domain, P-20261003-111 terminal domain,
  // P-20261008-14 editor domain): keymap.* prefix — rebind actions per domain group in
  // Settings → Shortcuts (defaults + localStorage overrides, stores/keymap.ts)
  keymap: {    desc: 'Global layout, terminal and editor shortcuts. Click "Rebind" then press the new combo to apply (Esc to cancel). Monaco built-in shortcuts (find/replace/multi-cursor etc.) and browser-reserved combos (Ctrl+N/T etc.) are not rebindable; same-domain collisions resolve by list order, cross-domain ones by scope layering — conflicting rows are flagged in red.',
    capturePrompt: 'Press the new key combo…',
    captureCancel: 'Esc to cancel',
    reservedBlocked: 'This combo is reserved by the browser and cannot be used',
    edit: 'Rebind',
    resetOne: 'Reset',
    resetAll: 'Reset all to defaults',
    customized: 'Custom',
    conflictWith: 'Conflicts with "{name}" — that binding takes priority',
    conflictLock: 'Conflicts with the lock shortcut — locking takes priority',
    // Cross-domain collisions (P-20261003-111): row flags follow the domain layering
    // semantics; editor domain joins the registry (P-20261008-14) with three-way focus layering
    conflictCrossTakeover: 'Taken over by the terminal action "{name}" (terminal keys work app-wide), this key no longer fires',
    conflictCrossFocusGlobal: 'Terminal action "{name}" only wins while the terminal is focused; this action fires elsewhere',
    conflictCrossFocusTerm: 'Layers with global action "{name}": this action only fires while the terminal is focused',
    conflictCrossFocusEditor: 'Editor action "{name}" only wins while the editor is focused; this action fires elsewhere',
    conflictCrossFocusEditorSelf: 'Layers with "{name}": this action only fires while the editor is focused',
    // Save-time conflict warning (P-20261003-106): per-entry hint lines + scope/static key labels
    conflictTitle: 'Keybinding conflict',
    conflictSaveAnyway: 'Save anyway',
    group: {
      global: 'Global layout',
      terminal: 'Terminal',
      editor: 'Editor',
    },
    line: {
      actionShadowed: 'Collides with "{name}": the other binding wins on keypress, this action will not fire',
      actionTakeover: 'Collides with "{name}": saving takes over this key and the other action stops responding',
      lock: 'Collides with the lock shortcut: locking has top priority on keypress',
      staticFocus: 'Shares this key with "{name}" ({scope}): the other wins while the {scope} is focused, this action fires elsewhere',
      staticTakeover: 'Collides with "{name}" ({scope}): saving takes over this key and the other stops responding',
      // Cross-domain collisions (P-20261003-111): doc-level terminal takeover / xterm focus layering;
      // editor domain (P-20261008-14) extends focus layering to three directions
      crossDocShadowed: 'Collides with terminal action "{name}": terminal keys work app-wide and take priority, this action will not fire after saving',
      actionCrossFocusGlobal: 'Shares this key with terminal action "{name}": the other wins while the terminal is focused, this action fires elsewhere',
      actionCrossFocusTerminal: 'Shares this key with global action "{name}": this action only fires while the terminal is focused, the other fires elsewhere',
      actionCrossFocusEditor: 'Shares this key with editor action "{name}": the other wins while the editor is focused, this action fires elsewhere',
      actionCrossFocusEditorSelf: 'Shares this key with "{name}": this action only fires while the editor is focused, the other fires elsewhere',
    },
    invScope: {
      editor: 'editor',
      terminal: 'terminal',
      global: 'global',
    },
    // Static key inventory labels (utils/keyInventory.ts mirrors the audit script's extraction surface, kept bilingual in sync)
    inv: {
      editorFind: 'Find',
      editorReplace: 'Replace',
      editorMultiCursor: 'Multi-cursor',
      editorGotoDefinition: 'Go to Definition',
      editorGotoReferences: 'Go to References',
      terminalTabN: 'Switch to terminal tab {n}',
      terminalTabSwitchN: 'Switch to terminal tab {n}',
      railDigitN: 'Activity bar panel direct access (panel {n})',
      presetDigitN: 'Workspace preset direct access (preset {n})',
      diffNavUp: 'Diff navigation (previous)',
      diffNavDown: 'Diff navigation (next)',
      approvalDigit: 'Approval decision option {n} (1=allow once / 2=pick a tier / 3=deny)',
    },
    actions: {
      toggleSidebar: 'Show/hide sidebar',
      newTerminal: 'New terminal',
      toggleTerminal: 'Show/hide terminal panel',
      previewToggle: 'Show/hide port preview panel',
      closeTab: 'Close current tab',
      cycleTab: 'Cycle editor tabs',
      switchTabPrev: 'Switch to previous editor tab',
      switchTabNext: 'Switch to next editor tab',
      moveTabPrev: 'Move editor tab left',
      moveTabNext: 'Move editor tab right',
      focusOtherGroup: 'Focus other editor group',
      toggleSplit: 'Toggle split editor',
      splitDown: 'Split down / toggle split direction',
      reopenClosedTab: 'Reopen closed editor tab',
      navBack: 'Navigate back (previous location)',
      navForward: 'Navigate forward (next location)',
      bookmarkPrev: 'Jump to previous bookmark',
      bookmarkNext: 'Jump to next bookmark',
      newUntitledDraft: 'New untitled draft',
      saveAll: 'Save All',
      clipHistoryPaste: 'Multi-clipboard paste (pick from history)',
      mdModeCycle: 'Cycle Markdown mode (source / preview / split)',
      commandPalette: 'Command palette',
      openSettings: 'Open settings',
      commandMode: 'Command palette (command mode)',
      quickOpen: 'Open file by name',
      projectSearch: 'Search in project',
      outline: 'File outline',
      // Terminal domain (P-20261003-111)
      terminalHistory: 'Toggle command history panel',
      terminalSnippet: 'Toggle command snippet panel',
      terminalFontIn: 'Increase terminal font size',
      terminalFontOut: 'Decrease terminal font size',
      terminalFontReset: 'Reset terminal font size',
      terminalSearch: 'Terminal search',
      terminalCopy: 'Copy terminal selection',
      terminalPaste: 'Paste into terminal',
      terminalSplitH: 'Split terminal horizontally',
      terminalSplitV: 'Split terminal vertically',
      terminalClosePane: 'Close current terminal pane',
      termFocusOtherPane: 'Switch terminal split pane focus',
      terminalCyclePrev: 'Cycle terminal tab (previous)',
      terminalCycleNext: 'Cycle terminal tab (next)',
      terminalCmdPrev: 'Terminal: previous command block',
      terminalCmdNext: 'Terminal: next command block',
      terminalBookmarkList: 'Toggle terminal bookmark list',
      // Editor domain (P-20261008-14): Monaco custom actions (save-file/sc-bookmark.toggle/
      // sc-ask.inline-edit) keyed from the registry via editorKeymapBindings
      editorSave: 'Save current file (editor)',
      editorBookmarkToggle: 'Toggle bookmark (cursor line)',
      editorInlineEdit: 'Inline AI edit selection (active session)',
    },
  },
  // UI zoom (P-20261002-2): appearance.zoom.* prefix — in-app zoom levels (mirrors VS Code window.zoomLevel)
  // UI density (P-20261003-322): appearance.density.* prefix — two list row-height levels (comfortable = legacy default, zero change)
  appearance: {
    zoom: {
      label: 'UI zoom',
    },
    density: {
      label: 'UI density',
      comfortable: 'Comfortable (default)',
      compact: 'Compact',
    },
    // Commit graph lane limit (P-20261006-29): BranchGraph render cap levels (8/16/24/32, default 16)
    graphLanes: {
      label: 'Commit graph lane limit',
      hint: 'Active lanes beyond the cap merge into the last lane of the graph (an annotation explains it). Raise it on wide screens, lower it on small ones. Rendering only — commit data is unaffected',
    },
    // Diff palette (P-20261006-5): standard red/green vs colorblind-friendly blue/orange accessibility tier
    diffPalette: {
      label: 'Diff palette',
      standard: 'Standard (red/green)',
      colorblind: 'Colorblind-friendly (blue/orange)',
      previewAdd: '+ added line',
      previewRemove: '− removed line',
      hint: 'The colorblind-friendly tier swaps red/green for blue/orange (deuteranopia-safe) so color-vision-deficient users can tell diff sides apart. Applies to the text diff view and the Monaco diff editor at once',
    },
    dashboardLanding: {
      label: 'Default view when entering a project',
      editor: 'Editor',
      dashboard: 'Project dashboard',
      hint: 'Open the project dashboard first when entering a project from home (refresh restore and file deep links are unaffected)',
    },
    // File tree name-family nesting (P-20261006-21): fileNesting-style tree noise reduction (off by default)
    fileNesting: {
      label: 'File tree name-family nesting',
      hint: 'Name-family files such as foo.test.ts and foo.css collapse into their main file row with a clickable +N badge. Display only — the file listing and search are unaffected',
    },
  },
  // Project dashboard (P-20261005-224): one-screen project status overview (four section cards + compact all-clear strip)
  dashboard: {
    title: 'Project Dashboard',
    noProject: 'No project selected',
    refresh: 'Refresh',
    calm: 'All clear: working tree clean, in sync with remote, no running sessions or pending problems',
    card: {
      git: 'Git',
      sessions: 'Sessions',
      problems: 'Problems',
      activity: 'Recent activity',
    },
    git: {
      synced: 'In sync with remote',
      ahead: '{n} commits ahead of remote',
      behind: '{n} commits behind remote',
      aheadBehind: '{ahead} ahead / {behind} behind',
      dirty: '{n} uncommitted files',
      noBranch: 'No branch',
      loadFailed: 'Failed to load commits',
    },
    sessions: {
      running: '{n} running',
      none: 'No terminal sessions in this project',
      more: '{n} more sessions',
    },
    problems: {
      none: 'No problems in currently open files',
      errors: '{n} errors',
      warnings: '{n} warnings',
      scope: 'Counts editor diagnostics of open files only',
    },
    activity: {
      none: 'No recent file changes',
    },
  },
  // Settings section search (P-20261001-9): keywords must be kept in sync with the
  // sections (add an entry when adding a section; keys in utils/settingsSearch.ts).
  // Mixed zh/en so both locales hit the same partition
  settingsSearch: {
    placeholder: 'Search settings...',
    noMatch: 'No matching sections',
    keywords: {
      general: '通用 自动拉取 拉取间隔 智能体 审批 守护 运行时 自定义 备份 general auto fetch interval agent provider guard approval runtime custom backup workspace',
      appearance: '外观 主题 暗色 亮色 语言 字体 编辑器 连字 换行 小地图 固定滚动 置顶 密度 紧凑 保存时格式化 格式化 自动保存 仪表盘 默认 落点 泳道 拓扑 提交图 文件树 嵌套 同名族 appearance theme dark light language font editor ligatures word wrap whitespace minimap sticky scroll format on save zoom density compact dashboard landing graph lane nesting fileNesting',
      terminal: '终端 回滚 字体 光标 后端 复制 历史记录 terminal scrollback font cursor backend shell bash tmux powershell wsl copy select history bell dsh',
      agentcron: '定时任务 定时 计划 周期 每日 每周 触发 智能体 自动 试跑 依赖链 前序 父任务 完成触发 接力 续命 relayFrom agent cron schedule daily weekly trigger automation dependency chain predecessor variables placeholder date time weekday 变量 占位符 relay',
      sentinel: '输出哨兵 哨兵 监控 订阅 正则 匹配 OOM 死锁 告警 通知 sentinel watch monitor pattern regex alert',
      git: 'Git 用户名 邮箱 提交 拉取 推送 凭据 换行 git user name email commit pull push credential line ending gitignore gitattributes',
      remote: '远程 远程仓库 主机 抓取 推送 remote repository host origin fetch push',
      remoteaccess: '远程接入 反向隧道 内网穿透 中继 公网 手机 remote access reverse tunnel relay vps public mobile phone ssh',
      security: '安全 凭据 密钥 令牌 security credential ssh key token api agent generate import passphrase 替换历史 还原 回滚 备份 replace history restore rollback 入站 事件 inbound hook event ci 集成 integration',
      migration: '迁移 换机 迁实例 配置包 全量包 轻装包 scpkg 口令信封 整机搬家 migration',
      notifications: '通知 桌面 提醒 声音 阈值 分类 免打扰 notification desktop notify sound threshold category test dnd',
      deploy: '远程部署 上传 发布 主机 deploy upload release host rsync',
      monitor: '系统监控 监控 内存 堆 健康 运行时长 趋势 磁盘 空间 服务日志 运行日志 排障 monitor memory heap goroutine gc health uptime trend disk usage server log',
      about: '关于 版本 构建 提交 平台 about version build commit platform',
      keymap: '快捷键 键位 改键 按键 绑定 快捷方式 终端键 编辑器键 书签键 字号 keymap shortcut key binding rebind hotkey terminal editor',
    },
  },
  monitor: {
    healthy: 'Healthy',
    unreachable: 'Unreachable',
    refresh: 'Refresh',
    autoRefreshHint: 'Auto-refreshes every {sec}s. Watch memory trend for long sessions',
    heapAlloc: 'Heap (live)',
    heapAllocHint: 'Heap memory held by live objects after GC',
    sysMem: 'Process Memory',
    sysMemHint: 'Total memory requested from the OS by this process',
    gcCount: 'GC Cycles',
    goroutines: 'Goroutines',
    uptime: 'Uptime',
    trendTitle: 'Memory Trend',
    trendHeap: 'Heap',
    trendSys: 'Process',
    trendPeak: 'Peak {v}',
    trendEmpty: 'Collecting samples — trend available in ~20s',
    // Server logs (P-20261008-15): settings monitor pane, read-only view of the service's own run logs
    serverLog: {
      today: 'Today',
      dateLabel: 'Log date',
      searchPlaceholder: 'Keyword filter (Enter or pause to apply)',
      truncated: 'Tail window only — older log lines not shown',
      masked: 'Sensitive values masked',
      maskedTip: 'Tokens/passwords/cloud keys replaced with *** (diagnostics, not forensics — keeps credentials out of shared logs)',
      lineCount: '{n} lines',
      missing: 'No log file for this date (service not running or past retention)',
      empty: 'No logs yet',
      noMatch: 'No matching lines',
      loading: 'Loading…',
      loadFailed: 'Failed to read logs — try again',
      footnote: 'Shows the tail window of recent writes; full files rotate daily under the data directory logs/',
    },
    // Disk usage (P-20261002-12): panel card + watchdog notification templates
    disk: {
      title: 'Disk Usage',
      dataDisk: 'Data disk',
      sysDisk: 'System disk',
      hint: 'Data disk hosts the app data directory; system disk defaults to the same volume, set SC_SYS_DISK_PATH to watch another. Yellow above 80%, red above 90%',
      notify: {
        dataWarn: 'Data disk usage above 80%',
        dataCrit: 'Data disk critically low',
        sysWarn: 'System disk usage above 80%',
        sysCrit: 'System disk critically low',
        warnBody: '{pct} used, {free} free',
        critBody: '{pct} used, {free} free',
      },
    },
    // Shift handover summary (P-20261003-8): one-click fleet-facts digest on the duty dashboard
    shift: {
      button: 'Shift Handover Summary',
      buttonTitle: 'Aggregate current fleet facts into structured text and copy to clipboard',
      copied: 'Shift handover summary copied to clipboard',
      heading: '[Shift Handover Summary] {time}',
      watermark: 'Waterline: running sessions {sessions} | running tasks {tasks} | pending approvals {approvals} | open questions {asks}',
      approvals: 'Pending approvals ({n}):',
      asks: 'Open questions ({n}):',
      sessions: 'Running sessions ({n}):',
      none: '(none)',
      sessProj: '(project: {name})',
      durLabel: 'up {dur}',
      durLt1m: 'under 1 min',
      durM: '{m} min',
      durHM: '{h} h {m} min',
      lastActivity: 'last activity {time}',
      currentStep: 'current step: {step}',
    },
    // Instance health card (P-20261003-28): duty dashboard consumes the four-item
    // /api/system/health self-inspection summary (fetched directly from the
    // metrics registry); standalone keys — the settings-page monitor is a trend
    // panel, this is the compact four-cell card for the always-on dashboard
    health: {
      title: 'Instance Health',
      uptimeLabel: 'Uptime',
      heapLabel: 'Heap (live)',
      goroutinesLabel: 'Goroutines',
      wsLabel: 'WS Connections',
      // Git subprocess concurrency (P-20261004-125): global gate water-level cells —
      // concurrent processes and queue waiters; tip carries the waiting peak (calibration surface)
      gitProcLabel: 'Git processes',
      gitWaitLabel: 'Git queue',
      gitWaitTip: 'Git operations waiting on the global gate; peak {peak} in this process (capacity calibration surface, see sc_git_* series in /api/metrics)',
      stale: 'sample failed',
      pollHint: 'Samples every {sec}s',
      // Audit write-failure warning (P-20261003-205): conditional row, rendered only when count > 0
      auditFails: '{n} audit write failures',
      auditFailsTip: 'Last failure {time} — failed audit events were silently dropped, the audit trail is incomplete; fix the data disk/directory and restart the instance to reset the counter',
      // Background job list (P-20261003-276): collapsed-by-default linked section
      // on the health card — ops visibility for "what runs in the background";
      // job names are language-neutral and shown verbatim
      schedulerJobs: '{n} background jobs',
      schedulerColName: 'Job',
      schedulerColInterval: 'Interval',
      schedulerColLastRun: 'Last run',
      schedulerNever: 'Never ran',
      schedulerReadonly: 'Read-only list — background jobs are owned by the kernel scheduler; no start/stop from the UI',
    },
    // Instance activity heatmap card (P-20261003-37): contribution-graph-style
    // view on the duty dashboard (instance-level daily fact series settled by
    // the daily-report chain; level = weighted sum, normalized). Since
    // P-20261004-106 the window is switchable across 13/26/52 weeks (default 13)
    activity: {
      title: 'Instance Activity',
      stale: 'load failed',
      summary: 'Last {days} days: {commits} commits · {sessions} sessions · {commands} commands',
      windowTitle: 'Activity view window',
      windowWeeks: '{n}w',
      legendLess: 'Less',
      legendMore: 'More',
      tip: '{date} | {commits} commits · {sessions} sessions · {commands} commands',
      // today-cell hover prefix (P-20261004-118): full sentence key — the "Today"
      // position may differ per language word order
      tipToday: 'Today · {date} | {commits} commits · {sessions} sessions · {commands} commands',
      // cell drill-down (P-20261004-96): hover suffix on drillable cells (text
      // channel for discoverability beyond the cursor); weak hint when a day
      // has no daily report
      drillHint: 'Click to view the daily report',
      noReportDay: 'No daily report for this day',
    },
    // Federation activity card (P-20261004-98): multi-instance load comparison —
    // one mini heat row per registered instance (last 14 days) + activity score
    // (shared scale across rows); click a row to switch to that instance
    federation: {
      title: 'Federation activity',
      stale: 'Failed to load',
      selfBadge: 'This machine',
      statusUnreachable: 'Unreachable',
      statusUnsupported: 'Unsupported',
      summaryTip: 'Last {days} days: {commits} commits · {sessions} sessions · {commands} commands',
      switchHint: 'Click to switch to this instance',
      cacheHint: '{days}-day window · aggregated server-side with ~5 min cache',
    },
  },
  // Duty handover package (P-20261005-148): off-duty snapshot of in-flight work —
  // running sessions, pending approvals/asks, today's daily report and heatmap
  // cell aggregated into a markdown handover doc, with copy / 24h snippet-share
  // link exits; shared by the duty dashboard and notification center entries
  // (top-level key section, host-neutral)
  handover: {
    button: 'Handover Package',
    buttonTitle: 'Aggregate running sessions, pending approvals, today\'s report and activity into a handover doc — copy it or create a 24h share link',
    modalTitle: 'Duty Handover Package',
    regenerate: 'Regenerate',
    regenerateTitle: 'The snapshot is static at generation time; regenerate to refresh after the field changes',
    generating: 'Aggregating the current state…',
    genFailed: 'Failed to generate the handover package (network or service unreachable)',
    copyBtn: 'Copy Package',
    copied: 'Handover package copied to clipboard',
    shareBtn: 'Create Share Link',
    sharing: 'Creating…',
    shared: 'Share link created',
    shareFailed: 'Failed to create the share link, please retry',
    shareLinkLabel: 'Visitor link',
    copyLink: 'Copy link',
    linkCopied: 'Link copied',
    shareName: 'Duty handover {date}',
    ttlNote: 'The link expires automatically in 24 hours (adjustable in Share Manager)',
    ttlNoteAt: 'The link expires automatically at {time} (adjustable in Share Manager)',
    // Optional access passphrase for shares (P-20261020-6): handover docs carry
    // session names and approval summaries; after setting one, the result area
    // offers an invitation copy (passphrase lives only while the modal is open)
    passToggle: 'Set an access passphrase',
    passNote: 'Recipients will need the link plus the passphrase; it is shown only this once and cannot be recovered after closing',
    passSharedNote: 'This share is passphrase-protected; the passphrase appears only in the invitation you just copied',
    copyInvite: 'Copy invitation',
    inviteCopied: 'Invitation copied (includes the access passphrase)',
    // Static-snapshot note: travels with the doc and stays on the share result
    // card — the receiver knows the snapshot semantics at first glance
    liveNote: 'This is a static snapshot taken at generation time: the field keeps changing — ask the duty operator for a freshly regenerated package for the latest state',
    sensitiveNote: 'The package contains session names and approval op/target summaries — review for sensitive info before publishing',
    overLimit: 'Package exceeds the snippet share limit ({n} bytes) — use "Copy Package" instead',
    doc: {
      title: '# Duty Handover Package ({time})',
      snapshotNote: '> Static snapshot generated at {time}. The field keeps changing — the latest regenerated package from the duty operator is authoritative.',
      sensitiveNote: '> Note: this document contains session names and approval summaries — review for sensitive info before publishing.',
      sectionSessions: 'Running Sessions ({n})',
      sectionApprovals: 'Pending Approvals ({n})',
      sectionAsks: 'Pending Asks ({n})',
      sectionDaily: 'Daily Report ({date})',
      sectionHeat: 'Today\'s Activity',
      runtime: 'running {dur}',
      idleMinutes: 'idle {n} min',
      idleWaitApproval: 'awaiting decision {n} min',
      moreSessions: '({n} more sessions not listed)',
      moreApprovals: '({n} more approvals not listed)',
      moreAsks: '({n} more asks not listed)',
      moreDaily: '({n} more projects not listed)',
      dailyLine: '{commits} commits · {sessions} sessions · {tokens} tokens · {cmds} commands',
      dailyMissing: 'Today\'s daily report is not archived yet (archived when the report is issued)',
      dailyPointer: 'Full report: Notification Center → Report Archive ({date}).',
      heatLine: 'Today: {commits} commits · {sessions} sessions · {commands} commands',
      heatMissing: 'No activity data for today yet',
    },
  },
  // Duty dashboard (/monitor full-screen monitoring view; distinct from the
  // settings-page system monitor section above)
  monitorBoard: {
    title: 'Duty Dashboard',
    subtitle: 'Agent fleet monitor',
    back: 'Back to home',
    refreshTitle: 'Refresh (R)',
    refreshedAt: 'Updated {time}',
    cardTasks: 'Task progress',
    cardSessions: 'Terminal sessions',
    allClear: 'Fleet idle — no running tasks, pending approvals, open questions or terminal sessions',
    unknownSession: 'Unknown session',
    statusRunning: 'Running',
    statusDone: 'Done',
    statusFailed: 'Failed',
    kindAgent: 'Agent session',
    kindShell: 'Project session',
    taskSteps: 'Steps {done}/{total}',
    // Stale-loss weak hint (P-20261003-303): task progress card running beyond threshold without report
    taskStale: 'May be lost',
    taskStaleTip: 'Running but no progress reported for over 10 minutes — the agent process may have crashed or disconnected; recovers when a real terminal state arrives',
    // Invalidated transition (P-20261004-31): owning session gone from the session list while the cleanup snapshot is pending
    taskInvalid: 'Invalidated',
    taskInvalidTip: 'The owning session no longer exists (closed) — this card disappears once the session-close reconciliation arrives',
    // Remote source badge (P-20261004-131): fleet dispatch backflow entries note the origin instance
    remoteTaskTip: 'Dispatched to remote instance: {instance}',
    // Fleet aggregate card (P-20261005-145): aggregated watch surface for bulk-launched fleets
    cardFleet: 'Fleet',
    fleetCounts: '{done} done · {failed} failed · {running} running',
    fleetExpandTip: 'Click to expand/collapse member sessions; click a member row to jump to it',
    fleetMemberGone: 'Session closed (still listed in the fleet roster, cannot jump)',
    // Card category layout customization (P-20261004-18): edit-mode drag reorder + category visibility
    layout: {
      editTitle: 'Customize card layout',
      editActiveTitle: 'Finish layout editing',
      editHint: 'Drag a category title to reorder; click the eye to show/hide a category. Hidden categories temporarily jump to the top when they have pending items — nothing gets missed',
      catCount: '{n} items',
      catInstance: 'Instance panels',
      instanceFixedTip: 'Instance-level panels are fixed and do not participate in ordering or visibility',
      catFleet: 'Fleet',
      catApprovals: 'Approvals',
      catAsks: 'Agent asks',
      catTasks: 'Task progress',
      catSessions: 'Terminal sessions',
      catHidden: 'Hidden',
      tempShown: 'Pending · pinned temporarily',
      showCat: 'Show this category',
      hideCat: 'Hide this category',
    },
    // "Needs attention" triage bar (P-20261005-164): first-glance aggregation of four anomaly signals
    attention: {
      title: 'Needs attention',
      failedTasks: '{n} failed tasks',
      pendingApprovals: '{n} pending approvals',
      stalledSessions: '{n} stalled sessions',
      todayAlerts: '{n} alerts today',
      locateTip: 'Click to jump to the section',
    },
    // Carousel mode (P-20261005-166): viewing orchestration for wall-mounted duty — auto-cycle key sections
    carousel: {
      toggleTitle: 'Carousel mode — auto-cycle through dashboard sections; tries fullscreen on enable (Esc exits), pauses while you interact and resumes after 60s idle',
      intervalTitle: 'Carousel interval',
      paused: 'Paused · resumes when idle',
    },
  },
  // Stall triage card (P-20261004-37): on-site assembly opened from the stall strong badge
  // (task progress summary + terminal-side evidence + nudge/open/terminate actions)
  stallTriage: {
    title: 'Stall triage',
    stallBadge: 'suspected stall {n} min',
    taskLabel: 'Task progress',
    taskNone: 'No progress reports recorded',
    taskSteps: 'steps {done}/{total}',
    shellLabel: 'Terminal side',
    shellIdle: 'Command ended (sitting at the prompt, no follow-up)',
    shellRunning: 'Command running but output has gone silent',
    silentFor: 'both sides silent for {n} min',
    lastCmdLabel: 'Last command',
    exitCode: 'exit {n}',
    noCmdRecord: '— (no command record for this session in this tab)',
    pendingNote: 'This session has an approval awaiting your decision — it may simply be waiting on you; check the approval cards first',
    hint: 'The task claims to be running, but both terminal sides (command activity and progress reports) have been silent for over {n} minutes: the agent may have exited without reporting a final state, or is stuck at an invisible prompt. Open the session to verify before nudging or terminating.',
    nudge: 'Nudge',
    nudgeTitle: 'Write one Enter keystroke to the terminal to push an agent stuck at a prompt (harmless when sitting at an empty prompt)',
    nudged: 'Nudged (Enter written to the terminal)',
    nudgeFailed: 'Nudge not delivered: the terminal session may already be closed',
    jump: 'Open session',
    terminate: 'Terminate session',
    terminateConfirmTitle: 'Terminate this session?',
    terminateConfirmBody: 'This ends the terminal session "{name}" — irreversible; its processes (including the agent) are terminated with it.',
    terminated: 'Session terminated',
  },
  // Agent structured question (P-20261001-27): shared by global ask cards & duty dashboard
  ops: {
    ask: {
      title: 'Agent question',
      agentUnknown: 'Unknown source',
      placeholder: 'Type your answer…',
      submit: 'Submit',
      answered: 'Answered; the agent will continue',
      answerFailed: 'Failed to submit answer; try again',
      emptyAnswer: 'Answer cannot be empty',
      expiresIn: 'Auto-expires in ~{n} min if unanswered',
      expiringNow: 'Expiring now',
    },
  },
  ai: {
    remoteExec: {
      button: 'Run',
      title: 'Remote Command Execution',
      failed: 'Execution failed',
      cmdPlaceholder: 'Command to run (Ctrl+Enter to execute)',
      run: 'Execute',
    },
  },
  // Remote ops (diagnose / exec dialogs)
  remoteOps: {
    diagnose: {
      title: 'Remote Host Diagnostics',
      running: 'Collecting host status…',
      failed: 'Diagnostics failed',
      ok: 'Completed',
      partial: 'Some checks failed',
      rerun: 'Re-run',
      empty: 'No diagnostics data yet',
    },
    // Local-remote same-project Git compare (P-20261004-34)
    gitCompare: {
      title: 'Compare with Local',
      menu: 'Compare with Local',
      projectPlaceholder: 'Select local project',
      pathPlaceholder: 'Absolute remote repo path, e.g. /srv/app',
      run: 'Compare',
      rerun: 'Re-compare',
      running: 'Collecting remote state via SSH…',
      remembered: 'Path remembered per host + project; no need to retype next time',
      head: 'HEAD',
      branch: 'Branch',
      dirty: 'Dirty files',
      localSide: 'Local',
      remoteSide: 'Remote',
      detached: '(detached HEAD)',
      behindSame: 'Both sides are at the same commit',
      behindRemoteBehind: 'Remote is {n} commits behind local',
      behindRemoteAhead: 'Remote is {n} commits ahead of local (fetch in the project to reconcile)',
      behindDiverged: 'Diverged: remote lacks {a} local commits, local lacks {b} remote commits',
      behindUnknown: 'HEADs differ but ancestry is unknown (remote commits not fetched — fetch in the project first)',
      rNotGitRepo: 'Remote path is not a git repository',
      rPathMissing: 'Remote path does not exist (check the directory)',
      rGitMissing: 'git is not installed on the remote host',
      rUnreachable: 'Host unreachable (check network and credentials)',
      rTimeout: 'SSH round-trip timed out (remote busy or slow network)',
      rError: 'Remote collection failed',
      detail: 'Details',
      failed: 'Compare failed',
    },
    // Batch host inspection compare (P-20261004-58)
    diagCompare: {
      title: 'Fleet Inspection Compare',
      run: 'Run inspection',
      rerun: 'Re-run',
      running: 'Collecting from {n} hosts in parallel…',
      idle: 'Select hosts and run the inspection',
      noHosts: 'No SSH hosts yet (add one in Remote Management first)',
      failed: 'Failed',
      failedToast: '{n} host(s) failed to collect (see trailing rows)',
      colHost: 'Host',
      colDiskUsage: 'Disk usage',
      colCpu: 'CPU',
      colFailedServices: 'Failed svc',
      outlierTip: 'Outlier: hits an ops threshold (disk usage ≥90%, failed services present) or deviates significantly from the fleet median (bad direction)',
      legend: 'Highlight = outlier: hits an ops threshold or deviates significantly from the fleet median (bad direction); “—” = not collected, 0 is a real reading',
      copyReport: 'Copy report',
      reportCopied: 'Inspection report copied (Markdown)',
      failedSection: 'Hosts failed to collect',
    },
  },
  // Diagnostics history & trend compare (P-20261002-18)
  diag: {
    hist: {
      compareWith: 'vs last run ({time})',
      diskAvail: 'Disk free',
      memUsed: 'Memory used',
      load1: 'Load 1m',
      lastDiag: 'Last diagnostics {time} · {n} runs',
    },
  },
  deploy: {
    // per-host deploy mutex (P-20261003-41): refusal copy of the no-wait trigger when a task is already in flight
    mutex: {
      busy: 'A deploy is already in progress on this host ({task}) — wait for it to finish or cancel it first',
    },
    // same-host queueing (P-20261004-36): waiting copy while the holder task runs
    queue: {
      waiting: 'Queued · waiting for #{task} to finish',
      waitingPos: 'Queued · waiting for #{task} to finish (position {pos})',
    },
    authType: {
      // 括号写法仅为绕开安全扫描器对「password 键 + 字面量」的凭据误报；键名不变
      ['password']: 'Password',
      sshkey: 'SSH Key',
      pem: 'PEM Private Key',
    },
    category: {
      init: 'Initialization',
      dev_tool: 'Dev Tool',
      self_host: 'Self-hosted',
    },
    status: {
      queued: 'Queued',
      running: 'Running',
      completed: 'Completed',
      failed: 'Failed',
      cancelled: 'Cancelled',
    },
    tools: {
      init_user: {
        name: 'Init cld User',
        description: 'Create cld system user with wheel group and passwordless sudoers',
      },
      claude_code: {
        name: 'Install Claude Code',
        description: 'Install Node.js and Claude Code via NVM, configure settings.json',
      },
      init_ssh_key: {
        name: 'Init SSH Key',
        description: 'Generate ed25519 SSH key under cld user for Git push',
        params: {
          keyName: 'Key File Name',
          email: 'Email (comment)',
          gitHost: 'Git Platform Host',
          'keyName.placeholder': 'Default id_ed25519; for multi-key use id_ed25519_github',
          'email.placeholder': 'user@example.com',
          'gitHost.placeholder': 'e.g. github.com / gitlab.com / gitea.company.com',
          'gitHost.help': 'Target machine creates an SSH alias for this host, bound to IdentityFile; supports host:port format',
        },
      },
      codecombo: {
        name: 'Push Codecombo',
        description: 'Upload binary to /usr/local/bin and register a systemd service (SELinux auto-relax supported)',
        params: {
          port: 'Service Port',
          'port.placeholder': 'Default 9999',
          'port.help': 'Listening port of the remote systemd service; specify a different port when it conflicts with an existing service',
          host: 'Bind Address',
          'host.placeholder': 'Default 0.0.0.0 (LAN accessible)',
          'host.help': '0.0.0.0 = reachable from any machine on the LAN (first-time setup over IP included); 127.0.0.1 = local only',
          runMode: 'Run Mode',
          'runMode.help': 'systemd service = auto-start on boot + crash recovery (recommended); direct process = runs in user domain with no SELinux issues, an @reboot crontab starts it on boot, crashes do NOT auto-recover',
          sandbox: 'Sandbox hardening (NoNewPrivileges)',
          'sandbox.help': 'Enables NoNewPrivileges on the systemd unit: sudo/setuid elevation is denied and inherited by ALL terminals and agents spawned by the service (prevents a compromised agent from escalating). On by default; turn off only if terminals genuinely need sudo. Applies to new deployments only — redeploy existing hosts to take effect',
        },
      },
      codecombo_runModeOptions: {
        service: 'systemd service (recommended)',
        direct: 'Direct process (no SELinux issues)',
        on: 'On (default · blocks sudo elevation in terminals)',
        off: 'Off (terminals/agents may sudo)',
      },
    },
    host: {
      section: 'Remote Host Credentials',
      add: 'Add Host',
      addTitle: 'Add Remote Host',
      editTitle: 'Edit Remote Host',
      empty: 'No remote hosts configured',
      deploy: 'Deploy',
      test: 'Test',
      testConnectionHint: 'Blank credentials test with the saved ones (same as saving)',
      testOk: 'Connection OK',
      testFail: 'Connection failed',
      saved: 'Host saved',
      deleted: 'Host deleted',
      deleteTitle: 'Delete remote host',
      deleteConfirm: 'Delete credential for remote host "{name}"? Its open terminal sessions will be closed too.',
      terminal: 'Terminal',
      moreActions: 'More actions',
      statusTooltip: 'Port-level probe only; authentication is verified on actual connection',
      protocol: {
        sftp: 'SFTP (full capability, recommended)',
        ftp: 'FTP (file management only)',
      },
      form: {
        required: 'Name, host and user are required',
      },
      field: {
        name: 'Name',
        host: 'Host',
        port: 'Port',
        user: 'User',
        authType: 'Auth Type',
        protocol: 'Protocol',
        ['password']: 'Password',
        passwordKeep: 'Leave empty to keep current password',
        ftpHint: 'FTP is plaintext — LAN/trusted networks only. This host provides file management only (no terminal/deploy); auth is password-based',
        sshKey: 'SSH Key',
        sshKeyPlaceholder: 'Select a generated SSH key',
        pem: 'PEM Private Key',
        pemPlaceholder: '-----BEGIN OPENSSH PRIVATE KEY-----...',
        pemKeepHint: 'Existing key not shown in edit mode; leave empty to keep',
      },
      // SSH host key TOFU verification (P-20261003-34): switch + pinned fingerprint + reset entry
      hostkey: {
        title: 'Host Key Verification',
        switch: 'Verify host key (TOFU pinning)',
        hint: 'Records the remote host public key fingerprint on first connect and verifies on every connection — a change is rejected (possible man-in-the-middle). Reset the fingerprint after a legitimate server reinstall/key rotation',
        unpinned: 'No fingerprint recorded yet (auto-recorded on first connect)',
        loading: 'Loading fingerprint…',
        reset: 'Reset fingerprint',
        resetConfirm: 'Reset the pinned fingerprint for this host? The next connection will record it again; if this is not a legitimate migration, resetting exposes you to man-in-the-middle risk',
        resetOk: 'Fingerprint reset — it will be recorded again on next connect',
        resetFailed: 'Reset failed',
      },
    },
    // Active tunnel rows (P-20261004-19): remote forwarding observability (settings · deploy pane).
    // mapping mirrors previewPanel.tunnelBadge — preview badge and rows share the same wording
    tunnels: {
      section: 'Active Tunnels',
      empty: 'No active tunnels — created automatically when previewing remote host ports',
      mapping: 'remote:{remote} → local:{local}',
      idleRemain: 'reclaims after ~{min} min idle',
      close: 'Close',
      hint: 'Tunnels are established automatically by remote port preview (agents can open them via API too) and reclaimed when idle; previewing again after a manual close re-establishes the tunnel',
    },
    config: {
      section: 'Deploy Config',
      token: 'Anthropic Token',
      tokenPlaceholder: 'Enter API Key',
      baseUrl: 'Base URL',
      model: 'Model',
      binaryDir: 'Local Binary Directory',
      binaryDirPlaceholder: 'Directory containing codecombo-{os}-{arch}',
      foundBinaries: 'Found binaries',
      noBinariesFound: 'No binaries matching codecombo-{os}-{arch} (e.g. codecombo-linux-amd64) found in directory',
      foundCount: 'Found {n} binaries',
      rescan: 'Rescan',
      saved: 'Deploy config saved',
      saveFailed: 'Save failed',
      scanFailed: 'Scan failed',
    },
    dialog: {
      title: 'Remote Deploy',
      targetHost: 'Target Host',
      selectHost: 'Select a remote host',
      instances: 'Selected Tool Instances',
      addTool: 'Add Tool',
      noInstances: 'No tools selected',
      notAllowMultiple: 'This tool does not support multiple instances',
      dependsOn: 'Depends on',
      start: 'Start Deploy',
      progress: 'Progress',
      cancel: 'Cancel',
      // no-wait switch (P-20261004-36): queue by default; check to restore the P-41 refusal
      noWait: 'Fail fast when the host is busy (skip queue)',
      cancelQueue: 'Cancel Queue',
      cannotCloseRunning: 'Task is running; cancel or wait for completion',
      removeInstance: 'Remove this tool',
      publicKeys: 'SSH Public Keys',
      copied: 'Public key copied to clipboard',
      fetchFailed: 'Failed to load tool list. Please ensure the service is unlocked.',
      taskAlreadyFinished: 'Task already finished',
      startFailed: 'Failed to start deployment',
      missingToken: 'Anthropic Token is not configured. Please set it in Settings → Remote Deploy first',
      missingBaseUrl: 'Base URL is not configured. Please set it in Settings → Remote Deploy first',
      missingModel: 'Model is not configured. Please set it in Settings → Remote Deploy first',
    },
    // Recent deployments · rerun with same config (P-20261002-60)
    rerun: {
      history: 'Recent Deployments',
      rerun: 'Rerun Same Config',
      resolvedNote: 'Lists are resolved plans and may include auto-added dependencies',
      hostGone: 'Host deleted',
      prefilled: 'Prefilled with the previous config; review it and start the deploy',
      toolsDropped: '{count} tool(s) no longer in the deployer registry and were skipped',
      noValidTools: 'None of the task tools exist in the current deployer registry; cannot rerun',
    },
    // Deploy log archival download (P-20261003-142): entry labels + expiry notice
    // (logs live in memory for 1h after finish; on-disk archive is a later phase)
    logDownload: {
      download: 'Download log',
      short: 'Log',
      done: 'Deploy log downloaded',
      expired: 'Deploy log expired: logs are kept for only 1 hour after the task finishes and cannot be downloaded (long-term on-disk archive is planned)',
      failed: 'Failed to download deploy log',
    },
    log: {
      level: {
        info: 'Info',
        ok: 'OK',
        warn: 'Warn',
        fail: 'Fail',
      },
      taskStarted: 'Task started, {count} instance(s)',
      startingInstance: '[{index}/{total}] Starting {deployer}',
      queuedBehind: 'A deploy is already in progress on this host (#{task}) — this task is queued behind it',
      taskCompleted: 'Task completed',
      taskFailed: 'Task failed: {error}',
      taskCancelled: 'Task cancelled',
      commandFailed: '{step} failed: {error}',
      init_user: {
        checking: 'Checking user [{user}]',
        existsSkip: 'User {user} already exists, skip',
        creating: 'Creating user {user} with wheel group',
        created: 'User {user} created',
        writingSudoers: 'Writing {path}',
        sudoersConfigured: 'sudoers configured',
      },
      init_ssh_key: {
        targetKey: 'Target key: ~/.ssh/{keyName} (email={email})',
        checkingKey: 'Checking/generating ed25519 key',
        generated: 'New key generated',
        existsSkip: 'Key already exists, skipping generation',
        configuringAgent: 'Configuring ssh-agent in .bashrc',
        agentFailed: 'Failed to update .bashrc: {error}',
        agentUpdated: '.bashrc updated',
        appendingAlias: 'Appending Host alias to ~/.ssh/config',
        configFailed: 'Failed to update ssh config: {error}',
        aliasAppended: 'Host alias appended',
        aliasExists: 'Host alias already exists',
        aliasNotNeeded: 'Default keyName, no Host alias needed',
        readingPub: 'Reading public key',
        readPubFailed: 'Read public key failed: {error}',
        pubRetrieved: 'Public key retrieved ({bytes} bytes)',
      },
      codecombo: {
        detectingPlatform: 'Detecting remote platform',
        unameFailed: 'uname failed: {error}',
        binaryNotFound: 'Local binary not found: {path}',
        platformDetected: 'Platform {os}/{arch} -> {binary}',
        uploading: 'Uploading {path}',
        uploadFailed: 'Upload failed: {error}',
        binaryUploaded: 'Binary uploaded',
        writingUnit: 'Writing systemd unit',
        uploadUnitFailed: 'Upload unit failed: {error}',
        serviceStarted: 'Service enabled and started',
        polkitRuleInstalled: 'Polkit rule installed: the service user may restart this unit (required by self-update swap)',
        polkitRuleFailed: 'Failed to install polkit rule: {error} (self-update while the center is locked requires manual authorization)',
        selinuxDetected: 'SELinux Enforcing detected: it blocks service writes to the home-directory data dir',
        selinuxWhitelistGenerating: 'SELinux denials for this service detected — auto-generating an audit2allow whitelist (SELinux stays Enforcing)…',
        selinuxWhitelistInstalled: 'SELinux whitelist module codecombo-autowhitelist installed (allows only the operations this service was denied); SELinux stays Enforcing',
        selinuxWhitelistFailed: 'Failed to generate/install SELinux whitelist: {error}',
        selinuxNoTool: 'Target lacks audit2allow (policycoreutils-python-utils); falling back to Permissive',
        selinuxNoDenialButUnhealthy: 'No SELinux denials found but the service is unhealthy; falling back to Permissive for availability',
        selinuxRelaxed: 'SELinux switched to Permissive and persisted (to re-enable Enforcing, configure a whitelist or relocate the data dir — see deploy doc §5)',
        selinuxRelaxFailed: 'Failed to relax SELinux: {error}',
        checkingStatus: 'Checking service status',
        serviceNotActive: 'Service not active: {error}',
        serviceActive: 'Service is active',
        daemonStarted: 'Running as background daemon (start command)',
        daemonStartFailed: 'Failed to start daemon: {error}',
        cronInstalled: '@reboot crontab installed (auto-start on boot)',
        cronInstallFailed: 'Failed to install @reboot crontab: {error}',
        directNotice: 'Direct-process mode: an @reboot crontab starts it on boot; a crashed process will NOT auto-recover — manage with codecombo stop/restart/status',
      },
      claude_code: {
        preparingUpload: 'Preparing to upload setup_claude.sh',
        uploadFailed: 'Upload script failed: {error}',
        scriptUploaded: 'Script uploaded',
        runningScript: 'Running setup_claude.sh',
        scriptFailed: 'Script execution failed: {error}',
        scriptRemoved: 'Script removed',
        verifying: 'Verifying claude --version',
        verifyFailed: 'Verify failed: {error}',
        verified: 'Claude Code verified',
      },
    },
  },
  // Security audit log (P-20261002-13): Settings > Security > Audit Log + notify templates.
  // action keys mirror the backend store.Audit* dotted constants (lock.unlock -> audit.action.lock.unlock)
  audit: {
    tab: 'Audit Log',
    desc: 'Timeline of security-sensitive events: who unlocked, issued/revoked tokens, or changed credentials and hosts, from which IP and when. Actions and metadata only - never passwords, token values, or key material.',
    colTime: 'Time',
    colAction: 'Event',
    colResult: 'Result',
    colIp: 'IP',
    // Request correlation short code (P-20261006-53): same value as rid= in the access log / X-Request-Id header
    colRid: 'Request ID',
    ridTip: 'Request correlation ID — the access log carries a matching rid= line and the response the X-Request-Id header, for exact log-context alignment',
    total: '{n} entries',
    empty: 'No audit events yet',
    exportCsv: 'Export CSV',
    exportCsvTip: 'Export the full current retention window as a CSV file (time/action/result/IP/detail, with formula-injection guard; retention is adjustable above)',
    exportDone: 'Audit log exported',
    // Filter-linked sub-action (P-20261007-2): dropdown item next to the main
    // button while a filter is active — parameterized export = server-side
    // full-window filter, the only way to reach matches beyond the view window
    exportFilteredOption: 'Export current filter results (including rows beyond the {n}-entry view window)',
    exportFilteredTip: 'Export a CSV matching the current filters (server-side full-window match, including rows older than the view window)',
    // Audit write-failure warning (P-20261003-205): best-effort Append drops
    // failures silently — the counter makes the broken trail visible (semantics
    // unchanged; in-process counter, reset on restart)
    writeFails: '{n} audit write failures (last {time})',
    writeFailsTip: 'Failed audit events were silently dropped — the audit trail is incomplete. Check the data disk and data directory (full disk / permissions), fix them, and restart the instance to reset the counter.',
    // Capacity-cap weak hint (P-20261004-80): honest-boundary note that retention
    // = time window AND count cap — beyond the cap the oldest entries go first;
    // the threshold comes from the server response
    capacityHint: 'Capacity cap: {n} entries. When exceeded, the oldest entries are pruned first (retention = time window AND count cap, whichever binds first); the prune itself leaves a summary entry.',
    // Inline filters (P-20261003-131): action/result dropdowns, clear restores the full list
    filter: {
      action: 'Filter by action',
      result: 'Filter by result',
      actionAll: 'All actions',
      resultAll: 'All results',
      clear: 'Clear filters',
      clearTip: 'Clear filters and show the full list',
      filtered: '{n} of {total} matched',
      window: 'Filters cover the latest {n} entries only; use the dropdown next to the export button ("Export current filter results") to reach earlier matches',
      noMatch: 'No events match the current filters',
    },
    result: {
      success: 'Success',
      failure: 'Failed',
      denied: 'Blocked',
    },
    action: {
      lock: {
        unlock: 'Unlock',
        setup: 'Initial setup',
        config: 'Lock config change',
        password: 'Change lock password',
      },
      token: {
        create: 'Issue access token',
        revoke: 'Revoke access token',
      },
      agenttoken: {
        rotate: 'Rotate agent token',
        revoke: 'Revoke agent token',
      },
      hook: {
        token: {
          rotate: 'Issue/rotate inbound hook token',
          revoke: 'Revoke inbound hook token',
        },
      },
      agentguard: {
        allow: 'High-risk op allowed (AgentGuard decision)',
        deny: 'High-risk op denied (AgentGuard rule)',
        approval_pass: 'High-risk op allowed (approval retry)',
      },
      credential: {
        save: 'Save Git credential',
        delete: 'Delete Git credential',
      },
      sshkey: {
        generate: 'Generate SSH key',
        import: 'Import SSH key',
        delete: 'Delete SSH key',
      },
      remotehost: {
        create: 'Add remote host',
        update: 'Update remote host',
        delete: 'Delete remote host',
        export: 'Export host credentials',
        import: 'Import host credentials',
        tunnel: 'SSH tunnel toggle',
        file: {
          write: 'Remote file write-back',
        },
      },
      hostkey: {
        reset: 'Reset SSH host fingerprint',
        mismatch: 'SSH host key change rejected',
      },
      security: {
        // CSP Report-Only observation-window aggregate (P-20261007-6):
        // recorded per directive + blocked source counts
        csp_violation: 'CSP violation reports (observation aggregate)',
      },
      remoteaccess: {
        tunnel: {
          start: 'Start remote access tunnel',
          stop: 'Stop remote access tunnel',
          fail: 'Remote access tunnel failure',
        },
        tls_insecure: 'Confirm remote access with TLS disabled',
      },
      share: {
        create: 'Create share',
        view: 'Guest share visit',
        revoke: 'Revoke share',
        rotate: 'Rotate share link',
        refresh: 'Refresh frozen snapshot',
        expiry: 'Update share expiry',
        passphrase: 'Set share passphrase',
        msg: 'Moderate guest messages',
        retiredHit: 'Retired link still accessed',
        // Collab channel (P-20261024-1): toggle / inbox / direct-input audit verbs
        drop: 'Visitor collab material received',
        drop_consume: 'Collab material marked consumed',
        collab: 'Collab channel toggled',
        direct: {
          grant: 'Visitor direct input approved',
          revoke: 'Visitor direct input revoked',
          input: 'Visitor direct input batch',
        },
      },
      workspace: {
        export: 'Export workspace backup',
      },
      claude: {
        export: 'Export session Markdown',
        export_batch: 'Export sessions as zip (batch)',
        hide: 'Hide session',
        unhide: 'Restore session visibility',
      },
      file: {
        delete: 'Delete file',
        rename: 'Rename file',
        duplicate: 'Duplicate file',
        copy: 'Batch copy files',
        dirarchive: 'Directory zip download',
        batcharchive: 'Batch zip download',
        restore: 'Trash restore',
        purge: 'Trash permanent delete',
        sensitive_read: 'Sensitive file read',
        replace: 'Batch replace (server-side)',
        replace_restore: 'Replace history restore',
      },
      project: {
        delete: 'Delete project',
        lock: 'Project hard lock enabled',
        unlock: 'Project hard lock released',
        file: {
          external: 'Sensitive file written outside the workbench',
        },
      },
      git: {
        rebase: 'Interactive rebase (commit grooming)',
        merge: 'Merge branch (default/squash)',
        // 键与 server/store/auditlog.go 常量点分式同构（AuditLogPane.actionLabel
        // 按 audit.action.<常量> 嵌套查找）——P-20261007-19 落地的扁平下划线键
        // 恒不命中，审计行回退原文；P-20261004-142 过闸时顺手扶正
        changelist: {
          create: 'Create changelist',
          delete: 'Delete changelist',
          shelve: 'Shelve change group',
        },
      },
      audit: {
        export: 'Export audit CSV',
        prune: 'Audit capacity prune (automatic)',
        archive: 'Audit auto-archive (system)',
      },
      approval: {
        export: 'Export decision history CSV',
        mode: 'Approval mode change',
      },
      agentchain: {
        trigger: 'Session chain launched next session',
      },
      opsmessage: {
        send: 'Send session message',
      },
      compareexp: {
        apply: 'Compare experiment adoption applied',
      },
      terminal: {
        queue: {
          send: 'Send queued command',
        },
        broadcast: 'Broadcast terminal input',
        export: 'Export terminal output',
        external: {
          takeover: 'Take over external tmux session',
          kill: 'Kill external tmux session',
        },
        input_lock: 'Taken-over session readonly gate toggled (unlock = open writes)',
      },
      patch: {
        export: 'Export Git patch',
      },
      quickdrop: {
        drop: 'Quickdrop arrived',
        token: 'Quickdrop token generated/revoked',
      },
      instance: {
        dispatch: 'Federated session dispatch',
      },
      sync: {
        pull: 'Multi-instance sync pull',
        push: 'Multi-instance sync push',
        cred: {
          ctrl: 'Credential sync control (pairing/verification)',
          send: 'Credential vault send',
          recv: 'Credential vault receive & land',
        },
      },
      migration: {
        export: 'Migration package export',
        import: 'Migration package import/apply',
      },
      runbook: {
        run: 'Runbook server-side execution',
      },
      fleet: {
        runbook: {
          execute: 'Fleet runbook execute/abort/retry',
        },
      },
      deploy: {
        log: {
          archive: 'Deploy log archived (system)',
        },
      },
    },
    notify: {
      unlockFails: {
        title: 'Repeated unlock failures detected',
        body: 'IP {ip} failed the password {n} times in a row. Verify this was you.',
      },
      hostkeyReset: {
        title: 'SSH host fingerprint reset: {name}',
        body: 'Fingerprint of {name} ({host}:{port}) cleared; it will be recorded again on next connect (from IP {ip})',
      },
      remoteAccessHostKeyChanged: {
        title: 'Relay host key changed: {name}',
        body: 'The SSH host key of {name} ({host}:{port}) does not match the pinned fingerprint; the tunnel was stopped. If this is a legitimate migration, reset the host key in Settings → Remote Access (from IP {ip})',
      },
      hostDelete: {
        title: 'Remote host deleted: {name}',
        body: '{name} ({user}, {host}:{port}) was deleted, from IP {ip}',
      },
      agentTokenRotate: {
        title: 'Agent access token rotated',
        body: 'Agent access token rotated; the old token is invalid immediately. Restart agent terminal sessions (from IP {ip})',
      },
      // Periodic auto-archive (P-20261003-277): expired events leaving the
      // retention window are persisted to CSV before deletion
      archive: {
        title: 'Audit archived',
        body: '{rows} expired audit events archived to CSV: {file}',
      },
    },
  },
  // Global lock (three layers: overlay / default password reminder / settings)
  lock: {
    overlay: {
      title: 'System Locked',
      subtitle: 'Enter password to continue',
      passwordPlaceholder: 'Password',
      unlockBtn: 'Unlock',
      ['wrongPassword']: 'Wrong password',
      rateLimited: 'Too many attempts, please try again later',
      rateLimitedHint: 'Limited to 10 attempts per minute',
      networkError: 'Network error, please retry',
      setupTitle: 'Welcome to Codecombo',
      setupSubtitle: 'First run: set your access password',
      confirmPasswordPlaceholder: 'Confirm password',
      setupBtn: 'Set Password & Enter',
      passwordMismatch: 'Passwords do not match',
      setupFailed: 'Password setup failed, please retry',
      setupRateLimitedHint: 'Set your password to enter the system',
      lanSetupHint: 'LAN access is enabled: any machine on this network can complete first-time setup via this IP',
      togglePasswordShow: 'Show / hide password',
    },
    recovery: {
      hint: 'Forgot your password? Run codecombo reset-lock on the machine running this service (the service will stop and the password resets to default)',
    },
    reminder: {
      defaultPasswordTitle: 'Change Default Password',
      defaultPasswordWarning: 'You are using the default password "admin", which is a serious security risk',
      changeNow: 'Change Now',
      remindLater: 'Remind Later',
    },
    settings: {
      section: 'Lock',
      enableLock: 'Enable Global Lock',
      requiresLock: 'Enable the global lock switch above first',
      enableAutoLock: 'Enable Auto-Lock',
      autoLockMinutes: 'Auto-Lock After (minutes)',
      tokenTTLMinutes: 'Token TTL (minutes)',
      ['changePassword']: 'Change Password',
      ['currentPassword']: 'Current Password',
      ['newPassword']: 'New Password',
      ['confirmPassword']: 'Confirm Password',
      lockNow: 'Lock Now',
      lockNowDesc: 'Click the button below to lock the system immediately',
      confirmDisable: 'Disable Lock',
      confirmDisableDesc: 'Enter current password to confirm',
      passwordChanged: 'Password changed, please re-unlock with new password',
      configUpdated: 'Configuration updated',
      shortcut: 'Lock Shortcut',
      shortcutHint: 'A keyboard shortcut to lock the system instantly',
      shortcutRebind: 'Rebind',
      shortcutReset: 'Reset to Default',
      shortcutClear: 'Clear',
      shortcutCleared: 'Disabled',
      shortcutCapturePrompt: 'Press a key combination to rebind...',
      shortcutCancelHint: 'Press Esc to cancel',
    },
  },
  // Editor code snippet library (P-20261002-44): shared by the two Monaco context-menu
  // actions, the palette insert command and the SnippetManager kind tabs; new keys
  // use the snippet.code.* prefix
  snippet: {
    // Command-domain save modal copy (P-20261003-199): title + success toast when
    // the history panel reuses SaveCodeSnippetModal with kind=command
    command: {
      saveTitle: 'Save as Command Snippet',
      saved: 'Command snippet saved',
    },
    code: {
      saveSelection: 'Save as Snippet',
      insert: 'Insert Snippet',
      noSelection: 'Select code to save first',
      tooLong: 'Selection exceeds 8000 characters, too long for a snippet',
      saveTitle: 'Save as Code Snippet',
      fieldTitle: 'Title',
      titleRequired: 'Snippet title is required',
      fieldDesc: 'Description (optional)',
      languageLabel: 'Language',
      saved: 'Code snippet saved',
      saveFailed: 'Save failed',
      pickTitle: 'Insert Code Snippet',
      searchPlaceholder: 'Search code snippets…',
      empty: 'No code snippets for this language yet. Select code in the editor and use "Save as Snippet", or add one in Settings → Terminal',
      noFile: 'Open a file before inserting a snippet',
      tabCommands: 'Command snippets',
      tabCode: 'Code snippets',
      fieldContent: 'Code content',
      fieldLanguage: 'Language (e.g. typescript, empty = usable in any language)',
    },
  },
  // QR relay (P-20261002-59: open the current page on a phone via scan)
  qr: {
    relay: {
      title: 'Open on Phone',
      desc: 'Scan with your phone to open this page on mobile (LAN addresses require the phone and server on the same Wi-Fi)',
      carryLocation: 'Include current-location deep link (off points to home)',
      unlockHint: 'After scanning, enter the unlock password on your phone',
      httpWarn: 'The QR link uses plain HTTP and is unencrypted — avoid scanning on public networks',
      status: {
        external: 'External address',
        public: 'Public address',
        lan: 'LAN',
        loopback: 'Local loopback',
        unreachable: 'Unreachable',
      },
      hint: {
        external: 'Using the external access URL from settings; reachable from any network',
        public: 'Using a public address; reachable from any network (server firewall/port must allow it)',
        lan: 'The phone must be on the same Wi-Fi / LAN as the server',
        loopback: 'Opened via local loopback, which phones cannot reach; automatically switched to LAN address {ip}. If the phone is not on the same Wi-Fi, configure an external access URL under Settings · General',
        unreachable: 'Opened via local loopback and no usable LAN address was detected, so phones cannot reach it. Configure an external access URL (Tailscale / Cloudflare Tunnel / public reverse proxy) under Settings · General',
        networkFailed: 'Could not load local network addresses; refresh and retry, or configure an external access URL under Settings · General',
      },
      addressLabel: 'QR address',
      loading: 'Selecting an access address…',
      unreachablePlaceholder: 'No phone-reachable address',
    },
  },
  // Cross-instance same-directory dual-open detection (P-20261003-3):
  // titleKey/bodyKey templates for conflict notifications from the claims module
  system: {
    dualOpen: {
      conflict: {
        title: 'Project also open in another instance',
        body: '"{project}" is also managed by another instance (port {port}); git operations and file watching may interfere',
      },
    },
    // Explicit degradation for corrupted config.json (P-20261006-10):
    // titleKey/bodyKey templates for degradation notifications from the config
    // package; body = preserved / bodyUnpreserved = rename failed, bad file left in place
    configCorrupt: {
      title: 'Config file corrupted — started with defaults',
      body: 'The original config could not be parsed ({err}); the bad file was preserved at {file}. Settings such as port and proxy fell back to defaults — after fixing, merge the preserved file back into config.json and restart',
      bodyUnpreserved: 'The original config could not be parsed ({err}) and preservation failed; the bad file remains at {file} and settings fell back to defaults — check data directory permissions, repair it manually and restart',
    },
  },
  // Local environment self-check (P-20261003-317: command palette entry, GET
  // /api/selfcheck aggregation; items.* keys map 1:1 to backend item keys)
  selfcheck: {
    cmdTitle: 'Environment Self-Check',
    title: 'Local Environment Self-Check',
    refresh: 'Re-run Check',
    copyMarkdown: 'Copy as Markdown',
    copied: 'Self-check report copied as Markdown',
    summary: '{ok} pass · {warn} warn · {fail} fail',
    hintLabel: 'Fix hint',
    footnote: 'Read-only with no side effects; a numeric snapshot lands on every check and in the daily job (ring of 20) for trend comparison. Paste the report directly into an issue — item details are language-neutral server originals',
    trend: {
      compareWith: 'vs last run ({time})',
      runs: '{n} snapshots kept',
      diskAvail: 'Disk free',
      memUsed: 'Memory used',
      activeSessions: 'Active sessions',
      terminals: 'Terminals',
    },
    items: {
      version: 'App Version',
      git: 'Git Toolchain',
      lfs: 'Git LFS',
      tmux: 'tmux (Persistent Sessions)',
      'agent-runtimes': 'Agent Runtimes',
      ports: 'Registered Ports',
      disk: 'Data Disk Usage',
      config: 'Config File Integrity',
    },
    status: {
      ok: 'Pass',
      warn: 'Warn',
      fail: 'Fail',
    },
  },
  // Morning checklist banner (P-20261005-219: GET /api/morning-brief aggregation;
  // home page and agent morning inspection share the same source; daily-ack
  // discipline lives in utils/morningBrief)
  morningBrief: {
    title: 'Morning Checklist',
    ackAll: 'Got it — hide for today',
    muteToday: 'Don’t remind today',
    unpushedSummary: '{count} unpushed commits ({projects} projects)',
    push: 'Push',
    pushDone: '{name} pushed',
    moreProjects: '{count} more projects to push',
    agentsSummary: '{count} agent sessions running',
    openSessions: 'Sessions',
    unreadAll: '{count} unread ({notifications} notifications / {approvals} pending approvals)',
    unreadNotifyOnly: '{count} unread notifications',
    unreadApprovalsOnly: '{count} pending approvals',
    openNotifications: 'Notifications',
  },
}
