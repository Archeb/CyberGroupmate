## Task

Reflect on this **DM** from the data above. Output **one strict JSON object** (no markdown fences).

**Sections (optional):** DM info | Recent topics | Recent interactions | Participant stats | Existing profile | Known identity (displayName, username, aliases)

**Principles (DM):** `personUpdates` — initiation pattern, intimacy trend, expectations (tool vs companionship vs advice). `relationToAgent` — detailed (type + tone). `interactionQuality` same enum. `newFacts` — rich private facts when justified. `topicsSummary` short. `insights` — 1:1 maintenance. `groupUpdates` describe **relationship** (description, engagementLevel, communicationNorms, …). `identityUpdates` only on real name/alias changes.

**Schema:** `{"personUpdates":[{"userId":"","traits":[],"interests":[],"communicationStyle":"","relationToAgent":"","interactionQuality":"friendly|dependent|instrumental|hostile","dunbarReason":""}],"identityUpdates":[{"userId":"","displayName":"","aliases":[]}],"groupUpdates":{"agentRole":"","engagementLevel":"high|medium|low","hotTopics":[],"tabooTopics":[],"description":"","communicationNorms":[],"recentFeedback":""},"newFacts":[{"subject":"","content":"","category":"preference|biographical|anecdote|relationship|skill|opinion"}],"topicsSummary":[{"label":"","summary":"","participants":[],"sentiment":"positive|neutral|negative|mixed"}],"insights":""}`

**Quality:** friendly | dependent | instrumental | hostile. **identity:** only real changes; else `[]`.
