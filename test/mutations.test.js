import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/posthog-axi.js', import.meta.url));
const key = 'phx_mutation_fixture';
async function fixture(t, respond) {
  const directory = await mkdtemp(join(tmpdir(), 'posthog-mutations-'));
  const requests = [];
  const records = new Map();
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = {
      method: req.method,
      path: req.url,
      body: raw ? JSON.parse(raw) : null,
      auth: req.headers.authorization,
    };
    requests.push(request);
    if (respond) return respond(request, res, records);
    const match =
      /^\/api\/projects\/42\/(insights|dashboards|feature_flags)\/(?:(\d+)\/)?(?:(archive|enable|disable)\/)?$/.exec(
        req.url.split('?')[0],
      );
    if (!match) {
      res.writeHead(404);
      return res.end('{}');
    }
    const [, resource, id, action] = match;
    const stored = records.get(`${resource}/${id}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') {
      if (!stored || stored.deleted) {
        res.writeHead(404);
        return res.end('{}');
      }
      return res.end(JSON.stringify(stored));
    }
    if (req.method === 'POST' && !id) {
      const item = {
        id: 7,
        ...request.body,
        ...(resource === 'feature_flags' ? { version: 0 } : {}),
      };
      records.set(`${resource}/7`, item);
      res.writeHead(201);
      return res.end(JSON.stringify(item));
    }
    if (!stored || stored.deleted) {
      res.writeHead(404);
      return res.end('{}');
    }
    if (req.method === 'PATCH') {
      Object.assign(stored, request.body);
      if (request.body.dashboards)
        stored.dashboard_tiles = request.body.dashboards.map(
          (dashboard_id) => ({ dashboard_id, deleted: false }),
        );
    } else if (action === 'archive')
      Object.assign(stored, { archived: true, active: false });
    else if (action === 'enable') stored.active = true;
    else if (action === 'disable') stored.active = false;
    else {
      res.writeHead(405);
      return res.end('{}');
    }
    res.end(JSON.stringify(stored));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  async function file(name, value) {
    const path = join(directory, name);
    await writeFile(path, JSON.stringify(value));
    return path;
  }
  async function run(args, env = {}) {
    const child = spawn(process.execPath, [bin, ...args, '--json'], {
      cwd: directory,
      env: {
        ...process.env,
        HOME: directory,
        POSTHOG_HOST: host,
        POSTHOG_PROJECT_ID: '42',
        POSTHOG_PERSONAL_API_KEY: key,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      child.on('close', resolve);
      child.on('error', reject);
    });
    assert.equal(stderr, '');
    assert.equal(stdout.includes(key), false);
    return { code, data: JSON.parse(stdout) };
  }
  return { run, file, requests, records, host };
}
const query = { kind: 'HogQLQuery', query: 'SELECT 1' };
const targeting = { groups: [{ properties: [], rollout_percentage: 25 }] };

for (const resource of ['insights', 'dashboards', 'flags']) {
  test(`mutation ${resource} create sends one exact write`, async (t) => {
    const e = await fixture(t);
    const args = [resource, 'create', '--name', 'Example'];
    let body;
    if (resource === 'insights') {
      args.push(
        '--query-file',
        await e.file('query.json', query),
        '--dashboards',
        '12,18',
      );
      body = { name: 'Example', query, dashboards: [12, 18] };
    } else if (resource === 'flags') {
      args.push('--key', 'checkout-v2');
      body = {
        active: false,
        filters: { groups: [{ properties: [], rollout_percentage: 100 }] },
        key: 'checkout-v2',
        name: 'Example',
      };
    } else body = { name: 'Example' };
    const result = await e.run(args);
    assert.equal(result.code, 0);
    assert.equal(result.data.state, 'applied');
    assert.equal(result.data.id, 7);
    assert.match(result.data.next, /view '7'/);
    assert.deepEqual(e.requests, [
      {
        method: 'POST',
        path: `/api/projects/42/${resource === 'flags' ? 'feature_flags' : resource}/`,
        body,
        auth: `Bearer ${key}`,
      },
    ]);
  });
  test(`mutation ${resource} metadata update is repeat-safe and clears descriptions`, async (t) => {
    const e = await fixture(t);
    const endpoint = resource === 'flags' ? 'feature_flags' : resource;
    e.records.set(`${endpoint}/7`, {
      id: 7,
      name: null,
      derived_name: 'Derived',
      description: 'old',
      active: false,
      version: 0,
    });
    const args = [resource, 'update', '7', '--name', 'Changed'];
    if (resource !== 'flags') args.push('--description', '');
    assert.equal((await e.run(args)).data.state, 'applied');
    assert.equal((await e.run(args)).data.state, 'unchanged');
    assert.deepEqual(
      e.requests.filter((r) => r.method === 'PATCH').map((r) => r.body),
      [
        {
          name: 'Changed',
          ...(resource !== 'flags' ? { description: '' } : {}),
        },
      ],
    );
  });
  test(`mutation ${resource} archive uses confirmed safe operation and honest repeats`, async (t) => {
    const e = await fixture(t);
    const endpoint = resource === 'flags' ? 'feature_flags' : resource;
    e.records.set(`${endpoint}/7`, { id: 7, active: true, archived: false });
    const args = [
      resource,
      'archive',
      '7',
      '--confirm-archive',
      `42/${resource}/7`,
    ];
    assert.equal((await e.run(args)).data.state, 'applied');
    const repeat = await e.run(args);
    assert.equal(repeat.code, resource === 'flags' ? 0 : 1);
    if (resource === 'flags') assert.equal(repeat.data.state, 'unchanged');
    else {
      assert.equal(repeat.data.error.status, 404);
      assert.match(repeat.data.error.message, /unavailable|archiv|resource/i);
    }
    assert.deepEqual(
      e.requests
        .filter((r) => r.method !== 'GET')
        .map(({ method, path, body }) => ({ method, path, body })),
      [
        {
          method: resource === 'flags' ? 'POST' : 'PATCH',
          path: `/api/projects/42/${endpoint}/7/${resource === 'flags' ? 'archive/' : ''}`,
          body:
            resource === 'flags'
              ? null
              : {
                  deleted: true,
                  ...(resource === 'dashboards'
                    ? { delete_insights: false }
                    : {}),
                },
        },
      ],
    );
  });
}

test('mutation previews require no credentials or network and preserve scoped intent', async (t) => {
  const e = await fixture(t);
  for (const args of [
    ['dashboards', 'create', '--name', 'Preview'],
    ['insights', 'create', '--query-file', await e.file('query.json', query)],
    ['flags', 'create', '--key', 'preview'],
    ['flags', 'enable', '7', '--confirm-enable', '42/flags/7'],
    ['insights', 'archive', '7', '--confirm-archive', '42/insights/7'],
  ]) {
    const result = await e.run([...args, '--dry-run'], {
      POSTHOG_PERSONAL_API_KEY: '',
    });
    assert.equal(result.code, 0);
    assert.equal(result.data.state, 'preview');
    assert.match(result.data.request.url, new RegExp(e.host));
    assert.match(result.data.permission, /:write$/);
    assert.match(result.data.warnings.join(' '), /unchecked/i);
  }
  assert.deepEqual(e.requests, []);
});

test('mutation confirmations, lifecycle injection and invalid files fail before any requests', async (t) => {
  const e = await fixture(t);
  const filters = await e.file('targeting.json', targeting);
  const invalid = await e.file('invalid.json', { groups: [], active: true });
  const q = await e.file('query.json', query);
  const cases = [
    ['flags', 'enable', '7'],
    ['flags', 'disable', '7', '--confirm-disable', '43/flags/7'],
    ['dashboards', 'archive', '7', '--confirm-archive', '42/insights/7'],
    ['insights', 'update', '7', '--query-file', q],
    ['insights', 'update', '7', '--dashboards', 'none'],
    ['flags', 'update', '7', '--targeting-file', filters],
    ['flags', 'create', '--key', 'new', '--targeting-file', filters],
    ['flags', 'create', '--key', 'new', '--active', 'true'],
    ['flags', 'update', '7', '--active', 'true'],
    ['flags', 'update', '7', '--deleted', 'true'],
    [
      'flags',
      'create',
      '--key',
      'new',
      '--targeting-file',
      invalid,
      '--confirm-targeting',
      '42/flags/key:new',
    ],
    ['insights', 'create'],
    ['dashboards', 'update', '7'],
    [
      'insights',
      'update',
      '7',
      '--query-file',
      'missing',
      '--confirm-query',
      '42/insights/7',
    ],
  ];
  for (const args of cases) {
    const result = await e.run(args, { POSTHOG_PERSONAL_API_KEY: '' });
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(result.data.error.code, 'VALIDATION_ERROR');
  }
  assert.deepEqual(e.requests, []);
});

test('mutation targeting carries observed zero version and membership uses dashboard tiles', async (t) => {
  const e = await fixture(t);
  e.records.set('feature_flags/7', {
    id: 7,
    filters: { groups: [] },
    active: false,
    version: 0,
  });
  const filters = await e.file('filters.json', targeting);
  const result = await e.run([
    'flags',
    'update',
    '7',
    '--targeting-file',
    filters,
    '--confirm-targeting',
    '42/flags/7',
  ]);
  assert.equal(result.code, 0);
  assert.deepEqual(e.requests.find((r) => r.method === 'PATCH').body, {
    filters: targeting,
    version: 0,
  });
  e.records.set('insights/7', {
    id: 7,
    dashboard_tiles: [
      { dashboard_id: 12, deleted: false },
      { dashboard_id: 99, deleted: true },
    ],
  });
  const args = [
    'insights',
    'update',
    '7',
    '--dashboards',
    '12',
    '--confirm-membership',
    '42/insights/7',
  ];
  assert.equal((await e.run(args)).data.state, 'unchanged');
  args[args.indexOf('12')] = 'none';
  assert.equal((await e.run(args)).data.state, 'applied');
  assert.deepEqual(e.requests.filter((r) => r.method === 'PATCH').at(-1).body, {
    dashboards: [],
  });
});

for (const action of ['enable', 'disable'])
  test(`mutation flag ${action} uses a bodyless action and observes no-ops`, async (t) => {
    const e = await fixture(t);
    e.records.set('feature_flags/7', {
      id: 7,
      active: action === 'disable',
      archived: false,
    });
    const args = ['flags', action, '7', `--confirm-${action}`, '42/flags/7'];
    assert.equal((await e.run(args)).data.state, 'applied');
    assert.equal((await e.run(args)).data.state, 'unchanged');
    assert.deepEqual(
      e.requests
        .filter((r) => r.method === 'POST')
        .map(({ path, body }) => ({ path, body })),
      [{ path: `/api/projects/42/feature_flags/7/${action}/`, body: null }],
    );
  });

test('mutation approval conflict preserves only safe workflow references and never retries', async (t) => {
  const e = await fixture(t, (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET')
      return res.end(JSON.stringify({ id: 7, active: false, archived: false }));
    res.writeHead(409);
    res.end(
      JSON.stringify({
        code: 'approval_required',
        change_request_id: 'request-1',
        detail: key,
      }),
    );
  });
  const result = await e.run([
    'flags',
    'enable',
    '7',
    '--confirm-enable',
    '42/flags/7',
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.data.error.code, 'APPROVAL_REQUIRED');
  assert.equal(result.data.error.change_request_id, 'request-1');
  assert.equal(e.requests.filter((r) => r.method !== 'GET').length, 1);
});

for (const failure of [
  'disconnect',
  'malformed',
  'wrong-id',
  'oversized',
  'server',
])
  test(`mutation ${failure} after possible commit is uncertain without retry`, async (t) => {
    const e = await fixture(t, (req, res, records) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET')
        return res.end(JSON.stringify({ id: 7, name: 'Old' }));
      records.set('committed', req.body);
      if (failure === 'disconnect') return res.destroy();
      if (failure === 'malformed') return res.end('{');
      if (failure === 'oversized') return res.end('x'.repeat(2097153));
      if (failure === 'server') {
        res.writeHead(503);
        return res.end('{}');
      }
      res.end(JSON.stringify({ id: 8, name: 'Wrong target' }));
    });
    const result = await e.run(['dashboards', 'update', '7', '--name', 'New']);
    assert.equal(result.code, 1);
    assert.equal(result.data.error.code, 'MUTATION_UNCERTAIN');
    assert.match(result.data.error.next, /dashboards view '7'/);
    assert.deepEqual(e.records.get('committed'), { name: 'New' });
    assert.equal(e.requests.filter((r) => r.method === 'PATCH').length, 1);
  });

test('mutation create disconnect directs inspection to listing, not unsafe resubmission', async (t) => {
  const e = await fixture(t, (_req, res) => res.destroy());
  const result = await e.run(['dashboards', 'create', '--name', 'New']);
  assert.equal(result.code, 1);
  assert.equal(result.data.error.code, 'MUTATION_UNCERTAIN');
  assert.match(result.data.error.next, /dashboards list/);
  assert.equal(e.requests.length, 1);
});

test('mutation preflight target mismatch refuses a write and read-only home stays read-only', async (t) => {
  const e = await fixture(t, (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        req.path.includes('?')
          ? { results: [], next: null }
          : { id: 8, name: 'Wrong' },
      ),
    );
  });
  assert.equal(
    (await e.run(['dashboards', 'update', '7', '--name', 'New'])).code,
    1,
  );
  assert.equal(
    e.requests.some((r) => r.method !== 'GET'),
    false,
  );
  assert.equal((await e.run(['home'])).code, 0);
  assert.equal(
    e.requests.every((r) => r.method === 'GET'),
    true,
  );
});

test('mutation malformed nested response IDs preserve uncertainty and inspection advice', async (t) => {
  let id = 7;
  for (let index = 0; index < 40; index++) id = [id];
  const e = await fixture(t, (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id }));
  });
  const result = await e.run(['dashboards', 'create', '--name', 'New']);
  assert.equal(result.code, 1);
  assert.equal(result.data.error.code, 'MUTATION_UNCERTAIN');
  assert.match(result.data.error.next, /dashboards list/);
  assert.equal(e.requests.length, 1);
});

test('mutation nullable dashboard tiles count as observed nondeleted memberships', async (t) => {
  const e = await fixture(t, (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        id: 7,
        dashboard_tiles: [{ dashboard_id: 12, deleted: null }],
      }),
    );
  });
  const args = [
    'insights',
    'update',
    '7',
    '--dashboards',
    '12',
    '--confirm-membership',
    '42/insights/7',
  ];
  assert.equal((await e.run(args)).data.state, 'unchanged');
  assert.equal((await e.run(args)).data.state, 'unchanged');
  assert.deepEqual(
    e.requests.map((r) => r.method),
    ['GET', 'GET'],
  );
});

test('read boundaries reject non-scalar API identifiers instead of coercing arrays', async (t) => {
  const e = await fixture(t, (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({ results: [{ id: [7], name: 'Bad ID' }], next: null }),
    );
  });
  const result = await e.run(['projects', 'list']);
  assert.equal(result.code, 1);
  assert.equal(result.data.error.code, 'INVALID_RESPONSE');
});

test('mutation deleted flags are not reported as confirmed lifecycle no-ops', async (t) => {
  const e = await fixture(t, (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({ id: 7, active: false, archived: false, deleted: true }),
    );
  });
  const result = await e.run([
    'flags',
    'disable',
    '7',
    '--confirm-disable',
    '42/flags/7',
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.data.error.code, 'RESOURCE_UNAVAILABLE');
  assert.deepEqual(
    e.requests.map((r) => r.method),
    ['GET'],
  );
});

test('mutation lifecycle success must acknowledge the desired state', async (t) => {
  const e = await fixture(t, (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 7, active: false, archived: false }));
  });
  const result = await e.run([
    'flags',
    'enable',
    '7',
    '--confirm-enable',
    '42/flags/7',
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.data.error.code, 'MUTATION_UNCERTAIN');
  assert.equal(e.requests.filter((r) => r.method === 'POST').length, 1);
});

test('mutation guarded flag creation explicitly sends targeting and activation', async (t) => {
  const e = await fixture(t);
  const path = await e.file('targeting.json', targeting);
  const result = await e.run([
    'flags',
    'create',
    '--key',
    'new-flag',
    '--targeting-file',
    path,
    '--confirm-targeting',
    '42/flags/key:new-flag',
    '--active',
    'true',
    '--confirm-enable',
    '42/flags/key:new-flag',
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.data.item.active, true);
  assert.deepEqual(
    e.requests.map(({ method, body }) => ({ method, body })),
    [
      {
        method: 'POST',
        body: { key: 'new-flag', filters: targeting, active: true },
      },
    ],
  );
});

test('mutation version conflicts reject with inspection advice and no retry', async (t) => {
  const e = await fixture(t, (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET')
      return res.end(
        JSON.stringify({ id: 7, version: 3, filters: { groups: [] } }),
      );
    res.writeHead(409);
    res.end(JSON.stringify({ code: 'version_conflict', detail: key }));
  });
  const path = await e.file('targeting.json', targeting);
  const result = await e.run([
    'flags',
    'update',
    '7',
    '--targeting-file',
    path,
    '--confirm-targeting',
    '42/flags/7',
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.data.error.code, 'HTTP_ERROR');
  assert.equal(result.data.error.outcome, 'rejected');
  assert.match(result.data.error.next, /flags view '7'/);
  assert.deepEqual(
    e.requests.filter((r) => r.method === 'PATCH').map((r) => r.body),
    [{ filters: targeting, version: 3 }],
  );
});
