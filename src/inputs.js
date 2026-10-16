import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { usage } from './errors.js';

export async function readInputFile(path, label) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 65536)
      throw usage(
        `${label} file must be a regular file of at most 65536 bytes.`,
      );
    const buffer = Buffer.alloc(65537);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        size,
        buffer.length - size,
        size,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > 65536) throw usage(`${label} file exceeds 65536 bytes.`);
    return new TextDecoder('utf-8', { fatal: true }).decode(
      buffer.subarray(0, size),
    );
  } catch (error) {
    if (error.code === 'VALIDATION_ERROR') throw error;
    throw usage(`Cannot read ${label} file.`);
  } finally {
    await handle?.close();
  }
}

const object = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const inputParsers = {
  text: (value) => {
    if (
      value.length > 4096 ||
      [...value].some(
        (char) =>
          char.codePointAt(0) < 32 && !['\t', '\n', '\r'].includes(char),
      )
    )
      throw usage(
        'Metadata text must be at most 4096 characters without control characters.',
      );
    return value;
  },
  key: (value) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,399}$/.test(value))
      throw usage(
        'Flag key must contain 1 through 400 letters, digits, dots, underscores or hyphens.',
      );
    return value;
  },
  boolean: (value) => {
    if (!['true', 'false'].includes(value))
      throw usage('Boolean inputs require true or false.');
    return value === 'true';
  },
  tags: (value) => {
    const tags = value === 'none' ? [] : value.split(',');
    if (
      tags.length > 100 ||
      tags.some(
        (tag) =>
          !tag.trim() ||
          tag.length > 200 ||
          [...tag].some((char) => char.codePointAt(0) < 32),
      ) ||
      new Set(tags).size !== tags.length
    )
      throw usage(
        'Tags require up to 100 unique comma-separated names, or none.',
      );
    return tags;
  },
  dashboards: (value) => {
    const ids = value === 'none' ? [] : value.split(',');
    if (
      ids.length > 100 ||
      ids.some(
        (id) =>
          !/^[1-9][0-9]{0,15}$/.test(id) || !Number.isSafeInteger(Number(id)),
      ) ||
      new Set(ids).size !== ids.length
    )
      throw usage(
        'Dashboards require up to 100 unique positive integer IDs, or none.',
      );
    return ids.map(Number);
  },
  query: async (path) => {
    const value = await readDefinition(path, 'Query');
    if (
      !object(value) ||
      typeof value.kind !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9]{0,79}$/.test(value.kind)
    )
      throw usage('Query requires a nonempty object with a query kind.');
    if (
      value.kind === 'HogQLQuery' &&
      (typeof value.query !== 'string' || !value.query.trim())
    )
      throw usage('HogQLQuery requires nonempty query text.');
    if (value.kind.endsWith('VizNode') && !object(value.source))
      throw usage('Visualization queries require an object source.');
    if (
      [
        'TrendsQuery',
        'FunnelsQuery',
        'StickinessQuery',
        'LifecycleQuery',
      ].includes(value.kind) &&
      (!Array.isArray(value.series) || !value.series.length)
    )
      throw usage('Analytics queries require a nonempty series array.');
    return value;
  },
  targeting: async (path) => {
    const value = await readDefinition(path, 'Targeting');
    if (
      !object(value) ||
      Object.keys(value).some(
        (key) =>
          ![
            'groups',
            'multivariate',
            'aggregation_group_type_index',
            'payloads',
          ].includes(key),
      ) ||
      !Array.isArray(value.groups)
    )
      throw usage(
        'Targeting requires groups and documented filters root keys only.',
      );
    for (const group of value.groups) {
      if (
        !object(group) ||
        !Array.isArray(group.properties) ||
        (group.rollout_percentage !== undefined &&
          (typeof group.rollout_percentage !== 'number' ||
            group.rollout_percentage < 0 ||
            group.rollout_percentage > 100))
      )
        throw usage(
          'Each targeting group requires properties and an optional rollout_percentage from 0 through 100.',
        );
    }
    if (
      value.multivariate != null &&
      (!object(value.multivariate) ||
        !Array.isArray(value.multivariate.variants))
    )
      throw usage('Targeting multivariate requires variants.');
    if (
      value.aggregation_group_type_index !== undefined &&
      value.aggregation_group_type_index !== null &&
      (!Number.isInteger(value.aggregation_group_type_index) ||
        value.aggregation_group_type_index < 0)
    )
      throw usage(
        'Targeting aggregation_group_type_index must be null or a nonnegative integer.',
      );
    if (value.multivariate) {
      const variants = value.multivariate.variants;
      if (
        !variants.length ||
        variants.some(
          (variant) =>
            !object(variant) ||
            typeof variant.key !== 'string' ||
            !variant.key ||
            typeof variant.rollout_percentage !== 'number' ||
            variant.rollout_percentage < 0 ||
            variant.rollout_percentage > 100,
        ) ||
        new Set(variants.map((variant) => variant.key)).size !== variants.length
      )
        throw usage(
          'Variants require unique nonempty keys and rollout_percentage from 0 through 100.',
        );
    }
    if (
      value.payloads != null &&
      (!object(value.payloads) ||
        Object.values(value.payloads).some(
          (payload) => typeof payload !== 'string',
        ))
    )
      throw usage('Targeting payloads must map keys to strings.');
    return value;
  },
};

async function readDefinition(path, label) {
  let value;
  try {
    value = JSON.parse(await readInputFile(path, label));
  } catch (error) {
    if (error.code === 'VALIDATION_ERROR') throw error;
    throw usage(`${label} file must contain valid JSON.`);
  }
  let nodes = 0;
  function visit(item, depth) {
    if (++nodes > 10000 || depth > 20)
      throw usage(
        `${label} exceeds structural limits of 10000 values and 20 levels.`,
      );
    if (typeof item === 'number' && !Number.isFinite(item))
      throw usage(`${label} requires finite numbers.`);
    if (Array.isArray(item)) {
      if (item.length > 1000)
        throw usage(`${label} collections are limited to 1000 entries.`);
      item.forEach((entry) => visit(entry, depth + 1));
    } else if (object(item)) {
      if (Object.keys(item).length > 1000)
        throw usage(`${label} collections are limited to 1000 entries.`);
      for (const [key, entry] of Object.entries(item)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key))
          throw usage(`${label} contains an unsupported key.`);
        visit(entry, depth + 1);
      }
    }
  }
  visit(value, 0);
  return value;
}
