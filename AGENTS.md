# Agent instructions

Use Beads for issue tracking.
Run `mise exec -- bd prime` for the current Beads workflow.
Read `README.md` for the repository layout, build commands, and publishing plan.
When asked to take the next task, run `mise exec -- bd ready --claim --json` to claim the first ready issue.
Run `mise exec -- bd show <id>` to read the issue, its dependencies, and its handoff notes before starting work.
