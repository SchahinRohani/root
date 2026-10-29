import { describe, expect, test } from 'bun:test';
import { validatePackage } from '../src/config';
import type { PackageConfig } from '../src/types';

describe('package policy', () => {
  const rust = {
    language: 'rust',
    path: 'packages/document',
    scope: 'document',
    manifest: 'Cargo.toml',
    tag_prefix: 'document-v',
    targets: ['cargo', 'binary'],
    containers: ['ghcr', 'dockerhub'],
  } satisfies PackageConfig;

  test('accepts package targets and multiple container registries', () => {
    expect(validatePackage('document', rust)).toEqual(rust);
  });

  test('defaults missing containers to an empty array', () => {
    const result = validatePackage('astro-bun', {
      language: 'typescript',
      path: 'packages/astro-bun',
      scope: 'astro-bun',
      manifest: 'package.json',
      tag_prefix: 'astro-bun-v',
      targets: ['npm'],
    });

    expect(result.targets).toEqual(['npm']);
    expect(result.containers).toEqual([]);
  });

  test('rejects target objects instead of a list', () => {
    expect(() =>
      validatePackage('document', {
        ...rust,
        targets: { cargo: true },
      }),
    ).toThrow('expected an array');
  });

  test('rejects targets incompatible with the language', () => {
    expect(() =>
      validatePackage('document', {
        ...rust,
        targets: ['npm'],
      }),
    ).toThrow('not allowed');
  });

  test('rejects unknown container registries', () => {
    expect(() =>
      validatePackage('document', {
        ...rust,
        containers: ['typo'],
      }),
    ).toThrow('not allowed');
  });

  test('rejects duplicate targets and registries', () => {
    expect(() =>
      validatePackage('document', {
        ...rust,
        targets: ['cargo', 'cargo'],
      }),
    ).toThrow('duplicate');

    expect(() =>
      validatePackage('document', {
        ...rust,
        containers: ['ghcr', 'ghcr'],
      }),
    ).toThrow('duplicate');
  });

  test('rejects a manifest incompatible with the language', () => {
    expect(() =>
      validatePackage('document', {
        ...rust,
        manifest: 'package.json',
      }),
    ).toThrow('requires Cargo.toml');
  });

  test('rejects packages without publication destinations', () => {
    expect(() =>
      validatePackage('document', {
        ...rust,
        targets: [],
        containers: [],
      }),
    ).toThrow('at least one publication destination');
  });
});
