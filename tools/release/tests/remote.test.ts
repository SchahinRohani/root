import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/git';
import {
  fetchRemoteBranch,
  pushReleaseBranch,
  readRemoteBranch,
} from '../src/remote';

let directory: string;
let root: string;
let remote: string;
let initialSha: string;

const branch = 'release/document';
const ref = `refs/heads/${branch}`;

function g(...args: string[]): string {
  return git(
    { cwd: root },
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'commit.gpgSign=false',
    ...args,
  ).trim();
}

function nextCommit(parent: string, message: string): string {
  const tree = g('rev-parse', `${parent}^{tree}`);

  return g('commit-tree', tree, '-p', parent, '-m', message);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'release-remote-'));
  root = join(directory, 'repository');
  remote = join(directory, 'remote.git');

  git('init', '--quiet', '--bare', remote);
  git('init', '--quiet', '--initial-branch=main', root);

  g('config', 'user.name', 'Release Test');
  g('config', 'user.email', 'release@example.invalid');

  await Bun.write(join(root, 'README.md'), '# Release test\n');

  g('add', '.');
  g('commit', '--quiet', '-m', 'chore(root): initialize fixture');

  initialSha = g('rev-parse', 'HEAD');

  g('branch', branch);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test('creates a missing remote release branch', () => {
  const state = readRemoteBranch(root, remote, branch);

  expect(state.expectedSha).toBeNull();

  pushReleaseBranch(root, state, {
    branch,
    sha: initialSha,
    changed: true,
  });

  expect(readRemoteBranch(root, remote, branch).expectedSha).toBe(initialSha);
  expect(g('symbolic-ref', '--short', 'HEAD')).toBe('main');
  expect(g('status', '--porcelain')).toBe('');
});

test('updates an existing remote branch using its expected commit', () => {
  g('push', remote, `${initialSha}:${ref}`);

  const state = readRemoteBranch(root, remote, branch);
  const next = nextCommit(initialSha, 'chore(document): release 0.1.1');

  g('update-ref', ref, next, initialSha);

  pushReleaseBranch(root, state, {
    branch,
    sha: next,
    changed: true,
  });

  expect(readRemoteBranch(root, remote, branch).expectedSha).toBe(next);
});

test('allows repeating an unchanged push', () => {
  g('push', remote, `${initialSha}:${ref}`);

  const state = readRemoteBranch(root, remote, branch);

  pushReleaseBranch(root, state, {
    branch,
    sha: initialSha,
    changed: false,
  });

  expect(readRemoteBranch(root, remote, branch).expectedSha).toBe(initialSha);
});

test('refuses a branch created remotely after planning', () => {
  const state = readRemoteBranch(root, remote, branch);
  const competing = nextCommit(initialSha, 'docs: competing change');

  g('push', remote, `${competing}:${ref}`);

  expect(() =>
    pushReleaseBranch(root, state, {
      branch,
      sha: initialSha,
      changed: true,
    }),
  ).toThrow();

  expect(readRemoteBranch(root, remote, branch).expectedSha).toBe(competing);
});

test('refuses a remote branch changed after planning', () => {
  g('push', remote, `${initialSha}:${ref}`);

  const state = readRemoteBranch(root, remote, branch);

  const competing = nextCommit(initialSha, 'docs: competing change');
  const proposed = nextCommit(initialSha, 'chore(document): release 0.1.1');

  g('push', remote, `${competing}:${ref}`);
  g('update-ref', ref, proposed, initialSha);

  expect(() =>
    pushReleaseBranch(root, state, {
      branch,
      sha: proposed,
      changed: true,
    }),
  ).toThrow();

  expect(readRemoteBranch(root, remote, branch).expectedSha).toBe(competing);
});

test('refuses a local branch changed before pushing', () => {
  const state = readRemoteBranch(root, remote, branch);
  const next = nextCommit(initialSha, 'docs: local change');

  g('update-ref', ref, next, initialSha);

  expect(() =>
    pushReleaseBranch(root, state, {
      branch,
      sha: initialSha,
      changed: true,
    }),
  ).toThrow('local branch changed');

  expect(readRemoteBranch(root, remote, branch).expectedSha).toBeNull();
});

test('fetches a remote commit without changing local branches or files', () => {
  const next = nextCommit(initialSha, 'chore(document): release 0.1.1');

  g('push', remote, `${next}:${ref}`);

  const state = readRemoteBranch(root, remote, branch);
  const before = {
    head: g('rev-parse', 'HEAD'),
    refs: g('show-ref'),
    status: g('status', '--porcelain'),
  };

  fetchRemoteBranch(root, state);

  expect({
    head: g('rev-parse', 'HEAD'),
    refs: g('show-ref'),
    status: g('status', '--porcelain'),
  }).toEqual(before);

  expect(g('rev-parse', `${next}^{commit}`)).toBe(next);
});
