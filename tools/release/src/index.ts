import { create } from './cli/create';
import { plan } from './cli/plan';
import { publish } from './cli/publish';

async function main() {
  const [command, ...flags] = Bun.argv.slice(2);
  const markdown = flags.includes('--markdown');
  const github = flags.includes('--github');

  const validCommand =
    command === 'plan' || command === 'create' || command === 'publish';

  if (
    !validCommand ||
    flags.some((flag) => flag !== '--markdown' && flag !== '--github') ||
    new Set(flags).size !== flags.length ||
    (command === 'create' && markdown) ||
    (command === 'publish' && flags.length > 0)
  ) {
    throw new Error(
      [
        'Usage:',
        '  release plan [--markdown] [--github]',
        '  release create [--github]',
        '  release publish',
        '',
        '--github and publish require GH_REPO=owner/name.',
        'create --github pushes branches and updates release PRs.',
        'publish creates release tags and GitHub releases.',
      ].join('\n'),
    );
  }

  switch (command) {
    case 'plan':
      await plan(github, markdown);
      break;

    case 'create':
      await create(github);
      break;

    case 'publish':
      await publish();
      break;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
