# Contributing

Thanks for your interest in contributing.

## Workflow

All changes go through pull requests against `main`. No direct pushes.

1. Fork the repo and create a feature branch from `main`.
2. Make your changes. Keep PRs focused on a single concern — one PR per topic.
3. Link related issues in the PR description (`Closes #123`, `Refs #456`).
4. Open a pull request. CI must be green before merge.

## Development setup

This repo uses [Nix](https://nixos.org) for reproducible environments.

```sh
nix develop
```

All required tooling (formatters, linters, pre-commit hooks) is provided.

## Commit style

Use [Conventional Commits](https://www.conventionalcommits.org/) prefixes:
`feat:`, `fix:`, `chore:`, `ci:`, `docs:`, `refactor:`, `test:`.

A commit body is optional — use it when the subject line alone doesn't convey the why or context.

## Questions

Open a [discussion](https://github.com/ScaliirDigital/root/discussions) for anything that's not a bug report or feature request.
