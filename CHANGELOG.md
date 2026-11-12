# Changelog

All notable changes to mandor are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Breaking:** Antigravity takes part only when `tools.agy.acknowledged` is `true` besides `tools.agy.enabled`. With `enabled` alone it is not run, and `init`, `models`, the session summary, `dispatch` and a refused `--use` say so with the notice and the step. The notice now says what is understood of Google's published answers, not a fact about its terms. A config that had Antigravity on stays off until the setting is added.
- A new worktree is checked out confined, after its own configuration was read, so the repository's `post-checkout` and `post-index-change` hooks no longer run when mandor creates one.
- The README says that the commit hooks at accept can run scripts that the reviewed change altered, that a commit which a hook changes is rolled back, and that mandor starts no git command that names a remote.
- The help and the README describe `mandor models` as the list read at the last refresh.
- The `test-skipped` red flag also names a skip that depends on a condition: an assumption such as `assumeTrue(`, and JUnit's conditional annotations such as `@DisabledOnOs` and `@EnabledIf`.
- **Breaking:** the ZCode jobs of each project run on a home of their own, `zcode/homes/<project>` in the state home, where they all ran on one home. The sign-in stays in `zcode/home`, which no worker can read, and is copied into the project's home at every job start, so a key or a plan that a worker changed lasts no longer than its job. A browser sign-in is now encrypted with a secret kept in `zcode/credential-secret`: one made before must be made again, and an API key needs nothing. A ZCode task in flight when mandor is updated loses its session and is handed over to a new one, as after a change of account. Each home takes about 64 MB and is removed when a job ends after its project's state is gone.
- The README says that the hooks, tool servers and instructions a ZCode worker leaves in its project's home are loaded by that project's later jobs, and that the home keeps the input and output of every session.
- The README says what a Codex worker loads from the user's Codex home: instructions, skills and rules, not plugins, tool servers or hooks, and that a rule which allows a command runs it outside the worker's sandbox, with any arguments after its prefix.
- The lead's playbook covers a task that stalls on a filter or merge driver, as it covers a command that refuses one.
- The lead's playbook and the README say that once a task that changed a generator input is confirmed, later worktrees of its goal clone the older copy that the user's checkout holds, which the user rebuilds from the goal's version first.
- An Antigravity job is refused in a project without `--worker-network`, as a ZCode job is. Run `mandor project setup --worker-network` to allow it.
- `init`, `models`, `project setup`, `goal start` and `dispatch` refuse a `MANDOR_HOME` inside a git working tree.
- `status` ends each exhausted line with the reason, the paid-credit mark included, and lists the commits of a goal branch that mandor did not record.
- `status` lists each goal with its integration worktree, and `models` prints each model as `tool:model`, which is how a tier list names it.
- The Stop hook also blocks while a task waits to start, and the lead's playbook says what is the user's to change.
- `mandor project show` prints the stored project configuration. A new `project setup` replaces it whole, so the user repeats what it prints.
- The session summary gives each task its stall reason and next action, each goal its integration worktree, and names the lead skill. It also lists the warnings of the tools that are switched on, and so does `dispatch`. `init` and `models` no longer print Codex's warnings while Codex is off.
- `mandor tiers` lists each tier's candidates as the config writes them, with what keeps one from running.
- `mandor diff <slug>` prints a task's change as patch text, through the same confined staging as the review, and records no review.
- `mandor project setup --shared-temp` keeps the shared temporary directories open to a Codex or ZCode worker, for a toolchain that cannot work without them. A JVM gets its temporary directory from `JAVA_TOOL_OPTIONS`.
- `mandor project setup --update` starts from the stored configuration, so one setting is added or removed without restating the others. `--remove-clone`, `--remove-shared`, `--remove-deny`, `--remove-generator` and `--remove-worker-add-dir` take one entry away, and `--no-setup`, `--no-worker-network`, `--no-name-is-a-word` and `--no-shared-temp` switch one setting off. A setup without `--update` still replaces the whole configuration.
- `mandor project setup --worker-deny-read <path>` closes a file or directory to the reads of a ZCode worker's commands, on top of its credential directories, and `--remove-worker-deny-read` takes it away. A path that holds or lies inside the repository's git directory, or lies inside the mandor home, is refused, and the worker's worktree, home, job directory and `--worker-add-dir` cache directories stay readable.
- `mandor verdict <slug> answer --notes <file>` answers a worker report that is blocked, partial or asks questions. `wait` gives such a task the next action `answer`, `show` and the session summary say so, and the review pack has a `report-asks` flag. The worker resumes in a round that no fix round pays for, up to as many answers as fixes are allowed.
- `wait` and `status` settle the marker of an accept that was killed, as the accept would: undone when nothing landed, adopted when one commit landed with the recorded tree. What they cannot settle stays for the accept to report.
- A worker's file names and diffs show the marks that turn text around (U+202A to U+202E, U+2066 to U+2069) as `\uNNNN`, as they show control bytes as `\xNN`.
- Error messages name the next step, and say to tell the user where only the user can take it. A usage error points at `mandor --help`. A test reads every message written out in the source.
- While ZCode is on, `mandor init`, `mandor models`, the session summary and `dispatch` say that mandor does not switch billing off for it or detect billed usage, and that a stored key may be one that is billed per use. `mandor login zcode` says it too.
- A takeover of a stalled task needs `--approved` whatever stopped it, where only `all-exhausted` and `fix-rounds-exceeded` did. The takeover verdict records whether `--approved` was passed and whether the task needed it, and `show` lists each takeover as `approved`, `approved (not required)`, `not required` or `not recorded`.
- The lead's playbook has the lead say, when it offers a change of account, that whether it fits the vendor's terms is a question for the account holder.

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
- `wait` and `status` stop the worker of a job whose runner died, as they settle it, where it ran on with no timeout and could still write.
- `confirm` and `cancel`, run again after the task was accepted or cancelled, remove the worktree and branch that a kill or a failed removal left. A `cancel` run again takes the copy of the change first, if none was saved. They record nothing, and still refuse when nothing is left.
- `status` names a goal whose accept was killed before it finished, also as `unfinished` in `--json`, and `fix`, `takeover` and `cancel` refuse that task until an accept settles it. The goal's line of the session summary and the red flag `accept-unfinished` of a review say it too.
- A model refresh that no tool answered is not repeated for five minutes, where every command that needed the list asked each tool again.
- Staging a task worktree for a review, a diff, a handoff or a cancel no longer writes the worker's files into the repository's object store, where they stayed until git pruned them, nor changes the worker's own index. It runs on a copy of the index with an object directory of its own, which it removes; the next staging removes one that a kill left.
- A review, a diff and the apply of an accept work in a repository whose path holds a colon, and a rebase puts back a file that the worker's own ignore rules had made visible. A review whose ignored paths cannot be listed still gives its pack, and a review that failed leaves no record for accept to follow.
- The commit of an accept is stopped after ten minutes, with what its hooks started, and the accept is undone, where a hook that never returned held the project lock. The commit goes on when its accept is interrupted, and the next accept or settle stops one that is past the limit.

### Security

- Creating a worktree no longer runs a filter or merge driver that only the worktree's own configuration defines.
- A hook that the git configuration defines no longer runs in a git call that mandor makes in a worktree, except in the commit of an accept.
- The commit of an accept refuses a signing program, or a default ssh key command, that is a path relative to the worktree.
- A relative path in `tools.<tool>.bin` or `MANDOR_CODEX_BIN` is refused instead of resolved against the directory of the command, which can be a task worktree.
- A partial clone is refused, as git would fetch missing objects from its remote by itself.
- A `--deny` entry that names a directory covers everything under it in a commit, as a glob that matches a directory already did in a clone. An entry that ends in a slash names a directory in both.
- The worktree root is verified before the Antigravity settings or the ZCode profile are built from it.
- Accept refuses while a goal branch ends in a commit that mandor did not record. `mandor goal adopt <branch>` keeps such commits as the user's own.
- A Codex or ZCode worker gets a temporary directory of its own for each job, as its `TMPDIR`, `TMPPREFIX` (zsh) and clang's module cache, removed when the run ends. `/tmp`, `/var/folders` and the shared `TMPDIR` are closed to it, as the lead's proofs and your own tools keep caches and compiled files there. A build that names `/tmp` itself, runs `mktemp` or needs the per-user cache directory fails in the sandbox; `mandor project setup --shared-temp` keeps them open. Antigravity's temporary directories are its sandbox's own.
- The staged tree of a review and an accept reads every file whatever `core.ignoreStat`, `core.trustCtime` and `core.checkStat` say of stat data, which let an edit that kept a file's size and times pass unseen.
- The review pack names the ignored paths whose files changed since the task's first job began, such as `build/` or `node_modules/`, which the staged tree leaves out and the lead's proof commands may still run.
- A project set up with `--shared-temp` is refused a goal start, a dispatch, a fix, an answer, a drop and a reassign, and a job about to start fails, while the state home or the repository lies under `/tmp`, `/var/folders` or the `TMPDIR` of the process or the job, which its Codex and ZCode workers can then write.
- Before a fix, an answer, a drop or a reassign is recorded, and before each job, the root of the task worktree is checked for agent paths that the base commit does not hold as they are, ignored ones included. Nothing starts while one is there: the command is refused with the entries named and nothing recorded, and a job that a process wrote one for after the check fails the same way, which `reassign` runs again once they are removed or restored. Codex starts the tool servers that a `.codex/config.toml` names outside its sandbox, and a round of another tool can write one.
- mandor's writes into the ZCode worker's home, the catalog copy and a stored key, are confined to that directory by the kernel and written under a random name that is renamed over the file's own, so a link or a file that a worker put in its home leads nowhere. The worker's commands cannot remove or move the home, and `login zcode`, a dispatch and the model list refuse while the home or a sign-in directory in it is not a directory.
- An atomic write takes a temporary name that nothing can guess, and leaves none behind when it fails.
- The ZCode profile denies a credential directory that is a link by the path it leads to, and leaves a path that leads to a device such as `/dev/null` readable.
- The writes of the ZCode version call are confined to the worker's home, as mandor's own writes into it are.
- A plan id in the ZCode worker's sign-in file that is not of the shape `account:<name>` is refused, where it was printed and written into each job's provider file as it stood.

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
