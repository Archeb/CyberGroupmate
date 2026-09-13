# Telegram connection modes

The Dashboard connection selector distinguishes the account type from the protocol:

| Mode | Account / protocol | Credentials |
| --- | --- | --- |
| `bot_api` | Bot / HTTP Bot API | BotFather token |
| `bot` | Bot / MTProto (existing behavior) | Token, API ID, API Hash |
| `userbot` | User / MTProto | API ID, API Hash, phone; interactive code / 2FA |

Existing `bot` settings and omitted modes retain MTProto behavior. Credentials do not automatically select a transport. To use a token-only bot, explicitly choose **机器人（Bot API）** or configure:

```yaml
telegram:
  mode: bot_api
  bot_token: "<BOTFATHER_TOKEN>"
```

Bot API mode supports incoming messages/channel posts, text replies, photo/document/video/audio/voice/sticker media, file downloads, and typing. It uses a single long poller per running client; do not run multiple instances using the same token. The poller starts after a consumer subscribes and advances its offset after all consumers finish. Failed consumers may receive a message again; this is not an exactly-once delivery guarantee. Telegram retains pending updates for at most 24 hours. Editing an old message does not trigger a new message event.

An existing webhook blocks startup and must be removed explicitly by its owner. Group visibility still follows Telegram's privacy-mode and administrator rules. HTTP requests use Node's fetch; this mode does not use the MTProto SOCKS transport (`TG_PROXY`). Ensure the process can reach `api.telegram.org` over HTTPS.

History queries, dialogs, member enumeration, user login, and MTProto native passthrough are unavailable. The scene instructions list the supported host calls, and unsupported calls return an explicit capability error. Use existing `bot` / `userbot` modes when those transports and capabilities are needed, subject to Telegram's own bot restrictions.

References: [Bot API](https://core.telegram.org/bots/api), [Bot privacy FAQ](https://core.telegram.org/bots/faq#what-messages-will-my-bot-get), [MTProto bot authorization](https://core.telegram.org/method/auth.importBotAuthorization).
