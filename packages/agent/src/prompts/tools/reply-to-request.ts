/**
 * Everything the model reads about reply_to_request: what the tool is for, what each argument
 * holds, and what to change when a draft is sent back. Feedback leads with the fix, then says why.
 * The checks themselves live in tools/reply-to-request.ts.
 */
export const REPLY_TO_REQUEST = {
  description:
    'SENDS the chat line to the current request. Covers advice/steps, partial matches, an honest local no-match, ONE clarification or source unavailability. Complete the user goal even without a perfect offer. Cite k refs from search_information for facts and m refs for valid A2H offers; write the facts yourself, the code adds links under the line when there is a card. Keep explicit role/date/area/budget; never relax must-have constraints or contact people. Still subject to phase/Jev/rate gates.',
  params: {
    text: 'The chat line in the user language: one thing, one or two short sentences, written the way the group writes (see the chat-line rules at the end of the system prompt). Group chats: at most 2 lines and 90 characters (CJK-weighted), one price and one place at most, 镑 not £; private chats: up to 400. No headings, lists, "来源", URLs, contacts, guarantees or promises to act. For no_match, say plainly that nothing turned up, in the group\'s words, without describing the search.',
    details:
      'Almost always null. Fill only when two sources disagree about the recommended option: at most 300 characters, one to three plain sentences, nothing that repeats the chat line, nothing about excluded alternatives.',
    refs: 'At most 6 distinct sources/offers and 24 total reference IDs. Several real passages of one source count as one source, not several links. Known k source refs or k:p passage IDs for evidence-backed answers; m refs for A2H offers. Empty only for clarification/no_match/unavailable. Never invent refs.',
  },
  limits: {
    group: { chars: 90, lines: 2 },
    private: { chars: 400, lines: 8 },
    details: 300,
    rendered: 3700,
    sources: 6,
    refs: 24,
  },
  feedback: {
    researchFollowup: (keys: string[]) =>
      'Run a short focused query for the actual item/venue and the missing condition, or search an alternative that explicitly satisfies it, before replying. The new hard conditions below are still unverified; reading saved sources is not a new search, and a model name does not prove a fact. Stay within the remaining tool/time budget; if sources fail or evidence remains missing, deliver an honest partial answer. Condition keys: ' +
      JSON.stringify(keys),
    nothingUseful: 'not sent: nothing useful to add to this group message; stop without a status',
    typedContacts:
      'Remove typed URLs, contacts, guarantees and transaction actions from the reply; the code appends source links.',
    tooManySources:
      'Keep at most 6 independent sources/offers and 24 reference IDs, inline citations included; several passages of one source count once. Keep only the sources that support this answer.',
    outsidePacket:
      'Cite only the selected delivery packet sources and their real passages; drop facts taken from other discovered alternatives.',
    chatLineTooLong: (limit: { chars: number; lines: number }) =>
      `Write it like a phone message: at most ${limit.lines} lines and ${limit.chars} characters, only the one thing you would say out loud. Drop price ranges and the second thing entirely.`,
    tooManyNumbers:
      'Keep one price and one place in the chat line and delete the other numbers; write 镑 instead of £ and round where you can (六十镑左右).',
    reportsSearch:
      'Delete the sentence that narrates the search (没查到 / 没刷到 / 目录 / 我这边) and the one that sends the asker to verify; say what there is, or say plainly there is nothing.',
    chatLineRegister:
      "Rewrite in the group's typing style: short clauses separated by spaces, no 。 or ： inside the line.",
    detailsRepeatsLine:
      'Drop details (send null): in a group it may hold only a disagreement between two sources about the recommended option (…一个说… 另一个说…), never extra facts, hedges (没写 / 得问 / 确认), the line again or excluded options.',
    detailsTooLong:
      'Cut details to at most 300 characters about the source disagreement only; most replies need no details at all.',
    guaranteedPurchase:
      'Describe the source-backed channel and what still needs checking on arrival. Stock and a successful purchase are not guaranteed by published opening hours, so drop the promise that the user can buy there.',
    inventedOutage:
      'Use the research summary and the available evidence, or ask the necessary question. No recorded source failure exists, so remove the claimed search outage.',
    noSearchYet:
      'Call the appropriate search tool before describing empty results or an outage; if the objective itself is undefined, ask one clarification instead. No search has been attempted for this request.',
    sellerIdentity:
      'Say that the seller is unknown. Seller identity is not established by anonymous offer refs; do not infer same/different sellers or pickup addresses from separate posts.',
    mixedRefs:
      'Cite A2H offer refs (m) and public information refs (k) in separate replies; this draft mixes both.',
    offerIneligible: (choices: unknown) =>
      'Remove the excluded refs AND their facts, then choose the eligible leads below or explain no_match. The offer is unknown, inactive or conflicts with the original hard conditions. Current choices: ' +
      JSON.stringify(choices),
    unselectedInline: 'Name only the selected offers; unselected inline refs are not evidence.',
    completeFitUnconfirmed:
      'Name the supported conditions and the remaining unknown. No selected lead has all essential conditions confirmed, so drop the complete-fit claim.',
    travelUnverified:
      'State the missing exact location and how to check it. Journey duration has not been verified, so drop the reassurance that the trip fits the limit.',
    conflict: (conflicts: unknown) =>
      'Remove these offer refs AND their facts, then choose another source or explain no_match. The selected source explicitly conflicts with a hard condition: ' +
      JSON.stringify(conflicts) +
      '. Unknown conditions are not positive fits.',
    incompleteReview: (reason: string) =>
      'Give an honest unavailable explanation with refs=[] or fewer already-checkable offers. The selected source conflict review is incomplete (' +
      reason +
      '), so do not call it a match.',
    unknownTotal:
      'Distinguish the verified rent from the unconfirmed total. Rent excludes bills and the total cost is unknown, so drop the claim that rent plus bills fits the budget.',
    unsupportedNumbers: (values: string[]) =>
      'Remove, or cite supporting evidence for, the unsupported numerical values ' +
      values.join(', ') +
      '. Citation IDs are not user text.',
    unsupportedFeature: (labels: string[]) =>
      'Remove the claim about ' +
      labels.join(', ') +
      ', or turn it into a question for the seller (你问一句能不能…); the cited post does not mention it, and a model name does not prove a feature.',
    unknownSourceRef: 'Cite only returned source or passage refs.',
    factsNeedSources:
      'Call search_information first, or use no_match/clarification/unavailable without inventing facts: information facts need sources.',
    nhsOnly: 'Cite NHS official evidence for GP registration facts.',
    departureUnverified:
      'Omit the precise departure time and say it must be checked for the actual date. The cited official timetable does not verify it, and fares or frequencies do not imply it.',
    freeNeedsEvidence: 'Cite source evidence for free admission, or remove the claim.',
    noRecordedOutage:
      'Describe what was found, or ask the necessary question. There is no recorded source failure, so do not claim a service outage.',
    noNewEvidence:
      'No new source evidence for this context addition; end quietly without repeating prior recommendations or questions.',
    tooLong: 'Choose fewer sources or offers; the rendered reply is too long.',
    exhaustedZh: '这个我没找到',
    exhaustedEn: 'I haven’t established enough reliable information to recommend an option yet.',
  },
} as const;
