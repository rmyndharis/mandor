# Changelog

All notable changes to mandor are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- A new worktree is checked out confined, after its own configuration was read, so the repository's `post-checkout` and `post-index-change` hooks no longer run when mandor creates one.
- The README says that the commit hooks at accept can run scripts that the reviewed change altered, that a commit which a hook changes is rolled back, and that mandor starts no git command that names a remote.
- The help and the README describe `mandor models` as the list read at the last refresh.
- The lead's playbook covers a task that stalls on a filter or merge driver, as it covers a command that refuses one.
- An Antigravity job is refused in a project without `--worker-network`, as a ZCode job is. Run `mandor project setup --worker-network` to allow it.
- `init`, `models`, `project setup`, `goal start` and `dispatch` refuse a `MANDOR_HOME` inside a git working tree.
- `status` ends each exhausted line with the reason, the paid-credit mark included, and lists the commits of a goal branch that mandor did not record.
- `status` lists each goal with its integration worktree, and `models` prints each model as `tool:model`, which is how a tier list names it.
- The Stop hook also blocks while a task waits to start, and the lead's playbook says what is the user's to change.
- `mandor project show` prints the stored project configuration. A new `project setup` replaces it whole, so the user repeats what it prints.
- The session summary gives each task its stall reason and next action, each goal its integration worktree, and names the lead skill. It also lists the warnings of the tools that are switched on, and so does `dispatch`. `init` and `models` no longer print Codex's warnings while Codex is off.

### Fixed

- A new worktree, a reset of a task worktree and a drop no longer fail when the configuration sets `submodule.recurse` and the repository has an initialized submodule.
- A task stalled because the handoff after an account mismatch could not be built says so in `wait` and `show`, and names the runner log, instead of repeating the account mismatch.
- `reassign`, `ready`, a fix round and `drop` refuse to start work where `sandbox-exec` cannot confine, and a runner there fails its job before the worker starts, with the cause in the runner log.
- What the Antigravity version and model calls and the ZCode version call print on stderr goes to `logs/vendor.stderr`, as Codex's does, where it was dropped.
- `mandor project setup` exits 2, not 1, for an option it does not know or a value that is missing.
- A job that ends on a runner error says `runner error; see <path of the runner log>` instead of `runner error`.
- Routing passes over a ZCode or an Antigravity candidate in a project without worker network, and `dispatch --use` of one is refused, where a job was created that failed at once and stalled its task.
- `review` and `verdict accept` print a fixed sentence and the path of `logs/git.stderr`, which holds the whole text, when staging, the apply or the commit fails, instead of git's own words, which can quote file names a worker chose or the output of a hook.
- `wait` and `status` settle a task whose job a cancel stopped before the cancel died, which now stalls with `failed`, and a task that waits for a cancelled dependency, which now stalls too.
- A handoff after an account mismatch starts only where routing finds its candidate usable, not on one marked exhausted or one that needs a network the project does not allow.
- A Codex or ZCode resume that opened another session is treated as an account mismatch, as an Antigravity resume already was, instead of being recorded as done.
- A resume that opened another session leaves the task on the session it asked for, whatever the run ended with.
- `cancel` saves the staged change as `cancelled.patch` in the task's round before it removes the worktree, and `show` lists it. When the copy cannot be taken it keeps the worktree and prints `patch: "failed"`.

### Security

- Creating a worktree no longer runs a filter or merge driver that only the worktree's own configuration defines.
- A hook that the git configuration defines no longer runs in a git call that mandor makes in a worktree, except in the commit of an accept.
- The commit of an accept refuses a signing program, or a default ssh key command, that is a path relative to the worktree.
- A relative path in `tools.<tool>.bin` or `MANDOR_CODEX_BIN` is refused instead of resolved against the directory of the command, which can be a task worktree.
- A partial clone is refused, as git would fetch missing objects from its remote by itself.
- A `--deny` entry that names a directory covers everything under it in a commit, as a glob that matches a directory already did in a clone. An entry that ends in a slash names a directory in both.
- The worktree root is verified before the Antigravity settings or the ZCode profile are built from it.
- Accept refuses while a goal branch ends in a commit that mandor did not record. `mandor goal adopt <branch>` keeps such commits as the user's own.

## [0.2.0] - 2026-11-11

### Changed

- A task slug or a goal branch made only of digits is refused.
- The README and SECURITY.md state accurately what confines a worker and where its reads and writes can go.
- The README states the risks of running proofs on worker code, of switching accounts, of sending code to every enabled vendor, of guards that cannot be overridden, of paid usage and of shared directories.

### Fixed

- A ZCode or Antigravity report followed by text that holds braces is read as the report, not as a failed run.
- An Antigravity run that was refused a tool with an unusual name is failed instead of reported done.
- The copy of the ZCode catalog in the state home is readable by the user only.
- `drop` refuses a dirty integration worktree after the goal branch has moved.
- A lock file that cannot be read counts as held, as an unparsable one does.

### Security

- A repository inside the mandor home is refused before any git command writes to it.
- A filter or merge driver configured after dispatch is refused by a handoff, by a dependent task's move to a new goal tip and by `confirm`, as the other steps that stage or check out a worktree already do.
- Git calls inside an existing worktree refuse any filter or merge driver that the worktree's configuration defines, even one set only by an include conditional on its branch or in its own configuration file, and fail when that configuration cannot be read.
- A `GIT_CONFIG` in the environment no longer hides a filter or merge driver from the check.

## [0.1.0] - 2026-11-11

### Added

- The `mandor` CLI and the `/mandor:lead` and `/mandor:status` skills: a Claude Code session plans a goal, dispatches its tasks to workers, reviews each result and accepts it as one local commit on a goal branch.
- Codex, ZCode and Antigravity workers, each in a git worktree of its own under a sandbox. Only Codex is on by default.
- The tiers `light`, `medium` and `heavy`, each an ordered list of worker models a task may run on.
- Guards on every accept, with no override: denied paths, credit to a tool or model, the dash glyphs, and the tool's own name, in the diff and in the commit message.
- `project setup --name-is-a-word`, for a repository whose own subject uses the word *mandor*.
- A SessionStart hook that summarizes the open goals, and a Stop hook that holds a lead whose jobs are still running unwatched.
- State on disk under `~/.mandor`, so a spent quota or an account switch pauses the work instead of losing it.
