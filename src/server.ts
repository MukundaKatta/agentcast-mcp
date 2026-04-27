#!/usr/bin/env node
/**
 * agentcast MCP server.
 *
 * Exposes three tools to any MCP client (Claude Desktop, Cursor, Cline,
 * Windsurf, Zed, etc.):
 *
 *   extract_json         — pull JSON from prose / fenced text
 *   validate_response    — gate a value against an agentcast shape spec
 *   build_retry_prompt   — produce the validation-error feedback message
 *                           agentcast would send to the LLM on retry
 *
 * Configure your client to spawn this binary over stdio. Example for
 * Claude Desktop's `claude_desktop_config.json`:
 *
 *   {
 *     "mcpServers": {
 *       "agentcast": {
 *         "command": "npx",
 *         "args": ["-y", "@mukundakatta/agentcast-mcp"]
 *       }
 *     }
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { adapters, extractJson } from '@mukundakatta/agentcast';

const server = new Server(
  {
    name: 'agentcast',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// --- tool catalog ---------------------------------------------------------

const TOOLS = [
  {
    name: 'extract_json',
    description:
      'Pull a JSON value out of messy LLM output. Tries the whole text, then a fenced ```json``` block, then the largest balanced {...}/[...] substring. Returns the parsed value plus which strategy succeeded.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'Free-form text from an LLM that may contain JSON anywhere inside.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'validate_response',
    description:
      "Validate a parsed JSON value against an agentcast shape spec. Spec maps field name to type: 'string', 'number', 'boolean', 'array', 'object'. Suffix with '?' for optional. Returns valid=true on success, or valid=false with a human-readable error string suitable for retry feedback.",
    inputSchema: {
      type: 'object',
      properties: {
        value: {
          description: 'The parsed JSON value to validate (any shape).',
        },
        shape: {
          type: 'object',
          description:
            "Shape spec: { fieldName: 'string' | 'number' | 'boolean' | 'array' | 'object', ... }. Append '?' for optional fields, e.g. { name: 'string', age: 'number?' }.",
          additionalProperties: { type: 'string' },
        },
      },
      required: ['value', 'shape'],
    },
  },
  {
    name: 'build_retry_prompt',
    description:
      'Given an attempt history, produce the retry feedback message agentcast would append to the conversation when the model returned the wrong shape. Codifies the "validation error as feedback" pattern for non-Node MCP clients.',
    inputSchema: {
      type: 'object',
      properties: {
        attempts: {
          type: 'array',
          description:
            'List of prior attempts. Each item should have the assistant text plus either a parsed value or an error string.',
          items: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                description: "Assistant's text response on this attempt.",
              },
              parsed: {
                description:
                  'Parsed JSON value extracted from the response, if any.',
              },
              error: {
                type: 'string',
                description:
                  'Validation error from this attempt. Falls back to "value did not match the expected shape" when omitted.',
              },
            },
            required: ['text'],
          },
        },
        expected_shape: {
          type: 'object',
          description:
            'Optional agentcast shape spec to include in the feedback for extra grounding.',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['attempts'],
    },
  },
] as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// --- tool dispatch --------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    switch (name) {
      case 'extract_json':
        return extractJsonTool(args as { text: string });
      case 'validate_response':
        return validateResponseTool(
          args as { value: unknown; shape: Record<string, string> },
        );
      case 'build_retry_prompt':
        return buildRetryPromptTool(
          args as {
            attempts: Array<{ text: string; parsed?: unknown; error?: string }>;
            expected_shape?: Record<string, string>;
          },
        );
      default:
        return errorResult('unknown tool: ' + name);
    }
  } catch (err) {
    return errorResult('internal error: ' + (err as Error).message);
  }
});

// --- tool implementations -------------------------------------------------

type ExtractSource =
  | 'whole'
  | 'fenced_json'
  | 'fenced_plain'
  | 'balanced_substring'
  | 'none';

/**
 * Mirror agentcast's extract.js strategy order so we can report which one
 * succeeded. agentcast's exported extractJson() doesn't surface the source.
 */
function detectExtractSource(text: string): ExtractSource {
  if (typeof text !== 'string') return 'none';
  const trimmed = text.trim();
  if (!trimmed) return 'none';

  if (tryJsonParse(trimmed) !== UNPARSEABLE) return 'whole';

  const fencedMatch = trimmed.match(/```(json|JSON|Json)?\s*\n?([\s\S]*?)\n?```/);
  if (fencedMatch && fencedMatch[2] !== undefined) {
    const inner = fencedMatch[2].trim();
    if (tryJsonParse(inner) !== UNPARSEABLE) {
      return fencedMatch[1] ? 'fenced_json' : 'fenced_plain';
    }
  }

  // Largest balanced {...} / [...] substring
  let best: string | null = null;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch !== '{' && ch !== '[') continue;
    const end = findMatching(trimmed, i);
    if (end === -1) continue;
    const candidate = trimmed.slice(i, end + 1);
    if (!best || candidate.length > best.length) best = candidate;
  }
  if (best && tryJsonParse(best) !== UNPARSEABLE) return 'balanced_substring';

  return 'none';
}

const UNPARSEABLE: unique symbol = Symbol('UNPARSEABLE');

function tryJsonParse(s: string): unknown | typeof UNPARSEABLE {
  try {
    return JSON.parse(s);
  } catch {
    return UNPARSEABLE;
  }
}

function findMatching(text: string, start: number): number {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractJsonTool(args: { text: string }) {
  const value = extractJson(args.text);
  const found = value !== null;
  const source: ExtractSource = found
    ? detectExtractSource(args.text)
    : 'none';

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            value: value ?? null,
            found,
            source,
          },
          null,
          2,
        ),
      },
    ],
  };
}

function validateResponseTool(args: {
  value: unknown;
  shape: Record<string, string>;
}) {
  if (!args || typeof args.shape !== 'object' || args.shape === null) {
    return errorResult('validate_response: shape must be an object spec');
  }
  let validator;
  try {
    validator = adapters.shape(args.shape);
  } catch (err) {
    return errorResult(
      'validate_response: invalid shape spec: ' + (err as Error).message,
    );
  }

  const result = validator(args.value);
  const payload =
    result.valid === true
      ? { valid: true }
      : { valid: false, error: result.error };

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

/**
 * Reconstruct the user-side feedback message agentcast appends after a
 * failed attempt (see cast.js `pushFeedback`). Useful for non-Node MCP
 * clients that want to drive the same retry loop manually.
 */
function buildRetryPromptTool(args: {
  attempts: Array<{ text: string; parsed?: unknown; error?: string }>;
  expected_shape?: Record<string, string>;
}) {
  if (!Array.isArray(args.attempts) || args.attempts.length === 0) {
    return errorResult(
      'build_retry_prompt: attempts must be a non-empty array',
    );
  }
  const last = args.attempts[args.attempts.length - 1]!;
  const error =
    typeof last.error === 'string' && last.error
      ? last.error
      : 'value did not match the expected shape';

  let shapeNote = '';
  if (args.expected_shape && Object.keys(args.expected_shape).length > 0) {
    shapeNote = `\n\nExpected shape: ${JSON.stringify(args.expected_shape)}`;
  }

  const feedback =
    `Your previous response did not match the required shape. ` +
    `Error: ${error}\n\n` +
    `Try again. Respond with ONLY valid JSON that fixes the error above.` +
    shapeNote;

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ feedback }, null, 2),
      },
    ],
  };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

// --- bootstrap ------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

// Polite log to stderr so MCP clients (which read stdout) aren't disturbed.
process.stderr.write('agentcast MCP server v0.1.0 ready on stdio\n');
