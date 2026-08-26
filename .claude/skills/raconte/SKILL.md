---
name: raconte
description: Run AI voice interviews from the terminal, a script, or an AI agent with the Raconte CLI (@raconte/cli). Use it when you want to create an interview from a prompt, invite participants by email (or generate a shareable link), send and track invitations, bulk-invite a list of people, or read interview transcripts and per-message insights, without opening the web app. Also the right tool to automate interview workflows in CI/scripts or to let an agent operate Raconte over the API with one command.
homepage: https://raconte.ai
---

# Raconte CLI

`@raconte/cli` drives [Raconte](https://raconte.ai), AI-run voice interviews, from a terminal or an AI agent. You craft a prompt, send a link, the AI runs a natural voice conversation, and you get transcripts and insights.

The CLI wraps the public Raconte REST API. Every command authenticates with an organization API key and prints JSON, so it is safe to script and easy for an agent to parse.

## Install

Global (provides the `raconte` command everywhere):

```bash
npm install -g @raconte/cli
```

Or run without installing:

```bash
npx @raconte/cli interviews list
```

Requires Node.js 20 or newer.

## Authenticate

Create an organization API key in **Settings, API** on raconte.ai, then expose it as an environment variable:

```bash
export RACONTE_API_KEY="your-key"
```

Every command reads `RACONTE_API_KEY`. You can also pass `--api-key <key>` per call.

## Output and exit codes

- All output is JSON on stdout. Pipe it to `jq` or parse it directly.
- Errors are JSON on stderr: `{ "status": <http>, "error": <body> }` for API errors, `{ "error": <message> }` for transport or usage errors.
- Exit codes: `0` success, `2` usage error (bad argument, missing key, invalid JSON), `3` auth failure (401/403), `1` any other failure.
- Commands never prompt. They are deterministic and non-interactive.

## Rate limit

The API allows 300 requests per minute per API key, shared across every endpoint. Past it a command exits `1` with `{ "status": 429, ... }` on stderr. Wait a minute and retry rather than looping. A bulk send counts as one request, so prefer `invitations create-bulk` over a loop of `invitations create`.

## Commands

Run `raconte --help`, `raconte interviews --help`, or `raconte <group> <command> --help` for the authoritative, up-to-date list.

### Interviews

| Command | Description |
| --- | --- |
| `raconte interviews list [--archived]` | List interviews (active, or archived only). |
| `raconte interviews get <id>` | Get one interview. |
| `raconte interviews create --prompt <text> --locale <code> --voice-id <uuid> [...]` | Create an interview. |
| `raconte interviews update <id> [...]` | Update an interview. |
| `raconte interviews archive <id>` | Archive an interview. |
| `raconte interviews restore <id>` | Restore an archived interview. |
| `raconte interviews logs <id>` | Get the activity logs. |
| `raconte interviews regenerate-intro <id>` | Regenerate the AI intro message. |
| `raconte interviews regenerate-first-message <id>` | Regenerate the AI first message. |

`create` accepts `--prompt` (10 characters minimum), `--locale` (e.g. `en`, `fr`) and `--voice-id` as the core fields, plus optional `--title`, `--intro`, `--first-message`, `--email`, and `--invitees '<json array>'` to send to several people at once. Find a `--voice-id` with `raconte voices list`.

`update` accepts `--title`, `--prompt`, `--intro`, `--first-message`, `--locale`, `--voice-id`, `--max-minutes` (maximum minutes per call, silence is not counted), `--max-responses` (maximum exchanges, i.e. invitee turns, before the interview stops), and `--disable-org-system-prompt`.

### Invitations

| Command | Description |
| --- | --- |
| `raconte invitations list <interviewId>` | List the invitations of an interview. |
| `raconte invitations get <invitationId>` | Get one invitation. |
| `raconte invitations create <interviewId> [--name --email]` | Create an invitation. With no fields, returns a blank shareable invitation (a link); name/email only pre-fill it and are not sent. |
| `raconte invitations create-bulk <interviewId> --invitees '<json>'` | Bulk-create invitations and send each one right away. |
| `raconte invitations update <invitationId> --name <name>` | Update the invitee display name. The email is not editable here (use `send`). |
| `raconte invitations send <invitationId> --email <email>` | Send by email (sets the contact and dispatches). |
| `raconte invitations cancel <invitationId>` | Cancel a ready invitation. |
| `raconte invitations reactivate <invitationId> [--send-email]` | Reactivate a cancelled invitation, or reopen a completed one (it becomes reopened) so the invitee can resume it from their link. `--send-email` emails the invitee a resume link when reopening a completed invitation. |
| `raconte invitations complete <invitationId>` | Mark a reopened invitation as completed: finalizes it, regenerates insights and clears the incomplete flag. |
| `raconte invitations archive <invitationId>` | Archive an invitation. |
| `raconte invitations restore <invitationId>` | Restore an archived invitation. |
| `raconte invitations logs <invitationId>` | Get the activity logs. |
| `raconte invitations audio-url <invitationId> <messageId>` | Get a temporary audio URL for a transcript message. |

**Getting a shareable link without sending anything:** `raconte invitations create <interviewId>` with no other field creates a READY invitation and returns it. The link to share is `https://raconte.ai/i/<slug>`, where `<slug>` is the `slug` field of the response. Anyone with that link can take the interview; no email is sent. To deliver by email instead, use `invitations send` (or pass `--email` to `create` to pre-fill, then `send`).

To change a recipient's email you always send: there is no way to alter the contact silently. `update` only changes the display name.

### Share (reusable public link)

One reusable public link per interview, off by default. Unlike an invitation (one person, one transcript), each visitor who opens the link and submits the short pre-interview form gets their own invitation and transcript. The link is `https://raconte.ai/share/<slug>`.

| Command | Description |
| --- | --- |
| `raconte share get <interviewId>` | Get the reusable public link config (slug, url, form policy, limits, usage count). A disabled one is created on first access. |
| `raconte share update <interviewId> [...]` | Enable the link, choose what the form asks, and set limits. |

`update` accepts `--enabled` (`--no-enabled` to turn off), the per-field form policy `--ask-name` / `--ask-email` (each `off | optional | required`), and the limits `--max-interviews`, `--max-per-ip-per-day`, `--opens-at <iso>`, `--closes-at <iso>`, `--dedupe-by-contact` (`--no-dedupe-by-contact`), `--access-code`, and `--allowed-email-domains "acme.com,acme.fr"` (enforced only when `--ask-email` is required). Clear a nullable limit with `--data '{"maxInterviews": null}'`; pass an empty string to clear `--access-code` or `--allowed-email-domains`.

### Voices

| Command | Description |
| --- | --- |
| `raconte voices list [--language <code>]` | List the voices you can pass as `--voice-id`. Public, no API key required. |
| `raconte voices test-audio-url <voiceId>` | Get a short-lived preview audio URL for a voice. Public, no API key required. |

Mutating commands also accept `--data '<json object>'` for the full request body. Explicit flags override keys from `--data`.

## Examples

Pick a voice, then create an interview and capture its id:

```bash
VOICE=$(raconte voices list --language en | jq -r '.[0].id')
ID=$(raconte interviews create \
  --title "Onboarding feedback" \
  --prompt "Ask the user about their first week, follow up on friction points." \
  --locale en \
  --voice-id "$VOICE" | jq -r '.[0].id')
```

`interviews create` returns an **array**, one row per invitation it sends (`--email` / `--invitees` can create several), each carrying the interview `id`. With no invitees you still get one row, so read the interview id with `.[0].id`.

Get a shareable link without sending anything:

```bash
raconte invitations create "$ID" | jq -r '"https://raconte.ai/i/" + .slug'
```

Invite several people in one call (each is emailed right away):

```bash
raconte invitations create-bulk "$ID" \
  --invitees '[{"name":"Ada","email":"ada@example.com"},{"name":"Bo","email":"bo@example.com"}]'
```

Read an interview's invitations and their statuses:

```bash
raconte invitations list "$ID" | jq '.[] | {id, status, email}'
```

## Programmatic use

For TypeScript or Node apps, use the SDK instead of shelling out: [`@raconte/node-sdk`](https://raconte.ai/en/docs/sdk) exposes the same surface as typed functions with Zod schemas.

## Reference

- Product docs: https://raconte.ai/en/docs
- REST API reference: https://raconte.ai/en/docs/api
- MCP server (for MCP-native agents): https://raconte.ai/en/docs/mcp
