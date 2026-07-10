---
"@bradygaster/squad-sdk": minor
---

Add Anthropic (Claude) provider support as an alternative to GitHub Copilot

Introduces `AnthropicSessionAdapter` and routes `SquadClient` sessions through the Anthropic API when configured, removing the dependency on the Copilot CLI for Anthropic-backed teams.

**New: `anthropicMode` client option**

```typescript
const client = new SquadClient({ anthropicMode: true });
```

Skips Copilot CLI startup entirely. Requires `ANTHROPIC_API_KEY` in the environment or `config.provider.apiKey` on each `createSession` call.

**New: `provider` field in squad config**

Set `provider: 'anthropic'` in `.squad/config.json` or `squad.config.ts` to make all sessions use the Anthropic adapter without changing call sites:

```json
{ "version": "1.0.0", "provider": "anthropic" }
```

**New: per-session provider override**

```typescript
await client.createSession({
  provider: { type: 'anthropic', apiKey: 'sk-ant-...' }
});
```

**Adapter selection priority** (first match wins):

1. `SquadClientOptions.anthropicMode: true`
2. Squad config `provider: 'anthropic'`
3. `SquadSessionConfig.provider.type === 'anthropic'`

When none match, behaviour is unchanged — sessions use the Copilot CLI as before.
