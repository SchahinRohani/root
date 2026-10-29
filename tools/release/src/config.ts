import { join } from 'node:path';
import type { ContainerRegistry, PackageConfig, Target } from './types';
import { parseVersion } from './version';

const policy: Record<
  PackageConfig['language'],
  {
    manifest: PackageConfig['manifest'];
    targets: readonly Target[];
    containers: readonly ContainerRegistry[];
  }
> = {
  typescript: {
    manifest: 'package.json',
    targets: ['npm'],
    containers: [],
  },
  rust: {
    manifest: 'Cargo.toml',
    targets: ['cargo', 'binary'],
    containers: ['ghcr', 'dockerhub'],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateList<T extends string>(
  name: string,
  value: unknown,
  allowed: readonly T[],
): T[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${name}: expected an array`);
  }

  const choices: readonly string[] = allowed;
  const seen = new Set<string>();

  for (const entry of value) {
    if (typeof entry !== 'string' || !choices.includes(entry)) {
      throw new Error(`${name}: entry is not allowed: ${String(entry)}`);
    }

    if (seen.has(entry)) {
      throw new Error(`${name}: duplicate entry: ${entry}`);
    }

    seen.add(entry);
  }

  return value as T[];
}

export function validatePackage(name: string, value: unknown): PackageConfig {
  function invalid(message: string): never {
    throw new Error(`${name}: ${message}`);
  }

  if (!isRecord(value)) {
    invalid('expected a package table');
  }

  const language = value.language;

  if (language !== 'typescript' && language !== 'rust') {
    invalid('language must be typescript or rust');
  }

  for (const field of ['path', 'scope', 'tag_prefix'] as const) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      invalid(`${field} must be a non-empty string`);
    }
  }

  const rules = policy[language];

  if (value.manifest !== rules.manifest) {
    invalid(`${language} requires ${rules.manifest}`);
  }

  const targets = validateList(`${name}.targets`, value.targets, rules.targets);

  const containers = validateList(
    `${name}.containers`,
    value.containers,
    rules.containers,
  );

  if (targets.length === 0 && containers.length === 0) {
    invalid('at least one publication destination is required');
  }

  return {
    language,
    path: value.path as string,
    scope: value.scope as string,
    manifest: rules.manifest,
    tag_prefix: value.tag_prefix as string,
    targets,
    containers,
  };
}

export async function readPackages(
  root: string,
): Promise<Record<string, PackageConfig>> {
  const config: unknown = Bun.TOML.parse(
    await Bun.file(join(root, 'tools/release/packages.toml')).text(),
  );

  if (
    !isRecord(config) ||
    !isRecord(config.packages) ||
    Object.keys(config.packages).length === 0
  ) {
    throw new Error('Configuration must contain at least one package');
  }

  return Object.fromEntries(
    Object.entries(config.packages).map(([name, value]) => [
      name,
      validatePackage(name, value),
    ]),
  );
}

export async function readVersion(
  root: string,
  pkg: PackageConfig,
): Promise<string> {
  const file = Bun.file(join(root, pkg.path, pkg.manifest));

  const data: unknown =
    pkg.manifest === 'package.json'
      ? await file.json()
      : Bun.TOML.parse(await file.text());

  let version: unknown;

  if (isRecord(data)) {
    if (pkg.manifest === 'package.json') {
      version = data.version;
    } else if (isRecord(data.package)) {
      version = data.package.version;
    }
  }

  if (typeof version !== 'string') {
    throw new Error(`Missing version in ${pkg.path}/${pkg.manifest}`);
  }

  parseVersion(version);
  return version;
}
