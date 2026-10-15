import { invalidResponse } from './errors.js';

const numeric = (value) =>
  /^[1-9][0-9]{0,15}$/.test(String(value)) &&
  Number.isSafeInteger(Number(value));
const uuid = (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(value),
  );
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
    },
    defaults: ['id', 'name', 'short_id'],
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
    },
    defaults: ['id', 'key', 'name', 'active'],
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

export function decodeItem(spec, value) {
  if (!object(value) || !spec.id(value.id)) throw invalidResponse();
  for (const [key, validate] of Object.entries(spec.fields)) {
    if (
      value[key] !== undefined &&
      value[key] !== null &&
      !validate(value[key])
    )
      throw invalidResponse();
  }
  return spec.normalize ? spec.normalize(value) : value;
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
