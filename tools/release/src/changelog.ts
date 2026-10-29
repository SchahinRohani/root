import type { Commit, ReleasePlan } from './types';

const sections = [
  ['breaking', '💥 Breaking Changes'],
  ['feat', '✨ Features'],
  ['fix', '🐛 Fixes'],
  ['perf', '⚡ Performance'],
  ['revert', '⏪ Reverts'],
  ['docs', '📚 Documentation'],
  ['refactor', '♻️ Refactoring'],
  ['test', '🧪 Tests'],
  ['build', '📦 Build'],
  ['ci', '🔧 CI'],
  ['chore', '🧹 Maintenance'],
  ['other', 'Other Changes'],
] as const;

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_[\]<>]/g, '\\$&');
}

function renderCommit(commit: Commit): string {
  let description = commit.description;

  if (commit.pullRequest) {
    const suffix = ` (#${commit.pullRequest.number})`;

    if (description.endsWith(suffix)) {
      description = description.slice(0, -suffix.length);
    }
  }

  let entry = `- ${escapeMarkdown(description)}`;

  if (commit.author) {
    const login = commit.author.login;
    entry += ` by [@${login}](https://github.com/${login})`;
  }

  if (commit.pullRequest) {
    entry += ` in [#${commit.pullRequest.number}](${commit.pullRequest.url})`;
  } else if (commit.url) {
    entry += ` ([${commit.sha.slice(0, 7)}](${commit.url}))`;
  } else {
    entry += ` (\`${commit.sha.slice(0, 7)}\`)`;
  }

  return entry;
}

export function renderChangelog(plan: ReleasePlan): string {
  if (plan.nextVersion === null) {
    return '';
  }

  if (plan.commits.length === 0) {
    throw new Error(`${plan.package}: cannot render a release without commits`);
  }

  const groups = new Map<string, string[]>();
  const knownTypes = new Set<string>(sections.map(([type]) => type));

  for (const commit of plan.commits) {
    const group = commit.breaking
      ? 'breaking'
      : knownTypes.has(commit.type)
        ? commit.type
        : 'other';

    const entry = renderCommit(commit);
    const entries = groups.get(group);

    if (entries) {
      entries.push(entry);
    } else {
      groups.set(group, [entry]);
    }
  }

  const output = [`## ${plan.nextVersion}`];

  for (const [type, title] of sections) {
    const entries = groups.get(type);

    if (entries) {
      output.push(`### ${title}\n\n${entries.join('\n')}`);
    }
  }

  const newcomers = (plan.newContributors ?? []).filter(
    (author) =>
      !author.isBot &&
      plan.commits.some(
        (commit) =>
          commit.author?.login.toLowerCase() === author.login.toLowerCase(),
      ),
  );

  if (newcomers.length > 0) {
    const entries = newcomers.map(
      (author) => `- [@${author.login}](https://github.com/${author.login})`,
    );

    output.push('---');
    output.push(`### 👋 New Contributors\n\n${entries.join('\n')}`);
  }

  return `${output.join('\n\n')}\n`;
}

export function prependRelease(
  existing: string | null,
  section: string,
): string {
  const release = section.trim();

  if (!release) {
    return existing ?? '';
  }

  if (existing === null || existing.length === 0) {
    return `# Changelog\n\n${release}\n`;
  }

  const firstRelease = /^##[ \t]+/m.exec(existing);
  const position = firstRelease?.index ?? existing.length;

  const introduction = existing.slice(0, position);
  const history = existing.slice(position);

  const separator =
    introduction.length === 0 || introduction.endsWith('\n\n')
      ? ''
      : introduction.endsWith('\n')
        ? '\n'
        : '\n\n';

  const suffix = history ? `\n${history}` : '';

  return `${introduction}${separator}${release}\n${suffix}`;
}
