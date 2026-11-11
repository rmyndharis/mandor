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

- A worker whose commands or edits write outside its task worktree, the temporary directories, the cache directories the project opens and, for ZCode, its own home and the per-user cache directory, or whose commands reach the network in a project that has not allowed it. Antigravity is the exception for the network: its sandbox's proxy decides, as the README says.
- A credential, token or agent socket that reaches a worker's environment.
- A change that is committed without the review that accept requires, or a tree that differs from the one the review showed.
- A guard that can be bypassed: a denied path, a symlink to one, or a hostile git configuration that is not refused.
- A hook that runs a command it should not, or breaks a session.
- Anything in a repository, a worker's report or a worker's output that makes mandor run a command.

## What does not

The README states these limits in its Safety model and under [Before you start](README.md#before-you-start), and they are not vulnerabilities in mandor:

- A worker can read any file your account can read, and what its model reads reaches the worker's vendor. With `--worker-network`, or with Antigravity at whatever its sandbox's proxy lets through, its commands can also send one out.
- Workers run on your own accounts at their tools, and a Codex worker inherits what Codex loads for you.
- Your code reaches the vendor of every tool you have enabled, as tools are enabled per machine, not per project.
- To check a result, the Claude Code session that leads the work runs the task's tests and builds on code a worker wrote, with your privileges and no sandbox. The temporary and cache directories a project opens are shared with those commands and with your own tools.
- The repository's own git hooks run with your privileges and no sandbox, and at accept they run over a change a worker wrote.
- The guard that refuses credit to a tool has no override, and it refuses only the usual forms: a plain sentence that says an AI tool was used can pass it.
- Paid usage is not always stopped: nothing switches it off for Codex or ZCode, and mandor looks for it only for Codex, after a finished run.
- A flaw in Codex, ZCode, Antigravity, Claude Code or `sandbox-exec` itself belongs with its vendor. A way mandor makes such a flaw worse is in scope.
