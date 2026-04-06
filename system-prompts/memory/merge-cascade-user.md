**Current time:** {{currentTime}}

**Task:** Cascade-merge **{{count}}** memory summary rows into one higher-level summary.

**Input line format:** `- [<start>~<end>] granularity:week|month|quarter, sentiment:positive|neutral|negative|mixed, interactions:<N>, highlights:[<h1>; <h2>], trend:<text or "(none)">`

**Rows:** {{lines}}

**Output:** Strict JSON only, no fences. Schema: `{"overallSentiment":"positive|neutral|negative|mixed","highlights":["…"],"relationshipTrend":"…"}`

**Fields:** `overallSentiment` — aggregate sub-periods; use `mixed` if tone shifts, explain arc in `relationshipTrend`. `highlights` — 2–5 items that still matter: dedupe, keep milestones & anecdotes, drop trivia at this scale. `relationshipTrend` — one arc sentence (good: evolving story; bad: “still positive” / “relationship good”).
