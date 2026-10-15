import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/posthog-axi.js', import.meta.url));
const key = 'phx_fixture_key_never_print';
const uuid = '018f1111-2222-4333-8444-555555555555';
async function fixture(t, responses) {
  const directory = await mkdtemp(join(tmpdir(), 'posthog-axi-compat-'));
  const home = join(directory, 'home');
  await mkdir(home);
  await symlink(bin, join(directory, 'posthog-axi'));
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({
      method: req.method,
      path: req.url,
      auth: req.headers.authorization,
      body,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responses[requests.length - 1]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const host = `http://127.0.0.1:${server.address().port}`;
  async function run(args, extra = {}, shell = false) {
    const child = spawn(
      shell ? 'sh' : process.execPath,
      shell ? ['-c', args] : [bin, ...args, '--json'],
      {
        cwd: directory,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          PATH: `${directory}:${process.env.PATH}`,
          POSTHOG_HOST: host,
          POSTHOG_PROJECT_ID: '42',
          POSTHOG_PERSONAL_API_KEY: key,
          ...extra,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(stderr, '');
    assert.equal(stdout.includes(key), false);
    return { code, data: JSON.parse(stdout) };
  }
  return { directory, host, requests, run };
}

test('realistic nullable insight names fall back to derived_name without requiring optional fields', async (t) => {
  const e = await fixture(t, [
    {
      results: [
        { id: 1, name: null, derived_name: 'Trend' },
        { id: 2, name: '' },
        { id: 3 },
      ],
      next: null,
    },
  ]);
  const result = await e.run(['insights', 'list']);
  assert.equal(result.code, 0);
  assert.deepEqual(result.data, {
    resource: 'insights',
    items: [
      { id: 1, name: 'Trend', short_id: null },
      { id: 2, name: null, short_id: null },
      { id: 3, name: null, short_id: null },
    ],
    returned: 3,
    total: null,
    next: null,
    message: 'Returned 3 insights.',
  });
  assert.deepEqual(e.requests, [
    {
      method: 'GET',
      path: '/api/projects/42/insights/?limit=25&offset=0',
      auth: `Bearer ${key}`,
      body: '',
    },
  ]);
});

test('event timestamp continuation preserves filters, remains executable, and never invents offset', async (t) => {
  const event = "event with ' quotes " + 'a'.repeat(150);
  const after = '2026-01-01T00:00:00Z';
  const before = '2026-01-02T00:00:00Z';
  const query = new URLSearchParams({
    before,
    after,
    event,
    distinct_id: 'person',
    limit: '1',
  });
  const e = await fixture(t, [
    {
      results: [{ id: uuid, event, distinct_id: 'person', timestamp: before }],
      next: `/api/projects/42/events/?${query}`,
    },
    { results: [], next: null },
  ]);
  const result = await e.run([
    'events',
    'list',
    '--after',
    after,
    '--event',
    event,
    '--distinct-id',
    'person',
    '--limit',
    '1',
    '--fields',
    'id',
  ]);
  assert.equal(result.code, 0);
  const hint = `posthog-axi events list --host '${e.host}' --project '42' --limit 1 --before '${before}' --after '${after}' --event 'event with '\\'' quotes ${'a'.repeat(150)}' --distinct-id 'person' --fields 'id' --json`;
  assert.deepEqual(result.data, {
    resource: 'events',
    items: [{ id: uuid }],
    returned: 1,
    total: null,
    next: hint,
    message: 'Returned 1 events.',
  });
  const next = await e.run(hint, {}, true);
  assert.equal(next.code, 0);
  assert.deepEqual(next.data, {
    resource: 'events',
    items: [],
    returned: 0,
    total: null,
    next: null,
    message: 'No events on this page.',
  });
  assert.deepEqual(
    e.requests.map((request) => request.path),
    [
      `/api/projects/42/events/?${new URLSearchParams({ limit: '1', after, event, distinct_id: 'person' })}`,
      `/api/projects/42/events/?${new URLSearchParams({ limit: '1', before, after, event, distinct_id: 'person' })}`,
    ],
  );
  assert.deepEqual(
    e.requests.map((request) => request.auth),
    [`Bearer ${key}`, `Bearer ${key}`],
  );
});

test('valid column-less query matrices receive positional columns and empty results stay explicit', async (t) => {
  const e = await fixture(t, [
    { results: [[7, 'seven']] },
    {
      query_status: {
        id: 'q',
        complete: true,
        results: { results: [] },
        error: null,
      },
    },
  ]);
  assert.deepEqual(await e.run(['query', '--sql', 'SELECT 7']), {
    code: 0,
    data: {
      state: 'complete',
      columns: ['column_1', 'column_2'],
      rows: [[7, 'seven']],
      returned: 1,
      received: 1,
      backend_has_more: null,
      truncated: false,
      message: 'Query completed.',
    },
  });
  assert.deepEqual(await e.run(['query', 'status', 'q']), {
    code: 0,
    data: {
      state: 'complete',
      columns: [],
      rows: [],
      returned: 0,
      received: 0,
      backend_has_more: null,
      truncated: false,
      message: 'Query completed with zero rows.',
    },
  });
  assert.deepEqual(
    e.requests.map((r) => [r.method, r.path]),
    [
      ['POST', '/api/projects/42/query/'],
      ['GET', '/api/projects/42/query/q/'],
    ],
  );
});

test('larger-than-requested numeric pages are capped with a non-skipping continuation', async (t) => {
  const e = await fixture(t, [
    { results: [{ id: 1 }, { id: 2 }, { id: 3 }], count: 3, next: null },
  ]);
  const result = await e.run([
    'projects',
    'list',
    '--limit',
    '2',
    '--fields',
    'id',
  ]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.data, {
    resource: 'projects',
    items: [{ id: 1 }, { id: 2 }],
    returned: 2,
    total: 3,
    next: `posthog-axi projects list --host '${e.host}' --project '42' --limit 2 --offset '2' --fields 'id' --json`,
    message: 'Returned 2 projects.',
  });
  assert.equal(e.requests[0].path, '/api/projects/?limit=2&offset=0');
});

test('unsafe or malformed same-origin next links fail without making a followup request', async (t) => {
  const links = [
    '/api/projects/99/insights/?offset=25',
    '/api/projects/42/insights/?offset=25&offset=50',
    '/api/projects/42/insights/?offset=25&token=secret',
    '/api/projects/42/insights/?offset=0',
    '/api/projects/42/insights/?before=2026-01-01T00:00:00Z',
    '/api/projects/42/insights/?offset=25#fragment',
  ];
  const e = await fixture(
    t,
    links.map((next) => ({ results: [{ id: 1 }], next })),
  );
  for (const code of [
    'UNSAFE_PAGINATION',
    'INVALID_RESPONSE',
    'INVALID_RESPONSE',
    'INVALID_RESPONSE',
    'INVALID_RESPONSE',
    'UNSAFE_PAGINATION',
  ]) {
    const result = await e.run(['insights', 'list']);
    assert.equal(result.code, 1);
    assert.equal(result.data.error.code, code);
  }
  assert.equal(e.requests.length, links.length);
});

test('auth, scope, missing SQL files and oversized SQL validate without requests', async (t) => {
  const e = await fixture(t, []);
  const largeFile = join(e.directory, 'large.sql');
  await writeFile(largeFile, 'x'.repeat(65537));
  for (const [args, env, code, exit] of [
    [
      ['projects', 'list'],
      { POSTHOG_PERSONAL_API_KEY: '' },
      'AUTH_REQUIRED',
      1,
    ],
    [
      ['flags', 'list'],
      { POSTHOG_PROJECT_ID: '', POSTHOG_PERSONAL_API_KEY: '' },
      'VALIDATION_ERROR',
      2,
    ],
    [
      ['flags', 'list'],
      { POSTHOG_PROJECT_ID: undefined, POSTHOG_PERSONAL_API_KEY: '' },
      'VALIDATION_ERROR',
      2,
    ],
    [
      ['query', '--file', largeFile],
      { POSTHOG_PERSONAL_API_KEY: '' },
      'VALIDATION_ERROR',
      2,
    ],
    [
      ['query', '--file', e.directory],
      { POSTHOG_PERSONAL_API_KEY: '' },
      'VALIDATION_ERROR',
      2,
    ],
    [['events', 'list', '--offset', '1'], {}, 'VALIDATION_ERROR', 2],
    [
      ['projects', 'list', '--help'],
      { POSTHOG_HOST: 'https://host/#bad' },
      'VALIDATION_ERROR',
      2,
    ],
    [['--json'], {}, 'VALIDATION_ERROR', 2],
  ]) {
    const result = await e.run(args, env);
    assert.equal(result.code, exit);
    assert.equal(result.data.error.code, code);
  }
  assert.deepEqual(e.requests, []);
});

test('explicit scope overrides environment before the HTTP boundary', async (t) => {
  const e = await fixture(t, [{ results: [], next: null }]);
  assert.deepEqual(
    await e.run(['flags', 'list', '--host', e.host, '--project', '9'], {
      POSTHOG_HOST: 'https://invalid.example',
      POSTHOG_PROJECT_ID: 'invalid',
    }),
    {
      code: 0,
      data: {
        resource: 'flags',
        items: [],
        returned: 0,
        total: null,
        next: null,
        message: 'No flags in this scope.',
      },
    },
  );
  assert.deepEqual(e.requests, [
    {
      method: 'GET',
      path: '/api/projects/9/feature_flags/?limit=25&offset=0',
      auth: `Bearer ${key}`,
      body: '',
    },
  ]);
});

test('output cap remains in force with --full and query cells get previews by default', async (t) => {
  const e = await fixture(t, [
    { results: [['x'.repeat(600000)]] },
    { results: [['x'.repeat(400)]] },
  ]);
  assert.deepEqual(await e.run(['query', '--sql', 'SELECT large', '--full']), {
    code: 1,
    data: {
      error: {
        code: 'OUTPUT_TOO_LARGE',
        message: 'Output exceeds 524288 bytes. Select fewer fields or rows.',
      },
    },
  });
  const result = await e.run(['query', '--sql', 'SELECT text']);
  assert.equal(result.code, 0);
  assert.deepEqual(result.data.rows, [
    [
      {
        preview: 'x'.repeat(300),
        characters: 400,
        hint: 'Use --full for untruncated content.',
      },
    ],
  ]);
  assert.equal(e.requests.length, 2);
});

test('home fetches a compact live snapshot with contextual scoped commands', async (t) => {
  const e = await fixture(t, [
    {
      results: [{ id: 8, name: null, derived_name: 'Live trend' }],
      count: 7,
      next: '/api/projects/42/insights/?limit=3&offset=3',
    },
    {
      results: [{ id: 9, name: 'Live project', api_token: 'hidden' }],
      next: null,
    },
  ]);
  const home = await e.run(['home']);
  assert.equal(home.code, 0);
  assert.equal(home.data.bin, bin);
  assert.equal(home.data.authentication, 'configured');
  assert.deepEqual(home.data.snapshot, {
    resource: 'insights',
    items: [{ id: 8, name: 'Live trend', short_id: null }],
    returned: 1,
    total: 7,
    next: `posthog-axi insights list --host '${e.host}' --project '42' --limit 3 --offset '3' --json`,
    message: 'Returned 1 insights.',
  });
  assert.equal(
    home.data.next,
    `posthog-axi insights list --host '${e.host}' --project '42'`,
  );
  const global = await e.run(['home'], { POSTHOG_PROJECT_ID: undefined });
  assert.equal(global.code, 0);
  assert.deepEqual(global.data.snapshot, {
    resource: 'projects',
    items: [{ id: 9, name: 'Live project', timezone: null }],
    returned: 1,
    total: null,
    next: null,
    message: 'Returned 1 projects.',
  });
  assert.deepEqual(
    e.requests.map((r) => r.path),
    [
      '/api/projects/42/insights/?limit=3&offset=0',
      '/api/projects/?limit=3&offset=0',
    ],
  );
});

test('known secret query columns and nested cells remain redacted with full output', async (t) => {
  const e = await fixture(t, [
    {
      columns: ['api_token', 'value', 'access_token'],
      results: [
        [
          'project secret',
          { authorization: 'another secret', message: key },
          'third secret',
        ],
      ],
    },
  ]);
  const result = await e.run(['query', '--sql', 'SELECT tokens', '--full']);
  assert.deepEqual(result, {
    code: 0,
    data: {
      state: 'complete',
      columns: ['api_token', 'value', 'access_token'],
      rows: [
        [
          '[REDACTED]',
          { authorization: '[REDACTED]', message: '[REDACTED]' },
          '[REDACTED]',
        ],
      ],
      returned: 1,
      received: 1,
      backend_has_more: null,
      truncated: false,
      message: 'Query completed.',
    },
  });
  assert.equal(e.requests.length, 1);
});

test('SQL input rejects malformed UTF-8 and named pipes without waiting for a writer', async (t) => {
  const e = await fixture(t, []);
  const invalidFile = join(e.directory, 'invalid.sql');
  await writeFile(invalidFile, Buffer.from([0xff]));
  const fifo = join(e.directory, 'pipe.sql');
  const mkfifo = spawn('mkfifo', [fifo], { cwd: e.directory, stdio: 'ignore' });
  assert.equal(await new Promise((resolve) => mkfifo.on('close', resolve)), 0);
  for (const file of [invalidFile, fifo]) {
    const result = await e.run(['query', '--file', file], {
      POSTHOG_PERSONAL_API_KEY: '',
    });
    assert.equal(result.code, 2);
    assert.equal(result.data.error.code, 'VALIDATION_ERROR');
  }
  assert.deepEqual(e.requests, []);
});
