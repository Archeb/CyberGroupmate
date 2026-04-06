═══ Attention switch: {{chatTitle}} ({{chatId}}) [{{chatType}}] ═══

## Global snapshot
{{attentionSummary}}

## Recent decisions
{{recentDecisions}}

## Active tasks
{{activeTasks}}

## Decision context
Configured timezone: {{timezone}}
**Current time:** {{currentTime}}
Context snapshot (ingest time): {{snapshotTimestamp}}
Last focus: {{lastAttendedAt}} ({{timeSinceLastAttend}} ago)
Stickiness: {{stickinessLevel}}
Depth: L{{depth}}
Priority multiplier: {{priorityMultiplier}}
{{#recentFeedback}}
Recent observation: {{recentFeedback}}
{{/recentFeedback}}

## Topic registry
{{topicDigests}}

## New messages (since last focus, {{newMessageCount}} total)
{{messages}}

{{#hasCallbacks}}
## Last subagent execution
{{callbacks}}
{{/hasCallbacks}}

{{#hasFastPathHistory}}
## FastPath reply history
{{fastPathHistory}}
{{/hasFastPathHistory}}

{{#groupModel}}
## Chat profile
- Title: {{chatTitle}}
- Description: {{description}}
- Msgs/day: {{avgMessagesPerDay}}
- Engagement: {{engagementLevel}}
- Tone preset: {{tonePreset}}
{{/groupModel}}

{{#activePersons}}
## Active participants
{{activePersons}}
{{/activePersons}}

{{#hasNotes}}
## Notes
{{notes}}
{{/hasNotes}}

{{#hasDispatchedTopics}}
## ⚠ Topics already dispatched
These topics already have in-flight or completed replies—do not dispatch again: {{dispatchedTopicIds}}
{{/hasDispatchedTopics}}

## Your decision
Based on the above, output your decision (JSON `AttendResult`).
