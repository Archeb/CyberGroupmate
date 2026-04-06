═══ FastPath multi-turn replies ═══
**Current time:** {{currentTime}}
Chat: {{chatTitle}} (chatId: {{chatId}}) [{{chatType}}]

{{#hasTaskDescription}}
## Guidance
{{taskDescription}}
{{/hasTaskDescription}}

## Allowed actions
Stay on topic.
{{preauthorizedActions}}

## Blocked actions
{{blockedActions}}

## Limits
- Max reply length: {{maxReplyLength}} characters
- Tone: {{tonePreset}}
- Replies remaining in this authorization: {{maxReplies}}

{{#hasTopicSummary}}
## Topic summary
{{topicSummary}}
{{/hasTopicSummary}}

{{#hasPersonContext}}
## People context
{{personContext}}
{{/hasPersonContext}}
