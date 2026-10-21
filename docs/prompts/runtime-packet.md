# 运行时数据包

每次模型调用前以 user 角色注入的 JSON（`matchbot_runtime_context`），不是系统指令。下面是一个合成样例。

## planning

```json
{
  "kind": "matchbot_runtime_context",
  "version": 1,
  "stage": "planning",
  "currentRequest": {
    "text": "狗岛附近哪里买感冒药方便",
    "isActionable": true,
    "demand": {
      "category": "other",
      "confidence": 1
    }
  },
  "taskUpdate": null,
  "verifiedReplyAnchor": null,
  "scopedTasks": []
}
```

## execution

```json
{
  "kind": "matchbot_runtime_context",
  "version": 1,
  "stage": "execution",
  "currentRequest": {
    "text": "狗岛附近哪里买感冒药方便",
    "isActionable": true,
    "demand": {
      "category": "other",
      "confidence": 1
    }
  },
  "taskUpdate": null,
  "verifiedReplyAnchor": null,
  "quotedPublicReply": null,
  "recentReplies": [],
  "groupConversation": [
    {
      "at": "2026-10-20T17:10Z",
      "speaker": "成员a1b2（当前发言者）",
      "text": "狗岛感冒买药去哪方便"
    },
    {
      "at": "2026-10-20T17:11Z",
      "speaker": "成员c3d4",
      "text": "去Boots吧"
    }
  ],
  "selectedTask": null,
  "ambiguousTopics": [],
  "validationFeedback": null,
  "research": {
    "marketSearches": 0,
    "marketListingsFound": 0,
    "marketDetailsRead": 0,
    "informationSearches": 1,
    "informationSourcesFound": 1,
    "pagesRead": 0,
    "xhsSearches": 0,
    "sourceFailures": []
  },
  "historicalEvidenceHints": [],
  "currentPublicEvidence": [
    {
      "ref": "k1",
      "title": "Allens Pharmacy",
      "passages": [
        {
          "id": "k1:p1",
          "text": "Allens Pharmacy, 19 Castalia Square. Open Monday to Friday 9:00 to 18:30."
        }
      ],
      "omittedPassageIds": []
    }
  ],
  "currentMarketEvidence": []
}
```

## finalization

```json
{
  "kind": "matchbot_runtime_context",
  "version": 1,
  "stage": "finalization",
  "currentRequest": {
    "text": "狗岛附近哪里买感冒药方便",
    "isActionable": true,
    "demand": {
      "category": "other",
      "confidence": 1
    }
  },
  "taskUpdate": null,
  "verifiedReplyAnchor": null,
  "quotedPublicReply": null,
  "recentReplies": [],
  "groupConversation": [
    {
      "at": "2026-10-20T17:10Z",
      "speaker": "成员a1b2（当前发言者）",
      "text": "狗岛感冒买药去哪方便"
    },
    {
      "at": "2026-10-20T17:11Z",
      "speaker": "成员c3d4",
      "text": "去Boots吧"
    }
  ],
  "deliveryContract": {
    "referenceFamilies": [
      "k",
      "m"
    ],
    "unresearchedConditions": [],
    "requiresTaskClarification": false,
    "otherSourceCounts": {
      "xhs": 0,
      "legacyWeb": 0
    }
  },
  "selectedTask": null,
  "ambiguousTopics": [],
  "validationFeedback": null,
  "research": {
    "marketSearches": 0,
    "marketListingsFound": 0,
    "marketDetailsRead": 0,
    "informationSearches": 1,
    "informationSourcesFound": 1,
    "pagesRead": 0,
    "xhsSearches": 0,
    "sourceFailures": []
  },
  "historicalEvidenceHints": [],
  "currentPublicEvidence": [
    {
      "ref": "k1",
      "title": "Allens Pharmacy",
      "passages": [
        {
          "id": "k1:p1",
          "text": "Allens Pharmacy, 19 Castalia Square. Open Monday to Friday 9:00 to 18:30."
        }
      ],
      "omittedPassageIds": []
    }
  ],
  "currentMarketEvidence": []
}
```
