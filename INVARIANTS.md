# ExitCode invariants

ExitCode owns fixed acceptance, evidence identity, and fresh completion.
Pi owns implementation planning, native tools, project instructions, and session state.
Run the complete replacement suite with `npm test`.
Run runtime syntax checks with `npm run check`.
The old baseline/full split and proof-DAG tests are not part of this release.

Test names below refer to `test/core.test.mjs`, `test/adapter.test.mjs`,
`test/runner.test.mjs`, and `test/pi-driver.test.mjs`.

| Invariant | Why it exists | Canonical tests |
| --- | --- | --- |
| The user approves actual prepared acceptance before product changes are authorized | Preparation reproduces declared baselines and presents the exact scenarios for review | `core: problem-first lifecycle...`, `adapter: review waits...`, `adapter: pre-approval product writes...` |
| Pre-approval product changes invalidate preparation without discarding edits | Explicit resume adopts the current candidate instead of rewinding useful work | `core: pre-approval edits are preserved...`, `core: canonical edits during validation...` |
| Acceptance and captured driver bytes stay fixed after approval | Live project definitions cannot replace the sealed observer | `core: problem-first lifecycle...`, `core: project drift during review...`, `core: sealed-byte and evaluator-runtime tampering...` |
| An observer must reject an empty target | Preparation checks wiring without building a passing reference implementation | `core: an always-passing observer...`, `core: problem-first lifecycle...` |
| Validation runs in independent candidate copies | Setup and trials do not change the canonical product or Git metadata | `core: environment construction is reused...`, `core: problem-first lifecycle...` |
| Only fresh acceptance PASS on the current candidate completes a task | Baselines, approval, historical runs, stale results, and agent claims cannot complete it | `core: problem-first lifecycle...`, `core: canonical edits during validation...`, `adapter: review waits...`, `Pi driver: Pi scenario observer reads the outcome independently...` |
| Every scheduled acceptance trial must pass | Failed samples remain evidence instead of being retried until favorable | `core: every trial contributes to acceptance...` |
| Infrastructure errors and cancellation are inconclusive | Missing measurements, unavailable targets, timeouts, malformed reports, and failed cleanup never count as valid reproduction or completion | `core: schema failures, unavailable real targets...`, `core: cancellation during cleanup...`, `runner: timeout and cancellation...`, `runner: nonzero exit, prose output...`, `runner: assertions distinguish...` |
| Evaluator environment identity stays fixed and is checked after each scenario | Runtime drift cannot certify a candidate | `core: sealed-byte and evaluator-runtime tampering...` |
| Refresh retains environment instances needed by earlier seals | New tasks can rebuild infrastructure without changing an existing task's evaluator | `core: refresh preserves the old sealed environment...`, `core: environment construction is reused...` |
| One task owns the workspace and one supervisor operation runs at a time | Concurrent sessions and cancellation windows cannot interleave state changes | `core: ownership, durable resume...`, `core: only one workspace operation runs...` |
| Supervisor state stays separate from editable project definitions | Native access guards protect acceptance and evidence while allowing bootstrap maintenance | `adapter: pre-approval product writes...`, `core: single format rejects legacy stores...` |
| Isolation is explicit and bubblewrap fails closed | Workspace execution is trusted host execution, not a silent sandbox fallback | `runner: bubblewrap never silently falls back...`, `runner: runner accepts JSON protocol...` |
| Only the replacement format and schemas are supported | Legacy stores remain untouched and require an explicit operator backup | `core: single format rejects legacy stores...` |
| Native tools, project instructions, and session persistence remain Pi responsibilities | ExitCode adds a compact summary and evidence inspection without replacing the harness | `adapter: factory is inert...`, `adapter: session reload retains ownership...`, `adapter: review waits...`, `Pi driver: Pi scenario observer reads the outcome independently...` |
| Work notes separate hypotheses from observations | Notes reference known evidence and record decisions without rolling files back | `core: ownership, durable resume...`, `adapter: session reload retains ownership...` |
| External waits stop continuation and unchanged progress gets at most two nudges | The extension does not introduce a scheduler, forced decomposition, or an unbounded strategy loop | `adapter: session reload retains ownership...`, `adapter: continuation is bounded...` |

Workspace mode and native tools are not an adversarial permissions boundary.
Structured observations do not prove complete intent coverage or observer correctness.
The Pi observer test uses an SDK fixture, not a live provider.
Local test success does not establish the live example's twenty-minute latency target.
