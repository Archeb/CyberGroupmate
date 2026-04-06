## Task

Reflect on the chat from the data above. Output **one strict JSON object** (no markdown fences). Sections may include existing facts and identity — read before updating.

**Sections (split by `---`, optional):** Group info | Recent topics (label, summary, participants, keywords, sentiment, agent involvement, message count) | Recent interactions (agent_replied/agent_mentioned/direct_message/reaction) | Participant stats | Existing profiles (Tier, traits, interests, style, relation, names/aliases) | Existing facts (ids)

**Principles:** `personUpdates` — only changed fields, no stale repeats. `factUpdates` — add without `id`; update with `id`; delete `id`+`action:"delete"`; concrete facts only; flag anecdotes. `interactionQuality` required; **never output `dunbarTier`**. `topicsSummary` — short per topic. `insights` — actionable, not generic. `groupUpdates` — engagementLevel, hotTopics(3–5), tabooTopics, description, communicationNorms. `identityUpdates` — only new evidence vs known aliases.

**Schema:** `{"personUpdates":[{"userId":"","traits":[],"interests":[],"communicationStyle":"","relationToAgent":"","interactionQuality":"friendly|dependent|instrumental|hostile","dunbarReason":""}],"identityUpdates":[{"userId":"","displayName":"","aliases":[]}],"groupUpdates":{"agentRole":"","engagementLevel":"high|medium|low","hotTopics":[],"tabooTopics":[],"description":"","communicationNorms":[],"recentFeedback":""},"factUpdates":[{"id":"","subject":"","content":"","category":"preference|biographical|anecdote|relationship|skill|opinion","action":"upsert|delete"}],"topicsSummary":[{"label":"","summary":"","participants":[],"sentiment":"positive|neutral|negative|mixed"}],"insights":""}`

**Quality enum:** friendly | dependent | instrumental | hostile (no dunbarTier). **Tier hints (reasoning):** T1 core ≤15; T2 familiar ≤50; T3 acquaintance ≤150; T4 stranger. **facts:** omit `id` for new; duplicate not. **identity:** aliases = other names; `[]` if unchanged.
