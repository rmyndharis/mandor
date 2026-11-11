# Security policy

mandor runs coding workers on your machine and decides what of their work reaches your history, so a flaw in it can cost more than a wrong result. Reports are welcome.

## Reporting a vulnerability

Report it privately through [GitHub's vulnerability reporting form](https://github.com/rmyndharis/mandor/security/advisories/new). Do not open a public issue or a pull request for it.

Include what you can of:

- the version (`mandor --version`) and the commit, if you run from a clone;
- macOS, Node and the worker CLI involved, with their versions;
- the steps that reproduce it, and what an attacker gains.

mandor is maintained by one person, so an answer can take a few days. A fix or a decision follows as soon as the problem is understood. You are credited in the release notes unless you ask not to be.

## Supported versions

Fixes go into the latest release only.

## What counts

- A worker that writes outside its task worktree and the temporary directories, or reaches the network in a project that has not allowed it.
- A credential, token or agent socket that reaches a worker's environment.
- A change that is committed without the review that accept requires, or a tree that differs from the one the review showed.
- A guard that can be bypassed: a denied path, a symlink to one, or a hostile git configuration that is not refused.
- A hook that runs a command it should not, or breaks a session.
- Anything in a repository, a worker's report or a worker's output that makes mandor run a command.

## What does not

The README states these limits under [Before you start](README.md#before-you-start), and they are not vulnerabilities in mandor:

- A worker can read any file your account can read. With `--worker-network` it can also send one out.
- Workers run on your own logins to their tools and inherit what those tools load.
- A flaw in Codex, ZCode, Antigravity, Claude Code or `sandbox-exec` itself belongs with its vendor. A way mandor makes such a flaw worse is in scope.
