<!--
Title: `type: summary`, as in the commit log. See CONTRIBUTING.md.
Say what was wrong or missing, what changed, and what a reviewer should look at closely.
Delete whatever below does not apply.
-->

## Verification

- [ ] `npm run typecheck` and `npm test` pass
- [ ] A test covers any change in what a guard refuses or what a worker may do
- [ ] `CHANGELOG.md` has a line under Unreleased, if a user would notice the change
- [ ] If workers gain reach (a wider environment, a writable path, a weaker guard), the description says why it is safe, and two tests show that the new reach works and that the next thing beyond it is still refused
