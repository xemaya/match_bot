/**
 * Everything the model reads about reply_to_request: what the tool is for, what each argument
 * holds, and what to change when a draft is sent back. Feedback leads with the fix, then says why.
 * The checks themselves live in tools/reply-to-request.ts.
 */
export const REPLY_TO_REQUEST = {
  description:
    'SENDS the reply to the current request: the chat line the asker reads, plus an evidence card the code folds under it. Covers advice/steps, partial matches, an honest local no-match, ONE clarification or source unavailability. Complete the user goal even without a perfect offer. Cite k refs from search_information for facts and m refs for valid A2H offers; write the facts yourself, the code folds the links under the line. Keep explicit role/date/area/budget; never relax must-have constraints or contact people. Still subject to phase/Jev/rate gates.',
  params: {
    text: 'The chat line in the user language: conclusion first, then the one recommended option with its key fact (name, where, when). Group chats: at most three short lines and 150 characters; private chats: up to 400. Natural prose, no headings, lists, "来源", URLs, contacts, guarantees or promises to act. For no_match/unavailable, say in one line where it got stuck and one thing the asker can do now.',
    details:
      'Usually null: most replies are the chat line alone. Fill it only for one of three things the asker needs and the line has no room for: a second option, a conflict between sources about the recommended one, or the one condition that must be checked before acting. At most 300 characters, one to three plain sentences, no repetition of the line, nothing about excluded alternatives.',
    refs: 'At most 6 distinct sources/offers and 24 total reference IDs. Several real passages of one source count as one source, not several links. Known k source refs or k:p passage IDs for evidence-backed answers; m refs for A2H offers. Empty only for clarification/no_match/unavailable. Never invent refs.',
  },
  limits: {
    group: { chars: 150, lines: 3 },
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
      `Shorten text to the conclusion and the one recommended option: at most ${limit.lines} lines and ${limit.chars} characters. Drop the rest; keep in details only a second option, a source conflict or the one condition to check.`,
    detailsTooLong:
      'Cut details to at most 300 characters: keep only the second option, the source conflict or the one condition to check, and drop everything else. Most replies need no details at all.',
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
    exhaustedZh: '我没把这件事查清楚，暂时给不了可靠的建议。',
    exhaustedEn: 'I haven’t established enough reliable information to recommend an option yet.',
  },
} as const;
