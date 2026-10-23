import type { AgentDeps, MatchContext } from '../../context.js';

export type SceneId =
  | 'catalogue'
  | 'marketplace'
  | 'information'
  | 'health_access'
  | 'official'
  | 'lifestyle'
  | 'unsupported';
export interface Scene {
  id: SceneId;
  workflow: string;
  tools: readonly string[];
  requiredTools: readonly string[];
}
export const scenes: Record<SceneId, Scene> = {
  catalogue: {
    id: 'catalogue',
    tools: ['record_request', 'find_suppliers', 'find_peer_supply', 'reply_in_group'],
    requiredTools: ['record_request', 'find_suppliers'],
    workflow:
      'For moving, end-of-tenancy cleaning or furniture services, call record_request then find_suppliers. The writer names the returned catalogue providers; note which fit best. Starting/hourly rates are not a job quote. Ask only for scope that changes the search or quote. If the catalogue is empty, public information research may find useful evidence; keep unverified providers distinct from catalogue entries.',
  },
  marketplace: {
    id: 'marketplace',
    tools: ['market_search', 'market_enrich'],
    requiredTools: [],
    workflow:
      'Search A2H for second-hand items, housing, carry or companions. market_search needs separate subjects, their aliases, explicit hard conditions and soft preferences; use selected task goal IDs. Search subjects independently, then use source-attested aliases or a productive next page for missing coverage. Preserve the original trade direction supplied by the server. Read market_enrich for shortlisted refs before replying. A bundle price is not an individual item price; an active post can contain sold items. Do not replace a hard rent cap with an assumed all-in total. Prefer a few eligible options; treat leads as partial, never carry facts from excluded offers, and record the selected m refs. Once the marketplace has returned candidates, spend the remaining turns reading and recording them, not on public web search; web search is only for a fact no listing can give, or when the marketplace has no eligible option.',
  },
  information: {
    id: 'information',
    tools: [],
    requiredTools: [],
    workflow:
      'Find useful public evidence for the current local-life objective. Start with one or two focused public queries using the supplied area and subject, then investigate the concrete gap with an entity-specific query. Ordinary retail purchases seek legitimate obtaining channels, not guaranteed stock. Prefer a useful sourced route with explicit limitations over an invented nearby option. Source discovery and current factual verification are distinct.',
  },
  health_access: {
    id: 'health_access',
    tools: [],
    requiredTools: [],
    workflow:
      'This is legitimate pharmacy/health-service access research. Use official health-service sources for procedures and the retailer own branch page for retail access. Preserve practical obstacles as context, not new diagnoses or search requirements. Do not add drug choices, dosage, diagnosis, symptom questionnaires or private medicine transfers. Published hours do not prove open now or stock. Give at most two source-backed channels without an unsolicited medical warning. Explicit danger or a medical-help request needs appropriate source-backed official help. Ask only a missing practical condition that changes the next action.',
  },
  official: {
    id: 'official',
    tools: [],
    requiredTools: [],
    workflow:
      'Research official procedures or transport using the responsible agency/operator sources. Separate published guidance from eligibility assumptions, optional documents from compulsory proof, and timetable facts from a proposed journey. Check relevant date/year and location. Answer the requested procedure or trip without adding unrelated services. If official evidence is absent, disclose the gap rather than inventing a policy, number or departure time.',
  },
  lifestyle: {
    id: 'lifestyle',
    tools: ['xhs_search', 'xhs_read_notes', 'reply_with_xhs_notes'],
    requiredTools: [],
    workflow:
      'Discover concrete places, activities or shows for the requested occasion. Vary themes only for genuinely broad requests. Optional XHS discovery can identify entities; read available full notes and verify current practical details through official public information when possible. Merge aliases only for the same event, venue and edition. A roundup is a discovery source, not an activity. Distinguish future openings from current events and exclude expired ones. Keep prices scoped to the requested people/components; free child entry does not establish a free family outing. Prefer a few well-supported options over filling a quota.',
  },
  unsupported: {
    id: 'unsupported',
    tools: [],
    requiredTools: [],
    workflow:
      'Job recruitment is outside the supported scope. Do not research, record an unsupported task or promise action.',
  },
};

/** Routing selects capabilities, not permissions: text never grants new tool privileges. */
export function selectScene(ctx: MatchContext): SceneId {
  const category =
    ctx.task?.category ??
    ctx.currentRequest?.demand.category ??
    ctx.requestCategory ??
    ctx.demand?.category;
  const text = [
    ctx.task?.objective,
    ...(ctx.task?.goals.map((g) => g.title) ?? []),
    ctx.currentRequest?.text ?? ctx.demand?.need ?? '',
  ].join(' ');
  if (category === 'job') return 'unsupported';
  if (category === 'housing' || category === 'second_hand') return 'marketplace';
  if (category && ['man_and_van', 'eot_cleaning', 'furniture_service'].includes(category))
    return 'catalogue';
  if (
    /药房|药店|买药|找药|止[疼痛]药|pharmac|painkiller|medicine|paracetamol|ibuprofen/i.test(text)
  )
    return 'health_access';
  if (/\bGP\b|NHS|注册|registration|机场|希思罗|airport|heathrow|官方手续/i.test(text))
    return 'official';
  if (
    ctx.task?.counterparty === 'peer' ||
    ctx.marketIntent === 'carry' ||
    ctx.marketIntent === 'companion' ||
    /帮带|搭子|球友|语伴|carry.on|companion|language.exchange|badminton.*partner/i.test(text)
  )
    return 'marketplace';
  if (
    /看展|展览|博物馆|亲子|餐厅|吃饭|火锅|点心|早茶|吃喝|好玩|周末.{0,8}(玩|去)|exhibition|museum|restaurant|things to do|weekend.*activit/i.test(
      text,
    )
  )
    return 'lifestyle';
  return 'information';
}

export function sceneContract(deps: AgentDeps, ctx: MatchContext): Scene {
  const scene = scenes[selectScene(ctx)];
  const available = scene.tools.filter((name) => {
    if (name.startsWith('market_')) return !!deps.marketSearch;
    if (name === 'xhs_read_notes')
      return !!deps.xhsSearch?.readNote && !!deps.env.XHS_RESEARCH_ENABLED;
    if (name.includes('xhs')) return !!deps.xhsSearch;
    return true;
  });
  return { ...scene, tools: available };
}
