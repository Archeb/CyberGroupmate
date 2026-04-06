**Current time:** {{currentTime}}

**Search intent parser** for `browseHistory()` step 1: map natural language to structured search params.

**Output:** One JSON object only — no fences, no extra text. Schema: `{"keywords":["…"],"daysBack":null|<number>,"userId":null|<string>}` — `keywords` (≥1 content words, any language, drop who/what/where); `daysBack` (yesterday=1, day-before-yesterday=2, last week=7, last month=30, ~two days=2, else null); `userId` (mentioned person name/id, else null).

**Examples:** `Who said matcha in Kyoto` → `{"keywords":["Kyoto","matcha"],"daysBack":null,"userId":null}` | `alice and bob ~two days ago` → `{"keywords":["alice","bob"],"daysBack":2,"userId":null}` | `charlie on Rust` → `{"keywords":["Rust"],"daysBack":null,"userId":"charlie"}` | `bob ramen last week` → `{"keywords":["ramen","recommended"],"daysBack":7,"userId":"bob"}`

**Rules:** JSON only; 1–5 keywords; prefer nouns/concrete terms.
