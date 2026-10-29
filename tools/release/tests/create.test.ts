import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/index.ts', import.meta.url));

test('GitHub release preparation works across repeated runs and fresh checkouts', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'release-create-'));

  try {
    const remote = join(temporary, 'remote.git');
    const first = join(temporary, 'first');
    const second = join(temporary, 'second');
    const bin = join(temporary, 'bin');
    const stateFile = join(temporary, 'github.json');
    const repository = 'release-test/root';
    const remoteUrl = `https://github.com/${repository}.git`;

    await mkdir(bin, { recursive: true });

    const env = {
      ...process.env,
      GH_REPO: repository,
      GITHUB_REPOSITORY: repository,
      GH_TOKEN: 'test-token',
      GITHUB_TOKEN: 'test-token',
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      RELEASE_TEST_REMOTE: remote,
      RELEASE_TEST_STATE: stateFile,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '5',
      GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`,
      GIT_CONFIG_VALUE_0: remoteUrl,
      GIT_CONFIG_KEY_1: 'user.name',
      GIT_CONFIG_VALUE_1: 'Release Test',
      GIT_CONFIG_KEY_2: 'user.email',
      GIT_CONFIG_VALUE_2: 'release@example.invalid',
      GIT_CONFIG_KEY_3: 'commit.gpgSign',
      GIT_CONFIG_VALUE_3: 'false',
      GIT_CONFIG_KEY_4: 'core.hooksPath',
      GIT_CONFIG_VALUE_4: '/dev/null',
    };

    function run(cwd: string, command: string[]): string {
      const result = Bun.spawnSync(command, {
        cwd,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });

      if (result.exitCode !== 0) {
        throw new Error(
          result.stderr.toString().trim() ||
            `Command failed: ${command.join(' ')}`,
        );
      }

      return result.stdout.toString();
    }

    function git(cwd: string, ...args: string[]): string {
      return run(cwd, ['git', ...args]).trim();
    }

    async function write(root: string, path: string, content: string) {
      const destination = join(root, path);

      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }

    await writeFile(
      stateFile,
      JSON.stringify({ pull: null, creates: 0, updates: 0 }),
    );

    const fakeGh = join(bin, 'gh');

    await writeFile(
      fakeGh,
      `#!${process.execPath}
const args = Bun.argv.slice(2);
const statePath = process.env.RELEASE_TEST_STATE;
const remote = process.env.RELEASE_TEST_REMOTE;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function argument(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function headSha() {
  const result = Bun.spawnSync([
    'git',
    '--git-dir',
    remote,
    'rev-parse',
    'refs/heads/release/document',
  ], { stdout: 'pipe', stderr: 'pipe' });

  if (result.exitCode !== 0) fail('Release branch is missing');
  return result.stdout.toString().trim();
}

if (args[0] !== 'api') fail('Unexpected gh command');

const method = argument('--method') ?? 'GET';
const methodIndex = args.indexOf('--method');
const endpoint = args[methodIndex + 2];

if (!endpoint?.startsWith('repos/release-test/root/')) {
  fail('Unexpected repository or endpoint: ' + endpoint);
}

const state = await Bun.file(statePath).json();
let response;

if (method === 'GET' && endpoint.includes('/commits?')) {
  response = [];
} else if (method === 'GET' && endpoint.endsWith('/pulls?per_page=100')) {
  response = [];
} else if (
  method === 'GET' &&
  endpoint.startsWith('repos/release-test/root/commits/')
) {
  response = {
    author: { login: 'release-tester', type: 'User' },
  };
} else if (
  method === 'GET' &&
  endpoint.startsWith('repos/release-test/root/pulls?')
) {
  response = state.pull
    ? [{ ...state.pull, head: { ...state.pull.head, sha: headSha() } }]
    : [];
} else if (
  method === 'POST' &&
  endpoint === 'repos/release-test/root/pulls'
) {
  if (state.pull) fail('Duplicate release PR');

  const body = JSON.parse(await Bun.stdin.text());

  state.pull = {
    number: 1,
    html_url: 'https://github.com/release-test/root/pull/1',
    title: body.title,
    body: body.body,
    state: 'open',
    head: {
      ref: body.head,
      sha: headSha(),
      repo: { full_name: 'release-test/root' },
    },
    base: {
      ref: body.base,
      repo: { full_name: 'release-test/root' },
    },
  };

  state.creates += 1;
  response = state.pull;
} else if (
  method === 'PATCH' &&
  endpoint === 'repos/release-test/root/pulls/1'
) {
  if (!state.pull) fail('Cannot update missing PR');

  const body = JSON.parse(await Bun.stdin.text());

  state.pull = {
    ...state.pull,
    title: body.title,
    body: body.body,
    head: { ...state.pull.head, sha: headSha() },
  };

  state.updates += 1;
  response = state.pull;
} else {
  fail('Unexpected GitHub request: ' + method + ' ' + endpoint);
}

await Bun.write(statePath, JSON.stringify(state));
console.log(JSON.stringify(response));
`,
    );

    await chmod(fakeGh, 0o755);

    git(
      temporary,
      'init',
      '--quiet',
      '--bare',
      '--initial-branch=main',
      remote,
    );
    git(temporary, 'init', '--quiet', '--initial-branch=main', first);

    await write(
      first,
      'tools/release/packages.toml',
      [
        '[packages.document]',
        'language = "rust"',
        'path = "packages/document"',
        'scope = "document"',
        'manifest = "Cargo.toml"',
        'tag_prefix = "document-v"',
        'targets = ["cargo"]',
        'containers = ["ghcr"]',
        '',
      ].join('\n'),
    );

    await write(
      first,
      'packages/document/Cargo.toml',
      '[package]\nname = "document"\nversion = "0.1.0"\n',
    );

    await write(first, 'packages/document/README.md', '# Document\n');

    git(first, 'add', '.');
    git(first, 'commit', '--quiet', '-m', 'chore(root): initialize fixture');
    git(first, 'tag', 'document-v0.1.0');

    await write(
      first,
      'packages/document/README.md',
      '# Document\n\nEmpty input is supported.\n',
    );

    git(first, 'add', '.');
    git(first, 'commit', '--quiet', '-m', 'fix(document): handle empty input');
    git(first, 'push', remoteUrl, 'main', '--tags');

    const mainSha = git(first, 'rev-parse', 'HEAD');

    const preview = JSON.parse(
      run(first, [process.execPath, cli, 'plan', '--github']),
    );

    expect(preview[0].nextVersion).toBe('0.1.1');
    expect(preview[0].commits[0].author.login).toBe('release-tester');

    expect(
      git(first, 'ls-remote', '--heads', remoteUrl, 'release/document'),
    ).toBe('');

    expect((await Bun.file(stateFile).json()).creates).toBe(0);

    const created = JSON.parse(
      run(first, [process.execPath, cli, 'create', '--github']),
    );

    expect(created).toHaveLength(1);
    expect(created[0].changed).toBe(true);
    expect(created[0].pullRequest.action).toBe('created');

    const releaseSha = created[0].sha;

    expect(git(first, 'rev-parse', 'HEAD')).toBe(mainSha);
    expect(git(first, 'status', '--porcelain')).toBe('');

    expect(
      git(first, 'show', `${releaseSha}:packages/document/Cargo.toml`),
    ).toContain('version = "0.1.1"');

    const repeated = JSON.parse(
      run(first, [process.execPath, cli, 'create', '--github']),
    );

    expect(repeated[0].sha).toBe(releaseSha);
    expect(repeated[0].changed).toBe(false);
    expect(repeated[0].pullRequest.action).toBe('unchanged');

    git(
      temporary,
      'clone',
      '--quiet',
      '--single-branch',
      '--branch',
      'main',
      remoteUrl,
      second,
    );

    const resumed = JSON.parse(
      run(second, [process.execPath, cli, 'create', '--github']),
    );

    expect(resumed[0].sha).toBe(releaseSha);
    expect(resumed[0].changed).toBe(false);
    expect(resumed[0].pullRequest.action).toBe('unchanged');

    await write(
      second,
      'packages/document/README.md',
      '# Document\n\nEmpty input and large input are supported.\n',
    );

    git(second, 'add', '.');
    git(second, 'commit', '--quiet', '-m', 'fix(document): handle large input');
    git(second, 'push', remoteUrl, 'main');

    const updated = JSON.parse(
      run(second, [process.execPath, cli, 'create', '--github']),
    );

    expect(updated[0].sha).not.toBe(releaseSha);
    expect(updated[0].pullRequest.action).toBe('updated');

    expect(
      git(second, 'show', `${updated[0].sha}:packages/document/Cargo.toml`),
    ).toContain('version = "0.1.1"');

    const state = await Bun.file(stateFile).json();

    expect(state.creates).toBe(1);
    expect(state.updates).toBe(1);
    expect(state.pull.body).toContain('handle empty input');
    expect(state.pull.body).toContain('handle large input');
    expect(git(second, 'status', '--porcelain')).toBe('');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 30_000);
