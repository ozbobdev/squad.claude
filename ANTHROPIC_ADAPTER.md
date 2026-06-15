# Implement Anthropic/Claude Adapter for Squad SDK

## Context

You are working in the repo at `C:\Users\robma\dev\ozbobdev\squad.claude\ANTHROPIC_ADAPTER.md`.

The `@bradygaster/squad-sdk` is currently hardwired to GitHub Copilot via
`@github/copilot-sdk`. The type `SquadProviderConfig` in
`packages/squad-sdk/src/adapter/types.ts` already declares `"anthropic"` as a
valid provider type but it is never consumed. Your job is to wire it up end to
end so that setting `config.provider.type === "anthropic"` routes sessions
through the Anthropic Messages API instead of Copilot.

> **Do not** modify `SquadSession` in `types.ts`. Instead touch `CopilotSessionAdapter` in packages\squad-sdk\src\adapter\client.ts,
Do not alter any existing exports in `package.json`.

---

## Step 1 — Install the Anthropic SDK

Inside `packages/squad-sdk/` run:

```bash
npm install @anthropic-ai/sdk
```

---

## Step 2 — Create `anthropic-adapter.ts`

Create the file:

```
packages/squad-sdk/src/adapter/anthropic-adapter.ts
```

### 2a — Implement `AnthropicSessionAdapter`

The class must satisfy the `SquadSession` interface
(`packages/squad-sdk/src/adapter/types.ts` lines 851–901):

```typescript
export interface SquadSession {
  readonly sessionId: string;
  sendMessage(options: SquadMessageOptions): Promise<void>;
  sendAndWait?(options: SquadMessageOptions, timeout?: number): Promise<unknown>;
  abort?(): Promise<void>;
  getMessages?(): Promise<unknown[]>;
  on(eventType: SquadSessionEventType, handler: SquadSessionEventHandler): void;
  off(eventType: SquadSessionEventType, handler: SquadSessionEventHandler): void;
  close(): Promise<void>;
}
```

#### Constructor

```typescript
constructor(apiKey: string, model: string, systemPrompt?: string)
```

- Create an `Anthropic` client from `@anthropic-ai/sdk` using `apiKey`
- Generate `sessionId` with `crypto.randomUUID()`
- Store `model`, `systemPrompt`, and an empty
  `messages: Anthropic.MessageParam[]` array for conversation history

#### Event System

- Internal `Map<string, Set<SquadSessionEventHandler>>` for listeners
- Public `on(eventType, handler)` and `off(eventType, handler)`
- Private `emit(eventType: string, payload: Record<string, unknown>): void`

#### `sendMessage(options: SquadMessageOptions)`

1. Push the user turn onto history:
   ```typescript
   this.messages.push({ role: 'user', content: options.prompt });
   ```
2. Open a streaming request:
   ```typescript
   anthropic.messages.stream({
     model: this.model,
     max_tokens: 8096,
     system: this.systemPrompt ?? 'You are a helpful software engineering assistant.',
     messages: this.messages,
   })
   ```
3. Map stream events to Squad events in this order:

| Claude stream event | Squad event | Payload |
|---|---|---|
| stream opens | `turn_start` | `{}` |
| `stream.on('text', text)` | `message_delta` | `{ delta: text }` |
| `stream.on('message', msg)` | `message` | `{ content: fullText }` |
| `message.usage` on completion | `usage` | `{ inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, model }` |
| after `usage` | `turn_end` | `{}` |
| after `turn_end` | `idle` | `{}` |
| stream error | `error` | `{ error: err.message }` |

4. After a complete response append to history:
   ```typescript
   this.messages.push({ role: 'assistant', content: fullText });
   ```

#### `sendAndWait(options, timeout = 60000)`

- Call `sendMessage(options)`
- Return a `Promise` that resolves (with `fullText`) when `idle` fires
- Reject with `new Error('timeout')` if `timeout` ms elapses first

#### `abort()`

- Store the active stream reference; call `stream.controller.abort()` when active
- Emit `idle` after abort

#### `getMessages()`

Return `this.messages` as `unknown[]`.

#### `close()`

- Abort any active stream
- Clear `this.messages` and all event listeners

---

### 2b — Tool Mapping

When the session config includes `tools`, convert each `SquadTool` to the
Anthropic format before calling `messages.stream()`:

```typescript
// SquadTool (types.ts lines 526–535)
// { name: string; description: string; parameters: JSONSchema }

// Anthropic format:
{
  name: tool.name,
  description: tool.description,
  input_schema: tool.parameters   // already JSON Schema — no conversion needed
}
```

When Claude returns a `tool_use` content block:

1. Emit a `tool_call` event:
   ```typescript
   {
     type: 'tool_call',
     toolName: block.name,
     toolInput: block.input,
     toolUseId: block.id
   }
   ```
2. Append the assistant message (including the `tool_use` block) to history.
3. On the **next** `sendMessage` call, check whether `options.prompt` starts
   with `__tool_result__:`. If so, parse it as
   `{ toolUseId: string; content: string }` and push a `tool` role message.
   Otherwise treat it as a normal user message.

---

### 2c — `checkAnthropicAuth()` helper

Add this exported function at the bottom of `anthropic-adapter.ts`:

```typescript
export function checkAnthropicAuth(): { ok: boolean; message: string } {
  const key = process.env['ANTHROPIC_API_KEY'];
  if (!key) {
    return {
      ok: false,
      message:
        'ANTHROPIC_API_KEY is not set.\n' +
        'PowerShell : $env:ANTHROPIC_API_KEY="sk-ant-..."\n' +
        'CMD        : set ANTHROPIC_API_KEY=sk-ant-...',
    };
  }
  return { ok: true, message: 'ANTHROPIC_API_KEY found.' };
}
```

Also re-export `checkAnthropicAuth` from the SDK's main `src/index.ts` so the
CLI can call it during `squad doctor`.

---

## Step 3 — Add `anthropicMode` to `SquadClientOptions`

File: `packages/squad-sdk/src/adapter/client.ts`

### 3a — Extend `SquadClientOptions` (line 151)

```typescript
/**
 * Skip Copilot CLI startup and route all sessions through the Anthropic adapter.
 * Requires ANTHROPIC_API_KEY or config.provider.apiKey on each createSession call.
 * @default false
 */
anthropicMode?: boolean;
```

Store it in `this.options` inside the constructor (after line 304).

### 3b — Short-circuit `connect()`, `disconnect()`, `forceDisconnect()`

At the **top** of each of those three methods add:

```typescript
if (this.options.anthropicMode) {
  this.state = 'connected';
  return;
}
```

`forceDisconnect` returns `Promise<void>`, so `return` is fine.
`disconnect` returns `Promise<Error[]>`, so return `Promise.resolve([])`.

### 3c — Route `createSession()` to the Anthropic adapter

File: `packages/squad-sdk/src/adapter/client.ts`, inside `createSession()`
at **line 470** — immediately before the existing
`this.client.createSession(...)` call — insert:

```typescript
if (config.provider?.type === 'anthropic') {
  const apiKey =
    config.provider.apiKey ??
    process.env['ANTHROPIC_API_KEY'] ??
    process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error(
      'Anthropic provider requires an API key. ' +
      'Set ANTHROPIC_API_KEY in your environment or pass config.provider.apiKey.'
    );
  }

  const model = (config as Record<string, unknown>)['model'] as string | undefined
    ?? 'claude-sonnet-4-6';
  const systemPrompt = (config as Record<string, unknown>)['systemPrompt'] as
    string | undefined;

  const session = new AnthropicSessionAdapter(apiKey, model, systemPrompt);
  recordSessionCreated();

  // Forward usage events to EventBus when one is configured
  if (this.options.eventBus) {
    const bus = this.options.eventBus;
    const sid = session.sessionId;
    session.on('usage', (event: SquadSessionEvent) => {
      const inputTokens =
        typeof event['inputTokens'] === 'number' ? event['inputTokens'] : 0;
      const outputTokens =
        typeof event['outputTokens'] === 'number' ? event['outputTokens'] : 0;
      const cost = estimateCost(model, inputTokens, outputTokens);
      void bus.emit({
        type: 'session:message',
        sessionId: sid,
        payload: { inputTokens, outputTokens, model, estimatedCost: cost },
        timestamp: new Date(),
      });
    });
  }

  span.setAttribute('session.provider', 'anthropic');
  return session;
}
```

### 3d — Add the import

At the top of `client.ts`, after the existing imports, add:

```typescript
import { AnthropicSessionAdapter } from './anthropic-adapter.js';
```

---

## Step 4 — Build and verify

From `packages/squad-sdk/` run:

```bash
npm run build
```

Fix any TypeScript errors before finishing. The build must pass with zero
errors. Warnings about `@anthropic-ai/sdk` internals are acceptable.

---

## Acceptance criteria

| # | Check |
|---|---|
| 1 | `npm run build` exits 0 in `packages/squad-sdk/` |
| 2 | `AnthropicSessionAdapter` is exported from `packages/squad-sdk/src/adapter/anthropic-adapter.ts` |
| 3 | `checkAnthropicAuth()` is exported from the SDK's main `src/index.ts` |
| 4 | `SquadClientOptions.anthropicMode` is documented and stored |
| 5 | `createSession({ provider: { type: 'anthropic' } })` no longer calls `CopilotClient` |
| 6 | Missing `ANTHROPIC_API_KEY` throws a clear error message |
| 7 | No existing tests are broken |

---

## Quick-start usage (after implementation)

```typescript
import { SquadClient } from '@bradygaster/squad-sdk/adapter';

const client = new SquadClient({ anthropicMode: true });

const session = await client.createSession({
  provider: {
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    // apiKey omitted — read from ANTHROPIC_API_KEY env var
  },
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are a TypeScript specialist on a multi-agent development team.',
});

session.on('message_delta', (e) => process.stdout.write(e['delta'] as string));
session.on('idle', () => console.log('\n[done]'));

await session.sendMessage({
  prompt: 'Implement the routing logic for the coordinator.',
});

await session.close();
```
