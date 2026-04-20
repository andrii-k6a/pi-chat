# pi-chat

Chat bridge for pi with:
- Discord server channels
- Telegram DMs and groups

Current implementation includes:
- account-first `/chat-config` flow
- guided Discord onboarding with invite URL and server selection
- guided Telegram DM/group observation flow
- discovery cache per account
- one JSONL log per configured channel
- extension-owned queue semantics modeled after `pi-telegram`
- live typing indicators and streamed previews
- service-aware formatting and streaming-safe markdown handling
- attachments copied into the workspace under `.pi-chat/` and exposed to the agent as local paths
- remote turns are restricted to the built-in `read`, `write`, `edit`, `ls`, `grep`, `find` tools plus `chat_attach`, and all file/path operations are limited to the current working directory

Config lives at:

```text
~/.pi/agent/chat/config.json
```

Discovery cache lives under:

```text
~/.pi/agent/chat/cache/
```

## Install

```bash
pi install /absolute/path/to/pi-chat
```

## Development

```bash
cd pi-chat
npm install
npm run check
```

## Commands

- `/chat-config`
- `/chat-list`
- `/chat-connect <account/channel>`
- `/chat-disconnect`
- `/chat-status`

## Credits

`pi-chat` includes vendored/adapted logic inspired by Vercel Chat SDK (MIT), especially around markdown formatting conventions and streaming markdown handling. See:
- `src/render/format.ts`
- `src/render/streaming-markdown.ts`
- `src/render/streaming.ts`
