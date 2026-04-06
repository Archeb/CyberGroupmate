**Current time:** {{currentTime}}

**Task:** Synthesize **{{count}}** events for user **{{userId}}** into one merged memory summary.

**Input line format:** `- [<ISO date>] (sentiment:positive|neutral|negative, significance:0-1) <summary>`

**Events:** {{eventLines}}

**Output:** Strict JSON only, no fences. Schema: `{"overallSentiment":"positive|neutral|negative|mixed","highlights":["…"],"relationshipTrend":"…"}`

**Fields:** `overallSentiment` — weight by significance; `mixed` if conflicted. `highlights` — 1–3 distilled items: (1) turning points (2) unique/funny (3) significance>0.7; standalone wording; `[]` if thin. `relationshipTrend` — one sentence on change (good: concrete shift; bad: “normal” / “still chatting”); if flat: `"Flat interaction; no clear change."`
