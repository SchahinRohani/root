import { type BranchResult, prepareBranch } from '../branch';
import { git } from '../git';
import { type PullRequestResult, upsertPullRequest } from '../pull-request';
import { adoptRemoteBranch, pushReleaseBranch } from '../remote';
import { planRelease } from './plan';

export async function create(github: boolean) {
  const release = await planRelease(github);

  if (release.repository && release.remote) {
    const main = git(
      { cwd: release.root },
      'ls-remote',
      '--refs',
      release.remote,
      'refs/heads/main',
    )
      .trim()
      .split('\n')
      .find((line) => line.endsWith('\trefs/heads/main'))
      ?.split('\t')[0];

    if (main !== release.head) {
      throw new Error(
        `HEAD must match ${release.repository}:main before creating release PRs`,
      );
    }
  }

  const results: Array<
    BranchResult & {
      package: string;
      pullRequest?: PullRequestResult;
    }
  > = [];

  for (const plan of release.plans) {
    if (plan.nextVersion === null) continue;

    const state = release.remoteStates.get(plan.package);

    if (state) {
      adoptRemoteBranch(release.root, state, plan);
    }

    const result = await prepareBranch(release.root, plan);

    if (!result) {
      throw new Error(`${plan.package}: expected a release branch`);
    }

    let pullRequest: PullRequestResult | undefined;

    if (release.repository && state) {
      pushReleaseBranch(release.root, state, result);

      pullRequest = await upsertPullRequest(release.repository, plan, result);
    }

    results.push({
      package: plan.package,
      ...result,
      ...(pullRequest ? { pullRequest } : {}),
    });
  }

  console.log(JSON.stringify(results, null, 2));
}
