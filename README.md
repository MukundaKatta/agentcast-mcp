# agentcast-mcp

[![npm](https://img.shields.io/npm/v/@mukundakatta/agentcast-mcp.svg)](https://www.npmjs.com/package/@mukundakatta/agentcast-mcp)
[![tests](https://img.shields.io/badge/tests-6%20passing-brightgreen.svg)](#)
[![mcp](https://img.shields.io/badge/protocol-MCP-blue.svg)](https://modelcontextprotocol.io)

An [MCP](https://modelcontextprotocol.io) server that gives AI assistants the
ability to enforce structured output: extract JSON from messy LLM text, gate
it against a shape spec, and produce the retry feedback message when the model
returns the wrong shape.

Built on top of
[`@mukundakatta/agentcast`](https://github.com/MukundaKatta/agentcast). Works
with Claude Desktop, Cursor, Cline, Windsurf, Zed, and any other MCP client.

## Tools exposed

### `extract_json`

Pull a JSON value out of messy LLM output. Tries the whole text, then a
fenced ` ```json ``` ` block, then the largest balanced `{...}` / `[...]`
substring. Returns the parsed value plus which strategy succeeded.

```json
{
  "text": "Sure, here you go:\n```json\n{\"answer\": 42}\n```\nLet me know!"
}
```

→

```json
{
  "value": { "answer": 42 },
  "found": true,
  "source": "fenced_json"
}
```

`source` is one of `whole`, `fenced_json`, `fenced_plain`,
`balanced_substring`, or `none`.

### `validate_response`

Validate a parsed JSON value against an agentcast shape spec. Spec maps field
name to type: `string`, `number`, `boolean`, `array`, `object`. Suffix with
`?` for optional.

```json
{
  "value": { "name": "ada" },
  "shape": { "name": "string", "age": "number" }
}
```

→

```json
{
  "valid": false,
  "error": "missing required field 'age'"
}
```

### `build_retry_prompt`

Given an attempt history, produce the validation-error feedback message
agentcast appends to the conversation when the model returned the wrong
shape. Codifies the "validation error as feedback" pattern for non-Node MCP
clients that want to drive the same retry loop manually.

```json
{
  "attempts": [
    { "text": "{\"name\":\"ada\"}", "error": "missing required field 'age'" }
  ],
  "expected_shape": { "name": "string", "age": "number" }
}
```

→

```json
{
  "feedback": "Your previous response did not match the required shape. Error: missing required field 'age'\n\nTry again. Respond with ONLY valid JSON that fixes the error above.\n\nExpected shape: {\"name\":\"string\",\"age\":\"number\"}"
}
```

## Install

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentcast": {
      "command": "npx",
      "args": ["-y", "@mukundakatta/agentcast-mcp"]
    }
  }
}
```

### Cursor / Cline / Windsurf / Zed

Same shape, in the appropriate `mcp.json` for your client. Most clients
auto-discover via `npx -y @mukundakatta/agentcast-mcp`.

### Local install

```bash
npm install -g @mukundakatta/agentcast-mcp
mcp-agentcast        # listens on stdio
```

## Why this matters

When an LLM is supposed to return structured data, it sometimes wraps the
JSON in prose, fences, or hallucinated fields. Standard `JSON.parse` throws.
Hand-rolled regex misses nested structure. This MCP server gives any model
driving an agent a real handle on (1) pulling JSON out of the response,
(2) checking it matches the expected shape, and (3) building the exact retry
prompt that nudges the model to fix it on the next turn.

## License

MIT.
