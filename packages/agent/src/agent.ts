import { canHandOffToDelivery } from './delivery-context.js';
import { contextInputFilter } from './prompts/runtime-context.js';
import { selectScene } from './prompts/scenes.js';
import {
  executionToolNames,
  validateToolContract,
  validatePromptReferences,
} from './prompts/tool-contract.js';
import { legacyInstructions } from './prompts/legacy-instructions.js';
import { replyRequestStatusTool } from './tools/reply-request-status.js';
import { replyToRequestTool } from './tools/reply-to-request.js';
import { searchInformationTool } from './tools/search-information.js';
import { readWebPageTool } from './tools/read-web-page.js';
import { recordRequestTool } from './tools/record-request.js';
import { requestInstructions } from './request-instructions.js';
import { taskPlanningInstructions } from './task-instructions.js';
import { taskPlanningTools } from './tools/plan-task.js';
import { recordTaskProgressTool } from './tools/record-task-progress.js';
import { readTaskSourcesTool } from './tools/read-task-sources.js';
import { saveExecutionCheckpoint } from './execution-checkpoint.js';
import type { Phase } from '@matchbot/domain';
import { Agent, Runner } from '@openai/agents';
import type { AgentDeps, MatchContext } from './context.js';
import { noGuaranteeOutputGuardrail, sensitiveInputGuardrail } from './guardrails.js';
import { askClarificationTool } from './tools/ask-clarification.js';
import { closeDemandTool } from './tools/close-demand.js';
import { doNothingTool } from './tools/do-nothing.js';
import { findPeerSupplyTool } from './tools/find-peer-supply.js';
import { findSuppliersTool } from './tools/find-suppliers.js';
import { notifyUserTool } from './tools/notify-user.js';
import { pushLeadTool } from './tools/push-lead.js';
import { reactTool } from './tools/react.js';
import { replyInGroupTool } from './tools/reply-in-group.js';
import { replyWithSearchResultsTool } from './tools/reply-with-search-results.js';
import { upsertDemandTool } from './tools/upsert-demand.js';
import { upsertSupplyTool } from './tools/upsert-supply.js';
import { webSearchTool } from './tools/web-search.js';
import { replyWithXhsNotesTool } from './tools/reply-with-xhs-notes.js';
import { xhsSearchTool } from './tools/xhs-search.js';
import { xhsReadNotesTool } from './tools/xhs-read-notes.js';
import { legacyXhsSearchTool } from './tools/xhs-legacy-search.js';
import { replyWithLegacyXhsNotesTool } from './tools/reply-with-xhs-legacy-notes.js';
import { marketSearchTool } from './tools/market-search.js';
import { marketEnrichTool } from './tools/market-enrich.js';
import { replyWithMarketResultsTool } from './tools/reply-with-market-results.js';

/** 改 instructions 或任何工具描述时递增（AGENTS.md §8 第 4 条）；升级 SDK 时清空待审 run_states。 */
export const AGENT_VERSION = '0.29.0';

/** 「下周六」要换算成 whenAt，模型需要知道今天是哪天、星期几（伦敦时区）。 */
export function londonToday(now = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      weekday: 'long',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * 单个 matchAgent，品类差异走 instructions 注入（架构 §4.2）。
 * toolUseBehavior 保留默认 run_llm_again：matchAgent 需要 upsert_demand → find_suppliers →
 * reply_in_group 的链式调用，PoC V1 的 stop_on_first_tool 只适用于单工具分类场景；
 * 写工具全部幂等（upsert / replaceForDemand），出站经门控与频控兜底。
 *
 * Runner 按 run 构造（V6：traceMetadata 属 RunConfig，只能 new Runner 传），
 * traceIncludeSensitiveData: false 让 span 不带原文。
 */
export function createMatchAgent(
  deps: AgentDeps,
  run?: {
    phase: Phase;
    context?: MatchContext;
    input?: string;
    finalAnswerOnly?: boolean;
    requestStatusOnly?: boolean;
    taskPlanningOnly?: boolean;
    inputRef?: string;
    taskId?: string;
    taskRefs?: string[];
    checkpointInput?: string;
    requestContext?: MatchContext;
  },
) {
  const promptContext = run?.context;
  const agent = new Agent<MatchContext>({
    name: 'matchAgent',
    model: deps.env.DEEPSEEK_MODEL,
    // 来源推荐已落出站表就结束；无效证据仍回模型修正，不占一个额外的结束回合。
    toolUseBehavior: async (rc, results) => {
      if (run?.input !== undefined)
        await saveExecutionCheckpoint(
          deps,
          rc.context as MatchContext,
          run.checkpointInput ?? run.input,
          AGENT_VERSION,
        );
      if (run?.taskPlanningOnly)
        return (rc.context as MatchContext).taskUpdate
          ? { isFinalOutput: true, isInterrupted: undefined, finalOutput: 'task prepared' }
          : { isFinalOutput: false, isInterrupted: undefined };
      if (
        deps.answerRequests &&
        deps.taskRequests &&
        !run?.finalAnswerOnly &&
        canHandOffToDelivery(rc.context as MatchContext) &&
        results.some((r) => {
          if (
            r.tool.name !== 'record_task_progress' ||
            !('output' in r) ||
            typeof r.output !== 'string'
          )
            return false;
          try {
            return (JSON.parse(r.output) as { recorded?: unknown }).recorded === true;
          } catch {
            return false;
          }
        })
      )
        return {
          isFinalOutput: true,
          isInterrupted: undefined,
          finalOutput: 'research ready for delivery',
        };
      if ((rc.context as MatchContext).outboundBlocked && !run?.requestStatusOnly)
        return {
          isFinalOutput: true,
          isInterrupted: undefined,
          finalOutput: 'not sent: outbound blocked',
        };
      const quiet = results.find(
        (r) =>
          'output' in r &&
          r.tool.name === 'do_nothing' &&
          typeof r.output === 'string' &&
          /^ok(?:$|:)/.test(r.output),
      );
      if (quiet && 'output' in quiet)
        return { isFinalOutput: true, isInterrupted: undefined, finalOutput: String(quiet.output) };
      const finished = results.find(
        (r) =>
          'output' in r &&
          (deps.answerRequests
            ? [
                'reply_with_xhs_notes',
                'reply_with_market_results',
                'reply_to_request',
                'react',
                'reply_request_status',
                'reply_in_group',
                'reply_with_search_results',
                'ask_clarification',
              ]
            : ['reply_with_xhs_notes', 'reply_with_market_results']
          ).includes(r.tool.name) &&
          typeof r.output === 'string' &&
          /^(?:queued|dry-run recorded|not sent)/.test(r.output),
      );
      return finished && 'output' in finished
        ? { isFinalOutput: true, isInterrupted: undefined, finalOutput: String(finished.output) }
        : { isFinalOutput: false, isInterrupted: undefined };
    },
    // P14 实测：默认 high 思考让多源综合超时；Jev 判断、Flash 生成，证据仍由代码校验。
    resetToolChoice: !(run?.taskPlanningOnly || run?.finalAnswerOnly || run?.requestStatusOnly),
    modelSettings: {
      ...(deps.env.GENERATION_REASONING_EFFORT
        ? { reasoning: { effort: deps.env.GENERATION_REASONING_EFFORT } }
        : {}),
      ...(deps.env.DEEPSEEK_MODEL === 'deepseek-flash'
        ? { providerData: { thinking: { type: 'disabled' } } }
        : {}),
      ...(deps.env.DEEPSEEK_MODEL === 'deepseek-flash' &&
      (run?.taskPlanningOnly || deps.taskRequests)
        ? { temperature: 0 }
        : {}),
      ...(run?.taskPlanningOnly || deps.taskRequests ? { parallelToolCalls: false } : {}),
      ...(run?.taskPlanningOnly ||
      run?.requestStatusOnly ||
      run?.finalAnswerOnly ||
      (deps.xhsSearch && deps.env.XHS_RESEARCH_ENABLED)
        ? { toolChoice: 'required' as const }
        : {}),
    },
    instructions: (rc) =>
      run?.taskPlanningOnly
        ? taskPlanningInstructions(
            rc.context,
            londonToday(),
            run.taskRefs === undefined || run.taskRefs.length > 0,
          )
        : run?.requestStatusOnly
          ? 'Call reply_request_status with {} exactly once. Its server-generated text is a separate acknowledgement, not a rewrite of a declined recommendation. Do not call any other tool or finish without the status call.'
          : deps.answerRequests
            ? requestInstructions(deps, rc.context, !!run?.finalAnswerOnly, londonToday())
            : legacyInstructions(deps, rc.context, londonToday()),
    tools: run?.taskPlanningOnly
      ? taskPlanningTools(deps, run.input ?? '', run.taskRefs)
      : run?.requestStatusOnly
        ? [replyRequestStatusTool(deps)]
        : run?.finalAnswerOnly
          ? [replyToRequestTool(deps)]
          : [
              ...(deps.answerRequests
                ? [recordRequestTool(deps), searchInformationTool(deps), replyToRequestTool(deps)]
                : [upsertDemandTool(deps), upsertSupplyTool(deps)]),
              ...(deps.taskRequests
                ? [recordTaskProgressTool(deps), readTaskSourcesTool(deps)]
                : []),
              ...(deps.answerRequests && deps.pageReader ? [readWebPageTool(deps)] : []),
              findSuppliersTool(deps),
              findPeerSupplyTool(deps),
              askClarificationTool(deps),
              replyInGroupTool(deps),
              ...(deps.answerRequests ? [] : [notifyUserTool(deps), pushLeadTool(deps)]),
              closeDemandTool(deps),
              doNothingTool(deps),
              reactTool(deps),
              ...(!deps.answerRequests && deps.webSearch
                ? [
                    webSearchTool({ ...deps, webSearch: deps.webSearch }),
                    replyWithSearchResultsTool(deps),
                  ]
                : []),
              ...(deps.marketSearch
                ? [
                    marketSearchTool({ ...deps, marketSearch: deps.marketSearch }, run?.input),
                    marketEnrichTool({ ...deps, marketSearch: deps.marketSearch }),
                    ...(deps.answerRequests ? [] : [replyWithMarketResultsTool(deps)]),
                  ]
                : []),
              ...(deps.xhsSearch
                ? deps.env.XHS_RESEARCH_ENABLED
                  ? [
                      xhsSearchTool({ ...deps, xhsSearch: deps.xhsSearch }),
                      ...(deps.xhsSearch.readNote ? [xhsReadNotesTool(deps)] : []),
                      replyWithXhsNotesTool(deps),
                    ]
                  : [
                      legacyXhsSearchTool({ ...deps, xhsSearch: deps.xhsSearch }),
                      replyWithLegacyXhsNotesTool(deps),
                    ]
                : []),
            ],
    inputGuardrails: [sensitiveInputGuardrail],
    outputGuardrails: [noGuaranteeOutputGuardrail],
  });
  if (
    deps.answerRequests &&
    promptContext &&
    !run?.taskPlanningOnly &&
    !run?.requestStatusOnly &&
    !run?.finalAnswerOnly
  ) {
    const allowed = executionToolNames(deps, promptContext);
    agent.tools = agent.tools.filter((t) => t.type === 'function' && allowed.has(t.name));
    validateToolContract(
      deps,
      promptContext,
      agent.tools.map((t) => (t.type === 'function' ? t.name : '')),
    );
  }
  if (
    deps.answerRequests &&
    !run?.taskPlanningOnly &&
    !run?.requestStatusOnly &&
    !run?.finalAnswerOnly
  ) {
    for (const t of agent.tools)
      if (t.type === 'function') {
        const enabled = t.isEnabled;
        t.isEnabled = async (rc, current) =>
          executionToolNames(deps, rc.context).has(t.name) && (await enabled(rc, current));
      }
  }
  if (deps.answerRequests || run?.taskPlanningOnly) {
    const instructions = agent.instructions;
    if (typeof instructions !== 'function') throw new Error('expected dynamic prompt builder');
    agent.instructions = async (rc, current) => {
      const prompt = await instructions(rc, current);
      const names = new Set(
        (await agent.getAllTools(rc)).flatMap((t) => (t.type === 'function' ? [t.name] : [])),
      );
      if (!run?.taskPlanningOnly && !run?.requestStatusOnly && !run?.finalAnswerOnly)
        validateToolContract(deps, rc.context, [...names]);
      validatePromptReferences(prompt, names);
      return prompt;
    };
  }
  const runner = new Runner({
    callModelInputFilter: contextInputFilter(
      run?.taskPlanningOnly
        ? 'planning'
        : run?.requestStatusOnly
          ? 'status'
          : run?.finalAnswerOnly
            ? 'finalization'
            : 'execution',
    ),
    traceIncludeSensitiveData: false,
    ...(run
      ? {
          traceMetadata: {
            model: deps.env.DEEPSEEK_MODEL,
            phase: String(run.phase),
            promptArchitecture: '1',
            promptStage: run.taskPlanningOnly
              ? 'planning'
              : run.requestStatusOnly
                ? 'status'
                : run.finalAnswerOnly
                  ? 'finalization'
                  : 'execution',
            ...(promptContext && deps.answerRequests
              ? { promptScene: selectScene(promptContext) }
              : {}),
            ...(run.inputRef ? { inputRef: run.inputRef } : {}),
            ...(run.taskId ? { taskId: run.taskId } : {}),
          },
        }
      : {}),
    ...(deps.modelProvider ? { modelProvider: deps.modelProvider } : {}),
  });
  return { agent, runner };
}
