/**
 * End-to-end smoke test: spawn the MCP server, ask for the tool catalog, and
 * call each tool with a representative input. Validates wire-level shape.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'src', 'server.ts');

function rpc(child: ReturnType<typeof spawn>, request: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (
            'id' in msg &&
            (msg as { id: number }).id === (request as { id: number }).id
          ) {
            child.stdout?.off('data', onData);
            resolve(msg);
            return;
          }
        } catch {
          // partial line, keep buffering
        }
      }
    };
    child.stdout?.on('data', onData);
    child.on('error', reject);
    child.stdin?.write(JSON.stringify(request) + '\n');
  });
}

async function withServer(fn: (child: ReturnType<typeof spawn>) => Promise<void>) {
  const child = spawn('npx', ['tsx', SERVER], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  // Initialize handshake.
  await rpc(child, {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '1.0.0' },
    },
  });
  child.stdin?.write(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) +
      '\n',
  );
  try {
    await fn(child);
  } finally {
    child.kill();
  }
}

test('server lists three tools', async () => {
  await withServer(async (child) => {
    const res = (await rpc(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    })) as { result: { tools: Array<{ name: string }> } };
    const names = res.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'build_retry_prompt',
      'extract_json',
      'validate_response',
    ]);
  });
});

test('extract_json strips fences and reports source', async () => {
  await withServer(async (child) => {
    const res = (await rpc(child, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'extract_json',
        arguments: {
          text: 'Sure, here you go:\n```json\n{"answer": 42}\n```\nLet me know!',
        },
      },
    })) as { result: { content: Array<{ text: string }> } };
    const payload = JSON.parse(res.result.content[0]!.text) as {
      value: { answer: number };
      found: boolean;
      source: string;
    };
    assert.equal(payload.found, true);
    assert.equal(payload.value.answer, 42);
    assert.equal(payload.source, 'fenced_json');
  });
});

test('extract_json returns found=false when no JSON present', async () => {
  await withServer(async (child) => {
    const res = (await rpc(child, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'extract_json',
        arguments: { text: 'Just some prose, no JSON anywhere.' },
      },
    })) as { result: { content: Array<{ text: string }> } };
    const payload = JSON.parse(res.result.content[0]!.text) as {
      value: unknown;
      found: boolean;
      source: string;
    };
    assert.equal(payload.found, false);
    assert.equal(payload.value, null);
    assert.equal(payload.source, 'none');
  });
});

test('validate_response accepts a matching shape', async () => {
  await withServer(async (child) => {
    const res = (await rpc(child, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'validate_response',
        arguments: {
          value: { name: 'ada', age: 36, tags: ['math'] },
          shape: { name: 'string', age: 'number', tags: 'array' },
        },
      },
    })) as { result: { content: Array<{ text: string }> } };
    const payload = JSON.parse(res.result.content[0]!.text) as {
      valid: boolean;
      error?: string;
    };
    assert.equal(payload.valid, true);
    assert.equal(payload.error, undefined);
  });
});

test('validate_response rejects a wrong shape with helpful error', async () => {
  await withServer(async (child) => {
    const res = (await rpc(child, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'validate_response',
        arguments: {
          value: { name: 'ada' }, // missing required age
          shape: { name: 'string', age: 'number' },
        },
      },
    })) as { result: { content: Array<{ text: string }> } };
    const payload = JSON.parse(res.result.content[0]!.text) as {
      valid: boolean;
      error?: string;
    };
    assert.equal(payload.valid, false);
    assert.ok(payload.error?.includes('age'));
  });
});

test('build_retry_prompt produces feedback with last error', async () => {
  await withServer(async (child) => {
    const res = (await rpc(child, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'build_retry_prompt',
        arguments: {
          attempts: [
            {
              text: '{"name":"ada"}',
              parsed: { name: 'ada' },
              error: "missing required field 'age'",
            },
          ],
          expected_shape: { name: 'string', age: 'number' },
        },
      },
    })) as { result: { content: Array<{ text: string }> } };
    const payload = JSON.parse(res.result.content[0]!.text) as {
      feedback: string;
    };
    assert.ok(payload.feedback.includes('age'));
    assert.ok(payload.feedback.toLowerCase().includes('only valid json'));
    assert.ok(payload.feedback.includes('Expected shape'));
  });
});
