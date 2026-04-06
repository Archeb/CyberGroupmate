═══ {{taskId}} ═══
Chat: {{chatTitle}} (chatId: {{chatId}}) [{{chatType}}]

## Task plan (follow strictly; do not be dragged off by past session tone)

{{decisions}}
Tone: {{toneGuidance}}

{{#hasMiniCodeActReport}}
## Pre-executed actions
These ran before task dispatch. Verify; note any mismatch in your final summary.
{{miniCodeActReport}}
{{/hasMiniCodeActReport}}

## Topic summary
{{topicSummary}}

## People context
{{personContext}}

## Target messages
{{targetMessages}}

{{#availableStickers}}
## Stickers available
Send via `telegram.sendSticker` when a sticker fits the mood; do not force it.
{{availableStickers}}
{{/availableStickers}}

Complete the task with code: do work (download/query/process), verify, then send messages.
