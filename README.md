# QQ Bot ACP

Connect an official QQ Bot to any agent that implements the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com/) over stdio.

The bridge keeps bot-wide configuration under the operating-system user's home
directory, routes each QQ conversation to an isolated ACP session, and
automatically accepts ACP tool permission requests.

## Requirements

- Node.js 20 or newer
- A bot created on the QQ Open Platform
- An ACP-compatible agent command

## Create a QQ bot

Use the official QQ Open Platform:

- Management console: <https://q.qq.com/>
- Official bot documentation: <https://bot.q.qq.com/wiki/>
- Introduction and access guide:
  <https://bot.q.qq.com/wiki/bot_new_product-intro/>
- API authentication:
  <https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/api-use.html>

1. Open <https://q.qq.com/> and sign in by scanning the QR code with QQ.
2. Complete developer identity verification if requested.
3. Select **创建机器人** (**Create Bot**).
4. Enter the bot's name, avatar, description, and other required details.
5. Open the newly created bot's development/settings page.
6. Copy its **AppID**.
7. Generate or reveal its **AppSecret**, then save it immediately. QQ may not
   display the secret again.

## Install

```bash
npm install
npm run build
npm link
```

## Initialize

Store the AppSecret in a local file rather than putting it in a command or the
repository:

```bash
mkdir -p "$HOME/.qq-bot-acp/secrets"
printf '%s' 'YOUR_APP_SECRET' \
  > "$HOME/.qq-bot-acp/secrets/qq-app-secret.txt"
chmod 700 "$HOME/.qq-bot-acp" "$HOME/.qq-bot-acp/secrets"
chmod 600 "$HOME/.qq-bot-acp/secrets/qq-app-secret.txt"
```

Then initialize the bridge:

```bash
qq-bot-acp init \
  --app-id "YOUR_APP_ID" \
  --client-secret-file "$HOME/.qq-bot-acp/secrets/qq-app-secret.txt" \
  --agent "npx" \
  --agent-arg "@github/copilot" \
  --agent-arg "--acp" \
  --cwd "/path/to/agent-workspace"
```

Initialization is the only CLI configuration surface besides administrator
bootstrap. It refuses to overwrite an existing configuration.

The default persistent directory is:

```text
~\.qq-bot-acp\
├── config.json
├── config.proven.json
├── config.failed.json
├── state.json
├── sessions.json
├── logs\
└── media\
```

Use `--instance NAME` during both initialization and startup to select
`~\.qq-bot-acp\instances\NAME\`.

## Bootstrap the administrator

Start the bot:

```powershell
qq-bot-acp
```

Before an administrator exists, only `/id` is accepted. Privately send `/id`
to the bot, copy the returned bot-scoped C2C OpenID, stop the process, and run:

```powershell
qq-bot-acp --admin-openid "YOUR_OPENID"
```

`--admin-openid` persists the initial administrator and is rejected after the
administrator list becomes non-empty. QQ OpenIDs are scoped to a specific bot;
a numeric QQ account number cannot replace one.

## Chat configuration

Bot-wide changes are accepted only from configured administrators in private
chat:

```text
/config
/config get agent.command
/config agent.command "my-agent"
/c agent.args ["acp","--profile","work"]
/c sessions.idleTimeoutMs 3600000
/config status
```

Values use JSON when appropriate; an unquoted scalar is treated as text.
Configuration writes are atomic. After the QQ gateway authenticates, reaches
ready state, and the ACP agent passes `initialize` plus `session/new`, the
configuration is copied to `config.proven.json`. If the next launch fails, the
candidate is archived as `config.failed.json` and the proven configuration is
restored automatically.

Changes under `qq.*` require a restart. Agent changes terminate active ACP
processes so each conversation starts against the new agent.

## Output formatting and streaming

Agent responses stream to QQ at complete Markdown block boundaries instead of
waiting for the entire ACP turn. Small token fragments are buffered until at
least `output.streamMinChars` characters are available, and fenced code blocks
are kept together. QQ permits at most five passive replies to one message, so
the bridge reserves the final reply for remaining output and marks content
that must be truncated.

By default, common Markdown is converted to readable plain QQ text. Native QQ
Markdown requires separate invite-only approval for the bot, including
approval for passive replies. Approved bots can select native rendering:

```text
/c output.markdownMode "native"
```

In plain mode, LaTeX expressions delimited by `\[ ... \]`, `$$ ... $$`,
`\(...\)`, or `$...$` are converted to readable Unicode text. Common symbols,
fractions, roots, superscripts, subscripts, and `\text{...}` content are
supported; fenced code remains unchanged.

Output behavior can be adjusted from an administrator private chat:

```text
/c output.markdownMode "plain"
/c output.streamResponses true
/c output.streamMinChars 400
/c output.textChunkLimit 2000
```

Set `output.markdownMode` to `"raw"` to retain the previous unformatted text
behavior, or set `output.streamResponses` to `false` to wait for turn
completion before replying.

## Sending artifacts

The bridge automatically gives each ACP session a loopback-only HTTP MCP server
named `qq-artifacts`; no change to `agent.args` is needed. An agent can
proactively publish an image to the current QQ conversation by calling:

```text
send_artifact({ "path": "output/chart.png", "caption": "Optional caption" })
```

The path may be absolute or relative to `agent.cwd`, but the resolved file must
remain inside that directory. Merely reading a media file does not send it:
upload occurs only when the agent explicitly calls `send_artifact`.

Artifact delivery supports PNG/JPEG images, MP4 video, and SILK/MP3/WAV/OGG
voice audio up to 20 MiB per file in direct and group chats. Calls are accepted
only while handling an active QQ message, duplicate content is sent once per
turn, and at most two artifacts can be sent per turn so QQ's
five-passive-reply budget retains room for text. The configured ACP agent must
advertise HTTP MCP support.

## ACP session configuration

Session options belong to the current QQ conversation and configured agent:

```text
/session-config
/session-config model "MODEL_ID"
/sc reasoning_effort "high"
/sc reset
```

The keys come from the active agent's advertised ACP
`SessionConfigOption[]`. Options are validated through
`session/set_config_option`, persisted, and reapplied when that conversation's
ACP session is recreated. Send a normal message before setting an option.

Other bridge commands:

```text
/acp-cancel
/acp-new
/id
```

## Agent examples

GitHub Copilot:

```powershell
--agent "npx" --agent-arg "@github/copilot" --agent-arg "--acp"
```

Claude Code ACP:

```powershell
--agent "npx" --agent-arg "@agentclientprotocol/claude-agent-acp"
```

Gemini CLI:

```powershell
--agent "npx" --agent-arg "@google/gemini-cli" --agent-arg "--experimental-acp"
```

Any other executable is supported if it reads and writes ACP NDJSON over
stdin/stdout.

## Access and session behavior

- Direct, group `@`, and guild channel messages are supported.
- `access.allowFrom` and `access.groupAllowFrom` default to `["*"]`.
- Global `/config` commands always require a direct-message administrator,
  regardless of those allowlists.
- Each conversation has its own serialized queue, agent subprocess, and ACP
  session.
- Text and image prompts are forwarded to ACP. Other attachments are exposed
  to the agent as source URLs.
- Agent text is split to the configured QQ message limit before delivery.
- ACP permission requests automatically select an allow option.

## Acknowledgements

This project builds on ideas and implementation patterns from:

- [formulahendry/wechat-acp](https://github.com/formulahendry/wechat-acp),
  especially its ACP stdio client, per-conversation agent session lifecycle,
  prompt adaptation, and session configuration handling.
- [tencent-connect/openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot),
  the official QQ Bot channel plugin for
  [OpenClaw](https://github.com/openclaw/openclaw), especially its QQ Open
  Platform authentication, WebSocket gateway, event normalization, reconnect,
  and outbound messaging patterns.

`qq-bot-acp` combines these approaches into a standalone QQ-to-ACP bridge; it
does not require the OpenClaw runtime.
