import type { AgentDeps, MatchContext } from '../context.js';
import { sceneContract } from './policy/scenes.js';

/** Tools that talk to the group. The researcher never gets these (P52); the writer gets one of them. */
export const WRITER_REPLY_TOOLS = [
  'reply_to_request',
  'reply_in_group',
  'reply_with_xhs_notes',
  'react',
  'do_nothing',
] as const;

/** Task states that need no research: the writer acknowledges, clarifies or stays quiet directly. */
export function needsNoResearch(deps: AgentDeps, ctx: MatchContext): boolean {
  return (
    ['completed', 'cancelled', 'acknowledged', 'ambiguous', 'unbound'].includes(
      ctx.taskUpdate?.kind ?? '',
    ) || sceneContract(deps, ctx).id === 'unsupported'
  );
}

/** The researcher's tool set: scene research tools, never an outbound tool, and finish_research. */
export function executionToolNames(deps: AgentDeps, ctx: MatchContext): Set<string> {
  if (needsNoResearch(deps, ctx)) return new Set(['finish_research']);
  const scene = sceneContract(deps, ctx);
  const names = new Set([
    'finish_research',
    ...scene.tools.filter((t) => !(WRITER_REPLY_TOOLS as readonly string[]).includes(t)),
  ]);
  if (deps.webSearch?.research) names.add('search_information');
  if (deps.pageReader) names.add('read_web_page');
  if (deps.taskRequests) {
    names.add('record_task_progress');
    names.add('read_task_sources');
  }
  return names;
}

/** The writer's tool set for this context: one reply tool, or react/do_nothing for an acknowledgement. */
export function writerToolNames(deps: AgentDeps, ctx: MatchContext): Set<string> {
  const kind = ctx.taskUpdate?.kind ?? '';
  if (
    ['completed', 'cancelled', 'acknowledged'].includes(kind) ||
    sceneContract(deps, ctx).id === 'unsupported'
  )
    return new Set(['react', 'do_nothing']);
  if (['ambiguous', 'unbound'].includes(kind)) return new Set(['reply_to_request']);
  if (ctx.catalogueSuppliers?.length) return new Set(['reply_in_group', 'reply_to_request']);
  if (ctx.xhsNotes?.length && !ctx.knowledgeSources?.length && !ctx.marketPlan && deps.xhsSearch)
    return new Set(['reply_with_xhs_notes']);
  return new Set(['reply_to_request']);
}

export function validateToolContract(deps: AgentDeps, ctx: MatchContext, names: string[]): void {
  if (new Set(names).size !== names.length) throw new Error('duplicate prompt tool');
  const expected = executionToolNames(deps, ctx);
  for (const name of expected)
    if (!names.includes(name)) throw new Error('missing prompt tool: ' + name);
  for (const name of names)
    if (!expected.has(name)) throw new Error('unexpected prompt tool: ' + name);
  if (!ctx.taskUpdate || ['new', 'continued'].includes(ctx.taskUpdate.kind)) {
    for (const name of sceneContract(deps, ctx).requiredTools)
      if (!names.includes(name)) throw new Error('scene requires unavailable tool: ' + name);
  }
}

/** Validate protocol references against the same capability set actually registered for this stage. */
const PROTOCOL_TOOLS = [
  'start_task',
  'update_task',
  'clarify_task',
  'acknowledge_task',
  'record_request',
  'find_suppliers',
  'find_peer_supply',
  'reply_in_group',
  'search_information',
  'read_web_page',
  'market_search',
  'market_enrich',
  'xhs_search',
  'xhs_read_notes',
  'reply_with_xhs_notes',
  'record_task_progress',
  'read_task_sources',
  'reply_to_request',
  'reply_request_status',
  'ask_clarification',
  'close_demand',
  'do_nothing',
  'react',
  'finish_research',
] as const;
export function validatePromptReferences(prompt: string, tools: ReadonlySet<string>): void {
  for (const name of PROTOCOL_TOOLS)
    if (new RegExp('\\b' + name + '\\b').test(prompt) && !tools.has(name))
      throw new Error('prompt references unavailable tool: ' + name);
}
