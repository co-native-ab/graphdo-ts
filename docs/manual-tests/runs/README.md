# Manual test runs

This directory holds completed runs of the
[graphdo-ts manual test plan](../test-plan.md).

## Naming convention

```
YYYY-MM-DD-<tester>.md
```

- `YYYY-MM-DD` is the **UTC** date the run started.
- `<tester>` is a short, lowercase, hyphen-separated identifier (e.g.
  `simon`, `lina`, `release-bot`). Keep it stable across your runs so a
  reviewer can quickly compare your runs over time.

If you run more than once on the same day, append a suffix:
`2026-04-21-simon-2.md`.

## Workflow

1. The AI agent creates a new file from the run-log template embedded
   at the bottom of [`../test-plan.md`](../test-plan.md) at the start of
   the run.
2. The agent fills in the file as it walks you through the plan.
3. At the end, **you** (the human) review the file and commit it:

   ```sh
   git add docs/manual-tests/runs/YYYY-MM-DD-<tester>.md
   git commit -m "docs(manual-tests): run YYYY-MM-DD by <tester>"
   ```

4. Aborted / partial runs are still worth committing — record `SKIP`
   on the sections you didn't reach and note why.

## Why commit them?

- They form a release-over-release visual regression record.
- They make it easy to reproduce a tester's environment when something
  surfaces in production.
- They give us a paper trail when reviewing the strict-CSP / hidden-
  attribute kind of bugs the automated test suite can't always catch.
