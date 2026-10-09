# ExitCode implementation and removal scope

This package implements the problem-first replacement discussed against the attached source bundle. It is a standalone source replacement, not a deployment to an external repository or an activated Pi installation. The main change is a reusable project driver that produces scenario observations. ExitCode owns approval, immutable acceptance, evidence identity, and fresh completion. The ordinary Pi session owns how to solve the problem.

## What was built

Bootstrap is performed by the existing agent with its normal tools. It publishes infrastructure and driver definitions under `.exitcode/project/`. A generic stdin/stdout protocol supports provisioning, scenario reset and exercise, observation, and cleanup. The command can call arbitrary project software, provision dependencies, use an SDK agent, or wrap another isolation mechanism.

Prepared environments are reused across tasks and stored by content identity. Refresh creates a new environment instance while preserving earlier instances needed by existing seals. The environment is checked before use and after every scenario. Assertions and captured driver files are fixed at approval; product files and product dependencies remain editable during implementation.

Acceptance is a problem, happy path, constraints, and scenarios. Preparation must reproduce declared baseline observations and reject an empty target. It does not construct a passing reference implementation. After user approval, fresh results from all scheduled trials must pass on the current candidate. FAIL and ERROR are distinct. Stale candidates, missing observations, altered sealed definitions, changed evaluator environments, cancellation, and failed cleanup cannot complete the task.

The adapter exposes four tools and a small prompt summary. It retains native project instructions and tools. Work notes link candidate identities and known run records to hypotheses, retained or reverted approaches, regressions, and next experiments. Read-only inspection through the existing evaluate tool restores acceptance and previous evidence after compaction. Pi continues to own session persistence and compaction.

## What was cut

| Removed responsibility | Replacement |
| --- | --- |
| Execution DAG, slice ownership, dependency scheduling | The native agent chooses a working plan and any delegation |
| Private Git worker repositories and worker session backend | Normal native implementation session; project drivers may use SDK sessions to exercise software |
| Merge-tree integration, reconciliation agents, publication, proof caches | Ordinary workspace edits and fresh final acceptance |
| Recursive child contracts, depth limits, ancestor reruns, child withdrawal | The agent revises its diagnosis and implementation approach within one contract |
| Ordered validation sequence and cumulative slice proofs | Scenario drivers express their own execution prerequisites; all root acceptance trials must pass |
| Built-in recipe catalog and discovered literal Node test selectors | One command protocol produces observations from any project runner |
| Mutation DSL, positive source witnesses, rejection fixtures, witness size heuristics | Reproduce the real failing state; reject an empty target; do not build a solution before sealing |
| Semantic critic model calls, review tool parsing, critic warnings and bounds | Human review of the problem, scenarios, and exact assertions |
| E0 probe stages, selective challenge caches, generated file mutations | A baseline and empty-target wiring check for each scenario |
| npm dependency-role classification and evaluator overlay machinery | The project provisions its observer runtime separately from mutable product dependencies |
| Hierarchical implementation attempts, evaluator proposals, soft limits, grant commands | Explicit per-operation watchdogs and recorded runs; no attempt hierarchy |
| Automatic infrastructure retries | Return a typed error, preserve work, and let the agent choose a remedy |
| Automatic restoration of pre-seal or regressed candidates | Preserve edits and invalidate stale preparation or evidence |
| Plain-English quote-based approval and model-callable seal tool | One user command, `/exitcode approve` |
| Separate status and block tools | Compact status, explicit evidence inspection, and an external-input field on work notes |
| Store generations, archive-on-access migration, legacy contract fields | Reject unsupported formats and begin fresh after an explicit operator backup |
| Broad whole-directory privacy that prevented bootstrap maintenance | Editable project definitions and a separate private state directory |

Workspace and bubblewrap execution are explicit choices in the one driver protocol, not old and new compatibility modes. Bubblewrap fails closed; automatic host fallback is removed.

The remaining continuation mechanism is deliberately small: two unchanged nudges, no forced decomposition, and no custom session scheduler. There is no generalized project-discovery service, agent memory engine, job queue, worker pool, testing framework, package manager, or container controller inside the extension.

## Replace the source as one release

Retain these paths from the old layout, replacing their contents with this package:

- `package.json`
- `.gitignore`
- `README.md`
- `exitcode.ts`
- `exitcode-core.mjs`

Remove the old runtime modules completely:

- `exitcode-evaluator.mjs`
- `exitcode-operation.mjs`
- `exitcode-parallel.mjs`
- `exitcode-preparation.mjs`
- `exitcode-quality.mjs`
- `exitcode-workers.mjs`

Remove all old root-level `exitcode-*.test.mjs` files. Remove the five old test helpers and benchmark document: `test/adapter-review-cases.mjs`, `test/optimize-sealed-benchmark.md`, `test/prepared-fixture.mjs`, `test/structural-review.mjs`, and `test/suite.mjs`. Remove the old `scripts/` directory, including the evaluator and sealed benchmarks, old test runner, worker smoke script, and both verification scripts. The attached bundle contains only those six scripts in that directory; preserve unrelated files if your actual repository has additional contents not supplied here.

Add the new files from this package: `exitcode-files.mjs`, `exitcode-runner.mjs`, `exitcode-spec.mjs`, `scripts-check.mjs`, the new `test/` contents, the two example projects, and this removal guide. There are no legacy re-exports or compatibility branches. The old and new test suites are not both run: the old suite asserts responsibilities intentionally removed by this release.

Stop the old extension before installing the replacement. If a target project has an existing `.exitcode/` store, explicitly move it to a backup outside the new `.exitcode/` directory before starting. The replacement refuses the old top-level index and never modifies it. Keep that backup for reference; it is not resumable by this implementation. Rebootstrap project definitions for the new protocol and start a new acceptance contract. Update any project rule that ignores all of `.exitcode/` to ignore only `.exitcode/state/` when reusable definitions should be committed.

Only `exitcode-scenarios-1`, contract version 1, and driver protocol 1 are supported. Unknown legacy fields such as `execution`, `sequence`, and `controls` are rejected. There are no alternate legacy commands, state migration routines, dual paths, or version selection switches.

## Invariants retained

1. The user reviews actual prepared acceptance before implementation authority is released.
2. Acceptance and its driver bytes remain fixed after approval.
3. Product edits do not replace the captured evaluator.
4. Validation executes in independently copied candidates without changing the Git index, branches, or commits.
5. Current candidate and evaluator environment identities must match the evidence being certified.
6. An infrastructure error or cancelled operation is inconclusive and preserves useful work.
7. Historical results, preparation success, and agent claims cannot complete a task.
8. Task ownership and one supervisor operation per workspace are enforced.
9. Refreshing reusable infrastructure preserves the environment of an existing sealed task.
10. Completion requires all scheduled fresh acceptance trials to pass.

## Scope and evidence limits

The initial implementation supports arbitrary software through project drivers, not a universal operating-system emulator. Workspace mode is an explicit trusted host execution boundary; bubblewrap provides the implemented offline Linux boundary. Projects can supply containers, remote environments, or other infrastructure through the driver. The implementation does not claim Windows process-tree cleanup parity or an adversarial permissions boundary for native tools.

Structured output makes comparison mechanical. It does not prove that a semantic observer is correct, that every requested outcome was covered, or that an external system is deterministic. Scenario design and project isolation remain agent-authored work reviewed before sealing. There is no automatic statistical treatment of live model variance; the reviewed scenario states its fixtures, time threshold, trial count, and required passing observations.

The live Pi example is included as a project-level integration driver. It requires a pinned installed SDK and a selected model with credentials. Its observer boundary is tested with an SDK fixture; no live-provider latency result is claimed by this package.

The original eight runtime files contained 5,396 extracted lines and 322,230 bytes. The replacement's five runtime files were approximately 930 lines and 68 KiB during verification, excluding examples, tests, and documentation. This reduction follows removal of the responsibilities above; it is not a claim that every future project driver will be small.
