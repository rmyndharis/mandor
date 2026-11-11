# Changelog

All notable changes to mandor are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
