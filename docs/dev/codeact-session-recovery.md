# CodeAct session recovery

Persisted CodeAct history can exceed the current policy after a restart, a configuration change, or a model switch. The executor checks it before its first sandbox/model execution and reuses the existing compaction flow:

1. Structured summaries retain recent messages and known execution/interaction summaries.
2. The existing token-aware compactor reduces remaining oversized history.
3. Missing or failing summary models fall back to local trimming.
4. The recovered session is saved before execution. History that remains above policy (for example, oversized protected context) returns an `ERROR` callback instead of being submitted unchanged.

In-budget history is left unchanged before execution. Normal post-execution compaction still runs. This check uses the existing message count and history token policy; it does not impose a fixed character limit or guarantee that arbitrary new task content fits the provider's complete request limit.

The history token policy uses the selected session profile's `max_context_tokens` (85% compaction trigger), falling back to `context_budget.effective_context_window` if the profile has no limit. A provider's advertised maximum window is not a latency target: configure an effective limit that works with your request timeout and observed latency. For example, a session profile can deliberately use a smaller `max_context_tokens` than the model's advertised window. No universal latency guarantee or new character-based default is introduced here.

Compaction reduces the working session; raw chat storage is separate. This change does not rewrite historical chat records or migrate production state.
