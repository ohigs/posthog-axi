import { invalidResponse } from './errors.js';
import { inputParsers } from './inputs.js';

const input = (field, parser, guidance) => ({
  field,
  parse: inputParsers[parser],
  guidance,
});
const metadata = {
  name: input(
    'name',
    'text',
    'Name text. For flags this is the API name, a description-like field.',
  ),
  description: input(
    'description',
    'text',
    'Description text. An empty string clears it.',
  ),
  tags: input('tags', 'tags', 'Comma-separated tags, or none to clear.'),
};
const insightInputs = {
  ...metadata,
  favorited: input('favorited', 'boolean', 'Explicit true or false.'),
  'query-file': input(
    'query',
    'query',
    'Bounded JSON query definition with kind. Query updates may remove linked alerts.',
  ),
  dashboards: input(
    'dashboards',
    'dashboards',
    'Full membership replacement, comma-separated positive IDs or none. Uses the deprecated upstream dashboards field.',
  ),
};
const dashboardInputs = {
  ...metadata,
  pinned: input('pinned', 'boolean', 'Explicit true or false.'),
};
const flagInputs = {
  name: metadata.name,
  'targeting-file': input(
    'filters',
    'targeting',
    'Bounded JSON targeting filters with groups. The server validates full targeting semantics.',
  ),
};
const guard = (flag, when) => ({ flag, when });
const mutation = (permission, method, route, inputs, guidance, extra = {}) => ({
  permission,
  method,
  route,
  inputs,
  guidance,
  ...extra,
});
const archiveGuard = [guard('confirm-archive', () => true)];
const targetingGuard = guard(
  'confirm-targeting',
  (flags) => flags['targeting-file'] !== undefined,
);
const insightGuards = [
  guard('confirm-query', (flags) => flags['query-file'] !== undefined),
  guard('confirm-membership', (flags) => flags.dashboards !== undefined),
];

const numeric = (value) =>
  (typeof value === 'string' || typeof value === 'number') &&
  /^[1-9][0-9]{0,15}$/.test(String(value)) &&
  Number.isSafeInteger(Number(value));
const uuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const text = (value) => typeof value === 'string';
const boolean = (value) => typeof value === 'boolean';
const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const array = Array.isArray;

export const resources = {
  projects: {
    endpoint: 'projects',
    scope: false,
    id: numeric,
    fields: { id: numeric, name: text, timezone: text, created_at: text },
    defaults: ['id', 'name', 'timezone'],
  },
  insights: {
    endpoint: 'insights',
    scope: true,
    id: numeric,
    normalize: (item) => ({
      ...item,
      name: item.name || item.derived_name || null,
    }),
    fields: {
      id: numeric,
      name: text,
      derived_name: text,
      description: text,
      short_id: text,
      last_refresh: text,
      filters: object,
      query: object,
      tags: array,
      favorited: boolean,
      dashboard_tiles: array,
    },
    defaults: ['id', 'name', 'short_id'],
    mutations: {
      create: mutation(
        'insight:write',
        'POST',
        'collection',
        insightInputs,
        'Create requires --query-file. Names are not unique idempotency keys.',
        { required: ['query-file'] },
      ),
      update: mutation(
        'insight:write',
        'PATCH',
        'detail',
        insightInputs,
        'Query replacement may delete linked alerts. Membership replaces all linked dashboards.',
        { confirmations: insightGuards },
      ),
      archive: mutation(
        'insight:write',
        'PATCH',
        'detail',
        {},
        'Obtain operator approval before archiving. Removes subscriptions and linked alerts and hides dashboard tiles. Not fully reversible. Deleted detail GET returns 404, which cannot prove already archived.',
        {
          fixed: { deleted: true },
          confirmations: archiveGuard,
          desired: { deleted: true },
        },
      ),
    },
  },
  dashboards: {
    endpoint: 'dashboards',
    scope: true,
    id: numeric,
    fields: {
      id: numeric,
      name: text,
      description: text,
      pinned: boolean,
      tags: array,
      tiles: array,
    },
    defaults: ['id', 'name', 'pinned'],
    mutations: {
      create: mutation(
        'dashboard:write',
        'POST',
        'collection',
        dashboardInputs,
        'Create dashboard metadata. Manage insight membership through insights update.',
      ),
      update: mutation(
        'dashboard:write',
        'PATCH',
        'detail',
        dashboardInputs,
        'Update supplied metadata only. Manage membership through insights update.',
      ),
      archive: mutation(
        'dashboard:write',
        'PATCH',
        'detail',
        {},
        'Obtain operator approval before archiving. Hides tiles and clears home and primary references, preserving underlying insights. Deleted detail GET returns 404, which cannot prove already archived.',
        {
          fixed: { deleted: true, delete_insights: false },
          confirmations: archiveGuard,
          desired: { deleted: true },
        },
      ),
    },
  },
  flags: {
    endpoint: 'feature_flags',
    scope: true,
    id: numeric,
    fields: {
      id: numeric,
      key: text,
      name: text,
      active: boolean,
      filters: object,
      archived: boolean,
      version: (value) => Number.isSafeInteger(value) && value >= 0,
    },
    defaults: ['id', 'key', 'name', 'active'],
    mutations: {
      create: mutation(
        'feature_flag:write',
        'POST',
        'collection',
        {
          key: input('key', 'key', 'Required immutable flag key.'),
          ...flagInputs,
          active: input(
            'active',
            'boolean',
            'Defaults to false. true requires --confirm-enable.',
          ),
        },
        'Creates inactive by default with standard boolean targeting of all users at 100 percent rollout. Supplied targeting always requires confirmation, even while inactive. Creation target is <project>/flags/key:<key>.',
        {
          required: ['key'],
          defaults: {
            active: false,
            filters: { groups: [{ properties: [], rollout_percentage: 100 }] },
          },
          confirmations: [
            targetingGuard,
            guard('confirm-enable', (flags) => flags.active === 'true'),
          ],
        },
      ),
      update: mutation(
        'feature_flag:write',
        'PATCH',
        'detail',
        flagInputs,
        'Replaces supplied targeting using observed version when available. Version enforcement depends on server configuration, not universal compare-and-swap. No key rename or lifecycle inputs.',
        { confirmations: [targetingGuard], version: true },
      ),
      archive: mutation(
        'feature_flag:write',
        'POST',
        'archive/',
        {},
        'Obtain operator approval before archiving. Archives and deactivates while preserving targeting and history. Server dependencies and approval policy remain authoritative.',
        {
          confirmations: archiveGuard,
          desired: { archived: true, active: false },
        },
      ),
      enable: mutation(
        'feature_flag:write',
        'POST',
        'enable/',
        {},
        'Enables through the dedicated server action, preserving dependency and approval checks.',
        {
          confirmations: [guard('confirm-enable', () => true)],
          desired: { active: true, archived: false },
        },
      ),
      disable: mutation(
        'feature_flag:write',
        'POST',
        'disable/',
        {},
        'Disables through the dedicated server action, preserving dependency and approval checks.',
        {
          confirmations: [guard('confirm-disable', () => true)],
          desired: { active: false },
        },
      ),
    },
  },
  events: {
    endpoint: 'events',
    scope: true,
    id: uuid,
    filters: { event: 'event', 'distinct-id': 'distinct_id' },
    pagination: ['before', 'after'],
    fields: {
      id: uuid,
      event: text,
      timestamp: text,
      distinct_id: text,
      properties: object,
    },
    defaults: ['id', 'event', 'timestamp', 'distinct_id'],
  },
};

export function decodeItem(spec, value, normalize = true) {
  if (!object(value) || !spec.id(value.id)) throw invalidResponse();
  for (const [key, validate] of Object.entries(spec.fields)) {
    if (
      value[key] !== undefined &&
      value[key] !== null &&
      !validate(value[key])
    )
      throw invalidResponse();
  }
  return normalize && spec.normalize ? spec.normalize(value) : value;
}

export function resourcePath(spec, project) {
  return spec.scope
    ? `/api/projects/${project}/${spec.endpoint}/`
    : `/api/${spec.endpoint}/`;
}

export function decodePage(spec, value) {
  if (
    !object(value) ||
    !Array.isArray(value.results) ||
    (value.count != null &&
      (!Number.isSafeInteger(value.count) || value.count < 0)) ||
    (value.next != null && typeof value.next !== 'string')
  )
    throw invalidResponse();
  return {
    items: value.results.map((item) => decodeItem(spec, item)),
    total: value.count ?? null,
    next: value.next ?? null,
  };
}

export const isObject = object;
export const validProject = numeric;
export const validQueryId = (value) => /^[A-Za-z0-9_-]{1,128}$/.test(value);
