# Contributing to mandor

Issues and pull requests are welcome. This page says how each is expected to look, so that yours can be read and merged quickly.

A security problem does not belong in an issue or a pull request: see [SECURITY.md](SECURITY.md).

Everyone who takes part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Issues

- Search the open and closed issues first.
- Use the form that fits: a bug report or a feature request. One problem per issue.
- A bug report needs the steps that reproduce it, what you expected, what happened, and the versions the form asks for. Remove keys, tokens and private paths from any log you paste.
- For a larger change, open an issue before you write the code, so the approach can be agreed first.

## Development setup

mandor runs on macOS only, and needs Node 22.18 or newer. It is TypeScript that Node runs directly: there is no build step and no runtime dependency.

```sh
git clone https://github.com/rmyndharis/mandor.git
cd mandor
npm install          # dev dependencies only, used by the type check
npm run typecheck
npm test
```

Run the tests outside any other sandbox: `sandbox-exec` cannot nest. Load your working copy into a session with `claude --plugin-dir .`, and check the manifest with `claude plugin validate .`.

## Branches

Branch from `main`, and give the branch a short name in lower case with hyphens that says what it does, such as `narrow-name-guard`. Rebase on `main` to catch up; do not merge `main` into your branch.

## Commits

- One logical change per commit, with its tests. Each commit passes the type check and the tests on its own.
- The subject is an imperative sentence of about 50 characters, with a capital first letter, no type prefix and no full stop: `Print the usage for --help after a command`.
- Add a body when the subject is not enough. Wrap it at 72 characters, and say why the change is needed and what it costs, not what the diff already shows.
- Keep the history about the change: no account of the order things were tried in.

## Pull requests

- The title has the form of a commit subject. With one commit, use that commit's subject.
- The description says what was wrong or missing, what changed, anything a reviewer should look at closely, and how you verified it. Keep it short and complete; delete any part of the template that would be empty.
- Add a test for any change in what a guard refuses or what a worker may do.
- A change that gives workers more reach than they have today (a wider environment, a writable path, a weaker guard) explains in the description why it is safe.
- Add a line to `CHANGELOG.md` when a user would notice the change (see below).
- Every check must pass. Pull requests land on `main` as a fast-forward, so your commits arrive as you wrote them.

## Changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). A change a user would notice gets one line under `## [Unreleased]`, in the group it belongs to: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` or `Security`. Say what changed for the user, in one sentence. A refactoring, a test or a change to the workflows needs no line.

## Versioning

mandor follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The version covers what a user or a script depends on: the commands and their options, `config.json` and `project.json`, the state under `~/.mandor` that an older version wrote, and the names of the skills.

- **Patch**: fixes that change none of these.
- **Minor**: additions that keep existing use working.
- **Major**: anything that breaks existing use. While the version is below 1.0, a minor release may do so, and the changelog says it under `Changed` or `Removed`.

The version is written in `package.json`, `package-lock.json` and `.claude-plugin/plugin.json`. A test fails when they differ.

## Releasing

For maintainers.

1. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` and put a new, empty `## [Unreleased]` above it.
2. Set the version: `npm version X.Y.Z --no-git-tag-version`, then the same number in `.claude-plugin/plugin.json`.
3. Commit both as `Release X.Y.Z`, open a pull request, and land it once the checks pass.
4. Tag that commit and push the tag on its own: `git tag -a vX.Y.Z -m vX.Y.Z`, then `git push origin vX.Y.Z`. Push one tag per command.

The tag starts the release workflow. It runs the checks again, refuses a tag that does not match the version in `package.json`, and publishes a GitHub release whose notes are that version's section of the changelog.
