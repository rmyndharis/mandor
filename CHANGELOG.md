# Changelog

All notable changes to mandor are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A ZCode or Antigravity report followed by text that holds braces is read as the report, not as a failed run.
- An Antigravity run that was refused a tool with an unusual name is failed instead of reported done.
- The copy of the ZCode catalog in the state home is readable by the user only.

## [0.1.0] - 2026-11-11

### Added

- The `mandor` CLI and the `/mandor:lead` and `/mandor:status` skills: a Claude Code session plans a goal, dispatches its tasks to workers, reviews each result and accepts it as one local commit on a goal branch.
- Codex, ZCode and Antigravity workers, each in a git worktree of its own under a sandbox. Only Codex is on by default.
- The tiers `light`, `medium` and `heavy`, each an ordered list of worker models a task may run on.
- Guards on every accept, with no override: denied paths, credit to a tool or model, the dash glyphs, and the tool's own name, in the diff and in the commit message.
- `project setup --name-is-a-word`, for a repository whose own subject uses the word *mandor*.
- A SessionStart hook that summarizes the open goals, and a Stop hook that holds a lead whose jobs are still running unwatched.
- State on disk under `~/.mandor`, so a spent quota or an account switch pauses the work instead of losing it.
