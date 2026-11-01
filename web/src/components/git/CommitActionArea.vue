<script setup lang="ts">
import { reactive } from 'vue'
import { NButton, NButtonGroup, NCheckbox, NDropdown, NIcon, NInput } from 'naive-ui'
import { AddOutline, CheckmarkDoneOutline, ChevronDownOutline, ChevronForwardOutline, CloudUploadOutline, FlaskOutline, GitPullRequestOutline, LayersOutline, SparklesOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import type { CommitActionsState } from '../../composables/useCommitActions'
import type { PrDescState } from '../../composables/usePrDescription'
import type { SuggestTestsState } from '../../composables/useSuggestTests'
import type { SplitExecuteState } from '../../composables/useCommitSplitExecute'

// 提交操作区（自 CommitPanel.vue 拆出，P-20261003-143）：纯 UI——提交消息草稿
// （store 承载）/ Conventional Commit 工具栏 / 修补上次提交 / 提交消息历史 /
// 生成提交信息 / 提交与「提交并推送」连招 / 全选与暂存全部的逻辑都在
// useCommitActions（面板宿主 setup 期调用，状态挂在面板实例上：changes 页签
// v-if 卸载本组件时不丢 CC 字段与 amend 勾选）。
const props = defineProps<{ area: CommitActionsState; prDesc: PrDescState; suggestTests: SuggestTestsState; splitExec: SplitExecuteState }>()

// 同一响应式代理（reactive(reactive proxy) 返回自身）：本地别名让模板读写与
// props 解耦——v-model 写入经代理路由回 useCommitActions 的 ref/computed
// （commitMessage 即 changesStore 草稿）
const area = reactive(props.area)

const { t } = useI18n()
</script>

<template>
  <div class="cp-commit-area">
    <!-- Conventional Commit 类型工具栏 -->
    <div class="cp-cc-toolbar">
      <div class="cp-cc-types">
        <button
          v-for="tp in area.ccTypes"
          :key="tp"
          class="cp-cc-chip"
          :class="{ active: area.selectedCcType === tp, [tp]: area.selectedCcType === tp }"
          @click="area.applyCcType(tp)"
        >
          {{ tp }}
        </button>
      </div>
      <button
        class="cp-cc-toggle"
        :title="t('commitPanel.ccAdvanced')"
        @click="area.showCcAdvanced = !area.showCcAdvanced"
      >
        <n-icon size="12">
          <component :is="area.showCcAdvanced ? ChevronDownOutline : ChevronForwardOutline" />
        </n-icon>
      </button>
    </div>
    <div
      v-if="area.showCcAdvanced"
      class="cp-cc-advanced"
    >
      <n-input
        v-model:value="area.ccScope"
        size="tiny"
        :placeholder="t('commitPanel.ccScopePlaceholder')"
        class="cp-cc-scope"
        @update:value="area.syncCcToMessage"
      />
      <label
        class="cp-cc-breaking"
        :title="t('commitPanel.ccBreakingTitle')"
      >
        <n-checkbox
          v-model:checked="area.includeBreaking"
          size="small"
          @update:checked="area.syncCcToMessage"
        />
        <span>!</span>
      </label>
      <n-input
        v-model:value="area.ccFooter"
        size="tiny"
        :placeholder="t('commitPanel.ccFooterPlaceholder')"
        class="cp-cc-footer-input"
        @keyup.enter="area.appendFooter"
      />
      <n-button
        size="tiny"
        quaternary
        :disabled="!area.ccFooter.trim()"
        @click="area.appendFooter"
      >
        {{ t('commitPanel.ccAppendFooter') }}
      </n-button>
    </div>
    <div class="cp-msg-toolbar">
      <!-- 「拆分建议」（P-20261003-186，P-138 同族）：暂存变更混多主题时发起
           agent 会话产出分组方案——仅建议不自动执行（人工逐组 stage/commit）。
           原生 button（同下方「生成提交信息」考量：避开既有 spec 的 `.n-button`
           hasText '提交' 定位器） -->
      <button
        class="cp-msg-generate"
        :disabled="area.stagedCount === 0 || area.splitSuggestLaunching"
        :title="t('commit.splitSuggest.buttonTitle')"
        data-testid="suggest-commit-split"
        @click="area.handleSuggestCommitSplit"
      >
        <n-icon size="12">
          <LayersOutline />
        </n-icon>
        {{ t('commit.splitSuggest.button') }}
      </button>
      <!-- 逐组执行（P-20261003-278）：拆分建议（P-186）的确认执行化——本应用
           会话内发起过拆分建议才出现（模块级会话锚点，刷新即隐、再发起即现），
           点击读会话输出解析结构化分组方案，确认弹层逐组预览后服务端逐组
           stage/commit（失败中断报告）。原生 button 形态同族（避开既有 spec
           的 `.n-button` hasText '提交' 定位器）；不按 stagedCount 禁用——
           建议后取消暂存再执行是合法路径（循环会按组自行暂存） -->
      <button
        v-if="splitExec.hasSuggestion"
        class="cp-msg-generate"
        :disabled="splitExec.preparing || splitExec.executing"
        :title="t('commit.splitExec.buttonTitle')"
        data-testid="execute-commit-split"
        @click="splitExec.executeSplitSuggestion"
      >
        <n-icon size="12">
          <CheckmarkDoneOutline />
        </n-icon>
        {{ t('commit.splitExec.button') }}
      </button>
      <!-- 原生 button（同 cp-msg-history 轻文本按钮形态）：n-button 会落进
           既有 spec 的 `.n-button` hasText '提交' 定位器造成 strict 冲突 -->
      <button
        class="cp-msg-generate"
        :disabled="area.stagedCount === 0 || area.agentMsgLaunching"
        :title="t('commit.agentMsg.buttonTitle')"
        data-testid="generate-commit-msg"
        @click="area.handleGenerateCommitMsg"
      >
        <n-icon size="12">
          <SparklesOutline />
        </n-icon>
        {{ t('commit.agentMsg.button') }}
      </button>
      <!-- 生成 PR 描述（P-20261003-177）：P-138 的 PR 级延伸。同款原生 button
           形态与 loading 复用（launching 中禁用防重复发起）；有项目根即可发起
           （PR 常在工作区已干净的时点剪裁，无廉价前置数据可判空，见组合式注） -->
      <button
        class="cp-msg-generate"
        :disabled="prDesc.launching"
        :title="t('commit.prDesc.buttonTitle')"
        data-testid="generate-pr-desc"
        @click="prDesc.generatePrDesc"
      >
        <n-icon size="12">
          <GitPullRequestOutline />
        </n-icon>
        {{ t('commit.prDesc.button') }}
      </button>
      <!-- 建议补测试（P-20261003-249）：marks+diffstat 发起 agent 会话产出测试
           缺口建议（文件/测试点/优先级），纯建议不自动写测试。工作区无未提交
           变更时无分析对象（canSuggest 同步面禁用，见组合式注）；同款原生
           button 形态避开既有 spec 的 `.n-button` hasText '提交' 定位器 -->
      <button
        class="cp-msg-generate"
        :disabled="!suggestTests.canSuggest || suggestTests.launching"
        :title="t('commit.suggestTests.buttonTitle')"
        data-testid="suggest-tests"
        @click="suggestTests.suggestMissingTests"
      >
        <n-icon size="12">
          <FlaskOutline />
        </n-icon>
        {{ t('commit.suggestTests.button') }}
      </button>
      <n-dropdown
        trigger="click"
        :options="area.recentMsgOptions"
        @select="area.applyRecentMessage"
        @update:show="(s: boolean) => { if (s) void area.loadRecentMessages() }"
      >
        <button
          class="cp-msg-history"
          :title="t('changesView.recentMessages')"
        >
          {{ t('changesView.recentMessages') }}
        </button>
      </n-dropdown>
    </div>
    <n-input
      v-model:value="area.commitMessage"
      type="textarea"
      :placeholder="t('commitPanel.commitPlaceholder')"
      :autosize="{ minRows: 2, maxRows: 6 }"
      size="small"
      @keydown="area.onCommitInputKeydown"
    />
    <div class="cp-commit-actions">
      <span
        v-if="area.stagedCount > 0"
        class="cp-select-all"
        @click="area.toggleSelectAll"
      >
        {{ area.allSelected ? '☑' : '☐' }} {{ t('commitPanel.selectAll') }}
      </span>
      <label
        class="cp-amend"
        :title="t('commitPanel.amendTitle')"
      >
        <n-checkbox
          v-model:checked="area.amendLastCommit"
          size="small"
          @update:checked="area.onAmendToggle"
        />
        <span>{{ t('commitPanel.amend') }}</span>
      </label>
      <!-- 「提交并推送」连招（P-20261003-84）：提交主按钮 + 下拉副选项（JetBrains
           Commit and Push 同款分体）；副钮仅图标无文字，不落既有 spec 的
           `.n-button` hasText '提交' 定位器（上方 cp-msg-generate 同款考量） -->
      <n-button-group class="cp-commit-split">
        <!-- loading（P-20261005-211）：提交在飞超 150ms 才亮 spinner（快提交不抖动），
             disabled 含 commitBusy 即时落闸防重复提交请求 -->
        <n-button
          size="small"
          type="primary"
          :disabled="area.commitActionDisabled"
          :loading="area.commitSpinner"
          @click="area.handleCommit"
        >
          <template #icon>
            <n-icon size="14">
              <CloudUploadOutline />
            </n-icon>
          </template>
          {{ t('commitPanel.commitCount', { n: area.commitCount }) }}
        </n-button>
        <n-dropdown
          trigger="click"
          :options="area.commitExtraOptions"
          @select="area.handleCommitExtra"
        >
          <n-button
            size="small"
            type="primary"
            data-testid="commit-more"
            :disabled="area.commitActionDisabled"
            :loading="area.commitSpinner"
            :title="t('git.commitPush.moreTitle')"
          >
            <template #icon>
              <n-icon size="12">
                <ChevronDownOutline />
              </n-icon>
            </template>
          </n-button>
        </n-dropdown>
      </n-button-group>
      <n-button
        v-if="area.unstagedCount > 0"
        size="small"
        quaternary
        :disabled="area.stageBusy"
        :loading="area.stageSpinner"
        @click="area.handleStageAll"
      >
        <template #icon>
          <n-icon size="14">
            <AddOutline />
          </n-icon>
        </template>
        {{ t('commitPanel.stageAll') }}
      </n-button>
    </div>
  </div>
</template>

<!-- 样式沿用面板共享样式表（scoped 按组件各编译一份，同 SecuritySettings 拆分先例） -->
<style scoped src="../../views/git/commit-panel.css"></style>
