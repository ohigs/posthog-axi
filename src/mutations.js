import { isDeepStrictEqual } from 'node:util';
import { resources, decodeItem, resourcePath, isObject } from './resources.js';
import { request } from './http.js';
import { CliError, usage, invalidResponse } from './errors.js';
import { projectItem, quote } from './output.js';

export async function prepareMutation(invocation) {
  const { resource, action, flags, project, id } = invocation;
  const spec = resources[resource].mutations[action];
  const target = `${project}/${resource}/${action === 'create' ? `key:${flags.key}` : id}`;
  for (const name of spec.required ?? [])
    if (flags[name] === undefined)
      throw usage(`--${name} is required for ${resource} ${action}.`);
  const body = structuredClone(spec.defaults ?? spec.fixed ?? {});
  for (const [flag, input] of Object.entries(spec.inputs))
    if (flags[flag] !== undefined)
      body[input.field] = await input.parse(flags[flag]);
  for (const guard of spec.confirmations ?? []) {
    if (
      (guard.when(flags) || flags[guard.flag] !== undefined) &&
      flags[guard.flag] !== target
    )
      throw usage(
        `Use --${guard.flag} ${target} after reviewing the impact. ${spec.guidance}`,
      );
  }
  if (action === 'update' && Object.keys(body).length === 0)
    throw usage('Update requires at least one writable input.');
  const base = resourcePath(resources[resource], project);
  const path =
    spec.route === 'collection'
      ? base
      : `${base}${id}/${spec.route === 'detail' ? '' : spec.route}`;
  return { body: Object.keys(body).length ? body : undefined, path };
}

export function mutationInspection(invocation, id = invocation.id) {
  const scope = `--host ${quote(invocation.host)} --project ${quote(invocation.project)}`;
  return `posthog-axi ${invocation.resource} ${id ? `view ${quote(id)}` : 'list'} ${scope}`;
}

function uncertain(invocation, status) {
  return new CliError(
    'MUTATION_UNCERTAIN',
    'The write may have committed. Inspect state before retrying; writes are never automatically retried.',
    1,
    {
      outcome: 'uncertain',
      resource: invocation.resource,
      operation: invocation.action,
      ...(status ? { status } : {}),
      next: mutationInspection(invocation),
    },
  );
}

function validateTarget(invocation, raw) {
  const item = decodeItem(resources[invocation.resource], raw, false);
  if (
    invocation.action !== 'create' &&
    String(item.id) !== String(invocation.id)
  )
    throw invalidResponse();
  for (const field of ['active', 'archived', 'deleted'])
    if (item[field] != null && typeof item[field] !== 'boolean')
      throw invalidResponse();
  if (
    item.version != null &&
    (!Number.isSafeInteger(item.version) || item.version < 0)
  )
    throw invalidResponse();
  return item;
}

function memberships(item) {
  if (Array.isArray(item.dashboard_tiles)) {
    const active = item.dashboard_tiles.filter(
      (tile) => isObject(tile) && tile.deleted !== true,
    );
    if (
      item.dashboard_tiles.some(
        (tile) =>
          !isObject(tile) || ![true, false, null].includes(tile.deleted),
      ) ||
      active.some((tile) => !resources.dashboards.id(tile.dashboard_id))
    )
      return undefined;
    return active
      .map((tile) => Number(tile.dashboard_id))
      .sort((a, b) => a - b);
  }
  if (
    Array.isArray(item.dashboards) &&
    item.dashboards.every(resources.dashboards.id)
  )
    return item.dashboards.map(Number).sort((a, b) => a - b);
  return undefined;
}

function matches(item, desired) {
  return Object.entries(desired).every(([name, value]) => {
    if (name === 'delete_insights') return true;
    if (name === 'dashboards')
      return isDeepStrictEqual(
        memberships(item),
        [...value].sort((a, b) => a - b),
      );
    return Object.hasOwn(item, name) && isDeepStrictEqual(item[name], value);
  });
}

function receipt(invocation, state, item) {
  const spec = resources[invocation.resource];
  return {
    resource: invocation.resource,
    operation: invocation.action,
    state,
    id: item.id,
    project: invocation.project,
    host: invocation.host,
    item: projectItem(
      spec.normalize ? spec.normalize(item) : item,
      spec.defaults,
      false,
    ),
    next: mutationInspection(invocation, item.id),
  };
}

export function minimalMutationReceipt(result) {
  return {
    resource: result.resource,
    operation: result.operation,
    state: result.state,
    id: result.id,
    project: result.project,
    host: result.host,
    next: result.next,
    message:
      'The operation completed; returned content was omitted. Inspect the resource before making another change.',
  };
}

export async function executeMutation(invocation) {
  const spec = resources[invocation.resource];
  const operation = spec.mutations[invocation.action];
  const { path } = invocation.mutation;
  let body = invocation.mutation.body;
  if (invocation.flags['dry-run'])
    return {
      resource: invocation.resource,
      operation: invocation.action,
      state: 'preview',
      request: {
        method: operation.method,
        url: `${invocation.host}${path}`,
        body: body ?? null,
      },
      permission: operation.permission,
      warnings: [
        'Remote permissions, state, version, dependencies and approval policies are unchecked. No request was sent.',
        operation.guidance,
      ],
    };
  if (invocation.action !== 'create') {
    let current;
    try {
      current = validateTarget(
        invocation,
        await request(
          invocation,
          `${resourcePath(spec, invocation.project)}${invocation.id}/`,
        ),
      );
    } catch (error) {
      if (
        error instanceof CliError &&
        error.details?.status === 404 &&
        invocation.action === 'archive'
      )
        throw new CliError(
          'HTTP_ERROR',
          'Resource unavailable. A 404 cannot prove it was already archived; no write was attempted.',
          1,
          { status: 404, next: mutationInspection(invocation) },
        );
      throw error;
    }
    if (current.deleted === true)
      throw new CliError(
        'RESOURCE_UNAVAILABLE',
        'The resource is deleted. No write was attempted and lifecycle state was not accepted as a no-op.',
        1,
        { next: mutationInspection(invocation) },
      );
    const desired = invocation.action === 'update' ? body : operation.desired;
    if (desired && matches(current, desired))
      return receipt(invocation, 'unchanged', current);
    if (
      operation.version &&
      body.filters !== undefined &&
      current.version !== undefined
    )
      body = { ...body, version: current.version };
  }
  let item;
  try {
    item = validateTarget(
      invocation,
      await request(invocation, path, { method: operation.method, body }),
    );
    if (
      invocation.action === 'create' &&
      invocation.resource === 'flags' &&
      item.key !== body.key
    )
      throw invalidResponse();
    const desired =
      invocation.action === 'update'
        ? invocation.mutation.body
        : operation.desired;
    if (desired && !matches(item, desired)) throw invalidResponse();
  } catch (error) {
    if (error instanceof CliError && error.code === 'AUTH_REQUIRED')
      throw error;
    if (
      error instanceof CliError &&
      ((error.code === 'HTTP_ERROR' && error.details?.status < 500) ||
        error.code === 'APPROVAL_REQUIRED')
    )
      throw new CliError(error.code, error.message, error.exitCode, {
        outcome: 'rejected',
        ...error.details,
        next: mutationInspection(invocation),
      });
    throw uncertain(invocation, error.details?.status);
  }
  try {
    return receipt(invocation, 'applied', item);
  } catch {
    return minimalMutationReceipt({
      resource: invocation.resource,
      operation: invocation.action,
      state: 'applied',
      id: item.id,
      project: invocation.project,
      host: invocation.host,
      next: mutationInspection(invocation, item.id),
    });
  }
}
