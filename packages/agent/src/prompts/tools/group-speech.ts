/** P53 group speech acts: a fact-free half line, and pointing the asker at a member. */
export const SAY_BRIEFLY = {
  description:
    'SENDS a short fact-free line into the group as a reply to the current message: catch the mood, confirm, ask back, or say a member knows this better. No numbers, links, places, prices or shop names; anything factual needs research and reply_to_request.',
  params: {
    text: 'At most about 40 characters, in the group register. No facts, no search narration.',
  },
  feedback: {
    tooLong: 'Keep say_briefly to one short line of about 40 characters at most.',
    hasFacts:
      'say_briefly carries no facts: drop numbers, links, prices and place or shop names, or research and use reply_to_request.',
    reportsSearch:
      'Do not narrate searching (没查到 / 没找到 / 目录); say the thing itself or stay silent.',
    unknownMessage: 'cannot reply: the current message id is unknown',
  },
} as const;

export const REFER_MEMBER = {
  description:
    'SENDS a short line into the group that points the asker at another member who publicly said something relevant (an offer, local knowledge). The line is posted as a reply to the asker and mentions that member. Use only an alias from groupConversation, groupView.peerOffers or groupView.memberNotes; never the asker.',
  params: {
    alias:
      'The member alias exactly as shown in groupConversation / groupView (for example 成员3fa2).',
    text: 'One short line addressed to that member, about what they said publicly; do not write the alias or a name, the mention is added automatically. No facts they did not say.',
  },
  feedback: {
    unknownAlias:
      'That alias is not in groupConversation or groupView; refer only to a member shown there.',
    isAsker: 'Do not refer the asker to themselves.',
    tooLong: 'Keep refer_member to one short line of about 40 characters at most.',
    hasName: 'Do not write the alias or a name in text; the mention is added automatically.',
    dailyLimit: 'A2H already pointed people at this member twice today; answer another way.',
  },
} as const;
