Information extraction: analyze the conversation; output **strict JSON** (no fences). Schema: `{"summary":"1–3 sentences","keyPoints":["…"],"newFacts":[{"subject":"userId|chatId|theme","content":"…","category":"biographical|preference|anecdote|opinion|plan|relationship|general"}],"personUpdates":[{"userId":"…","displayName":"…","traits":["…"],"interests":["…"],"communicationStyle":"…"}],"agentStateUpdate":"…"}`

Rules: use `[]`/`""` when empty; unknown userId in personUpdates → use displayName; `newFacts[].category` must be enum above; keep short.
