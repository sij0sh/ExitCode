# ExitCode

ExitCode keeps long-running coding agents tied to a fixed definition of done.
It validates acceptance checks before asking you to approve the plan.
It then enforces that exact plan through fresh evaluation, bounded repair, and focused recursion.

## Workflow

```text
Request -> Discovery -> optional Clarification -> EVALUATOR_PREPARATION
        -> READY_FOR_APPROVAL -> Approval -> Seal -> Execution
        -> fresh Evaluation -> Repair or child -> fresh root PASS
```

1. Inspect the request, implementation, tests, and likely regressions.
2. Declare materially distinct request outcomes and map them to observable criteria.
3. Reuse relevant repository tests before constructing focused checks and positive/negative fixtures.
4. Independently review outcomes and challenge the evaluator with sham implementations inside candidate copies.
5. Repair typed evaluator failures before asking for approval.
6. Present the validated goal, criteria, assumptions, exclusions, and verification summary.
7. Approve the exact validated plan or request changes.
8. Implement and evaluate all sealed criteria fresh.

Mechanical evaluator failures do not request another approval.
A requested plan change requires preparation and review again.
Preparation never approves, seals, changes the real candidate, or consumes implementation attempts.
A passing baseline does not complete the goal.
Only fresh supervisor evaluation can close it.

The normal path needs one approval and no clarification turn.
Ask a question only when there are multiple credible interpretations, a material effect on acceptance or compatibility, and no resolved repository convention or default.
Group at most three questions and include the recommended default.
A material unresolved question pauses the run in CLARIFICATION.
READY_FOR_APPROVAL pauses automatic continuation; the candidate stays read-only until sealing.
Silence and requests for changes are not approval.

## Usage

```bash
pi --extension /absolute/path/to/ExitCode/exitcode.ts
```

For persistent loading, run `pi install .` in this repository.
Pi supplies `typebox` and its extension API.
No production npm dependency is added.
A compatible Pi installation and Node runtime are required.

**Executable evaluation requires Linux bubblewrap and usable unprivileged namespaces.**
Install bubblewrap with your system package manager before using executable recipes.
ExitCode never installs it or falls back to host execution.
Built-in file and JSON recipes do not need bubblewrap.
Unavailable isolation is a runner error, not evidence of a detected defect.

```text
/exitcode Add password reset via emailed tokens
```

| Command | Purpose |
| --- | --- |
| `/exitcode approve` | Approve and seal the exact validated plan. |
| `/exitcode status` | Show policy, original request, commands, digests, evidence, metrics, and next action. |
| `/exitcode exit` | Cancel enforcement without claiming success or deleting work. |
| `/exitcode resume [Gid]` | Resume the same root, pending review, or saved operation, even while mode is on. |
| `/exitcode resume minutes=N attempts=N evaluators=N` | Record explicit positive execution or evaluator-construction grants and resume. |

Plain-English approval also works.
The agent quotes your acceptance when calling `exitcode_seal`.
The supervisor binds it to the prepared bundle and policy.
New roots approve an execution duration, not a countdown spent during review.
Legacy sealed roots keep their original clock.
It does not authenticate the origin or semantic meaning of that quote.

The adapter exposes six tools only during ExitCode mode.
`exitcode_draft` automatically prepares root proposals and returns either typed repair diagnostics or a validated review.
`exitcode_seal` seals a reviewed bundle without rerunning preparation.
Stale candidate, environment, or evaluator evidence requires preparation and approval again.
`exitcode_evaluate` runs sealed checks fresh.
`exitcode_child` proposes one reduction of a failed parent criterion.
`exitcode_block` preserves a concrete blocker as a resumable root pause.
Only a genuinely declined child path uses `NO_PATH` to withdraw child edits and rerun its ancestors.
`exitcode_status` exposes detailed mechanics.
Only root PASS automatically exits mode.
PAUSED and legacy BLOCKED roots keep enforcement on until user cancellation.

## Before sealing

ExitCode never changes your tool loadout or classifies tools by name.
Any built-in, custom, or extension tool stays available in every phase.
Instead, ExitCode enforces two state invariants:

- Before sealing, the candidate is immutable.
- `.exitcode/` is private to the supervisor in every phase.

Entering `/exitcode` or proposing a child snapshots the current candidate as the pre-seal baseline.
A resumable pause freezes its useful work, not an earlier execution candidate.
Resuming from mode-off captures the current tree after cancellation.
ExitCode compares the candidate to that baseline before preparation, after preparation, before approval, before sealing, and when an agent run settles.
On any difference, it saves the changed and added files under `.exitcode/discarded/`, restores the baseline, and reports the change to the agent.
Evidence prepared from a changed candidate never reaches approval.
The latest three discarded change sets are kept.
This applies to every source, including your own edits during review.
To change the candidate before approval, use `/exitcode exit`, edit, then `/exitcode resume` and review a fresh preparation.
Sealing releases the baseline, and the agent then implements normally.

Built-in file tools cannot read or write `.exitcode/`.
Shell commands that mention it are blocked.
ExitCode cannot inspect arbitrary tools' arguments, so sealed bundles also carry content digests that block execution when changed.
ExitCode protects its candidate and supervisor state, not the world.
A tool can still send email, change a database, push a branch, call an API, or write outside the project.
Installed dependency content participates in candidate identity, snapshots, and pre-seal restoration.
Git metadata and supervisor directories are excluded.
These checks are not an operating-system boundary against compromised trusted host tools.

## Recipes and discovery

The bounded initial recipe set is:

| Kind | Parameters | Behavior |
| --- | --- | --- |
| `file_exists` | `path` | Require a regular file. |
| `file_contains` | `path`, `value` | Require a nonempty literal substring. |
| `file_not_contains` | `path`, `value` | Require a file without the literal substring. |
| `json_value` | `path`, `pointer`, `value` | Compare a JSON pointer value. |
| `existing_test` | `path`, `selector` | Run a discovered literal node:test name. |
| `test_suite` | none | Run the discovered npm test script. |
| `build_succeeds` | none | Run the discovered npm build script. |
| `typecheck_succeeds` | none | Run the discovered npm typecheck script. |
| `command_exit` | `command`, `args` | Run an executable basename and explicit arguments. |
| `custom_command` | `command` | Run a visibly identified shell escape hatch inside isolation. |

Checks use `check.recipe` or legacy `check.command`, never both.
`check.expect` can fix exit and stdout expectations.
`check.timeoutSeconds` is an immutable explicit watchdog and is never silently shortened in the contract.
Its actual execution allowance cannot exceed the remaining global deadline.
Without an explicit timeout, post-seal checks use the remaining execution budget.
Discovery reads package scripts, conventional source/test roots, and literal Node test names without executing repository code.
The capability manifest is content-keyed and cached.
Dynamic test names are not discovered.
Selectors must resolve to a discovered literal and execute at least one test.
The initial script recipes support npm only.
Missing file/JSON targets fail normally, including negative-content checks.
Malformed JSON fails normally.
Unsafe paths and malformed evaluator specs produce diagnostics.
No HTTP, JSON Schema, or non-Node runner integration is included.

```json
{
  "goal": "Finish the feature",
  "intentAtoms": [
    {"id": "I1", "outcome": "The requested result artifact contains done", "criteria": ["C1"]},
    {"id": "I2", "outcome": "Existing artifact remains", "criteria": ["C2"]}
  ],
  "criteria": [
    {
      "id": "C1",
      "requirement": "Feature artifact contains the result",
      "check": {"recipe": {"kind": "file_contains", "path": "result.txt", "value": "done"}},
      "controls": {
        "accept": {"mutations": [{"kind": "write_file", "path": "result.txt", "content": "done"}]},
        "reject": [{"mutations": [{"kind": "write_file", "path": "result.txt", "content": "pending"}]}]
      }
    },
    {
      "id": "C2", "type": "regression",
      "requirement": "Existing artifact remains present",
      "check": {"recipe": {"kind": "file_exists", "path": "result.txt"}}
    }
  ]
}
```

Fixture operations are `write_file`, `delete_file`, `replace_text`, `copy_fixture`, and `set_json_value`.
Each fixture allows at most 32 operations.
Writes are limited to 8 MiB per operation.
Paths must be relative and cannot cross symlinks or supervisor directories.
JSON pointer edits reject prototype-related keys.
`replace_text` must make a change.
`copy_fixture` copies another regular file within the candidate fixture.
Legacy `setup` shell commands remain available inside isolation.
A successful setup does not establish a valid evaluator.

## Evaluator preparation

E0 retains its mechanical checks and adds two semantic review phases and sham probes.

1. **Intent:** Audit declared coverage, unknown mappings, duplicate criteria, and material ambiguities.
2. **Lint:** Compile recipes and validate runners, selectors, confined paths, and external dependencies.
3. **Independent derivation:** Derive material request outcomes, expected observations, near-miss concepts, critical negatives, regression risks, and test reuse opportunities.
4. **Independent assessment:** Compare the proposed checks to that fixed derivation and materialize the near-misses against post-setup valid fixtures.
5. **Discrimination:** Require PASS on the valid fixture and FAIL on every authored invalid fixture, not ERROR.
6. **Sham challenge:** Require FAIL on one or two independently derived incomplete implementations per non-structural behavioral criterion.
7. **Adversarial:** Retain bounded recipe-target deletion and incorrect-content probes as secondary wiring evidence.
8. **Determinism and wiring:** Repeat independent valid fixtures and reject inconsistent outcomes or empty-target PASS.
9. **Baseline:** Record all current-candidate outcomes without completing the goal.

A sham can preserve exports while removing persistence, hardcode a result, or bypass a guard.
The near-miss concepts come from the request and criterion requirements before the reviewer sees authored checks or controls.
The second phase receives bounded repository context, checks, controls, and valid-fixture source content.
Each sham starts from an independent valid fixture and uses the existing confined mutation operations.
Shams cannot edit conventional test files or runner selection.
A surviving sham rejects the evaluator.
An unchanged fixture, failed setup, unsafe mutation, timeout, or runner ERROR is not successful challenge evidence.

A behavior must be observed through its state or effects, not merely file or symbol existence.
Literal artifact requirements such as including LICENSE can use structural evidence with an explicit justification.
Material negative cases and relevant regression mappings are required when the request or architecture implies them.
The reviewer checks semantic overlap and unnecessary test duplication.
It prefers existing relevant tests, then focused tests in the existing framework, then standard recipes, then custom commands.
Review findings produce repair diagnostics rather than silently rewriting criteria.
The internal coverage and risk evidence is available in status, not added as a routine user-facing matrix.

### Immutable evaluator assets

Preparation captures conventional tests, fixtures, runner configuration, and required case inventory.
The sealed bundle records their content identities and supervisor-owned copies.
Custom assertion helpers and imported expectation/configuration files outside those paths must appear in `check.assets`.
For example, `"assets": ["checks/accept.mjs", "checks/expected.json"]` freezes those helpers.
Product source remains mutable merely because a check imports or executes it.
Independent review must flag undeclared acceptance helpers.
Automatic discovery cannot infer arbitrary shell or import graphs.
Fixture setup cannot replace the authoritative acceptance bytes.
Each executable check gets frozen assets mounted read-only inside a disposable candidate copy.
Changed acceptance bytes or test-selection inventory pause execution rather than weaken the evaluator.
User resume can restore those exact supervisor-owned bytes and remove added acceptance files before reevaluating.
It never constructs replacement acceptance from the current candidate.

Use `specificationPaths` to include referenced Markdown plans in independent review.
Explicit paths may select hidden project plans such as `.agents/artifacts/plan.md`.
Credential exclusions and context bounds still apply.
Missing or unsafe declared specifications prevent approval.

Set `mutableDependencies: true` only when the approved goal needs product dependency changes.
This initial boundary supports npm-style `package.json` and regular installed `node_modules` trees.
Product dependency declarations and product-only library bytes become identified candidate inputs.
Development dependencies, installed executable packages, their transitive installed dependencies, and runner configuration remain frozen.
Added files or changed optional dependency resolution in that evaluator boundary invalidate evidence.
Other package-manager layouts may need intervention rather than a relaxed boundary.
This flag does not grant installation, network, credentials, or external authority.

### Model calls and bounds

New root and child preparation uses the currently selected Pi model and session thinking level through `ctx.modelRegistry.streamSimple()`.
It makes two separate semantic review phases per successful preparation.
Each call starts with a fresh context containing only the phase's review prompt, its input, and one `submit_review` tool carrying that phase's JSON schema with preferred strict sampling; the response is validated against the schema locally before acceptance.
Changing the session model or thinking level applies to subsequent review calls without separate reviewer configuration.
Initial model review has no ExitCode wall-clock ceiling.
Each response retains a 32768-token output limit and a 512 KiB response cap.
Assessment criteria are truncated past 64 KiB total, and a length-truncated phase with more than one behavior criterion is retried once per chunk before failing.
Tool updates report phase and elapsed progress.
Cancellation still aborts the call.
Child review after sealing shares the original execution deadline.
Provider errors, invalid JSON, malformed or missing review evidence, and cancellation prevent approval.
There is no host-execution or heuristic fallback.
Transient 408, 429, 5xx, and connection failures get at most two retries per review phase with bounded backoff.
Invalid requests, invalid responses, assertions, and semantic rejections are not retried until green.
Repeated infrastructure failures pause the same root for focused intervention.
Review source context is limited to 64 files, 12 KiB per file, and 96 KiB total per repository view.
Hidden paths are excluded unless they are explicitly selected Markdown specifications.
Credential-named files, detected credential content, binary files, and symlink targets remain excluded.
Large contracts exceeding the adapter input bound require a narrower evaluator.
Repository context can be incomplete; the reviewer must report insufficient evidence rather than assume success.
Model calls add cost and latency even when mechanical probe evidence is cached.
Nested model usage is reported in tool results and accumulated in preparation metrics.
Core integrations must supply an independent `io.review(input, {signal})` callback.
Tests and benchmarks use explicitly injected deterministic reviewers, not a production bypass.

Diagnostics contain `code`, `stage`, `criterionId`, `evidence`, `repairability`, and `recommendedRepair`.
Examples include INTENT_UNCOVERED, TEST_SELECTOR_NOT_FOUND, REJECT_NOT_DISCRIMINATED, EMPTY_TARGET_PASS, NONDETERMINISTIC, and EXTERNAL_DEPENDENCY.
Mechanical repair normalizes numeric timeouts and discovered runner selection.
Other repairs are agent-authored evaluator revisions inside a bounded construction budget.
The sealed execution start and implementation counters never reset.
An explicit user grant adds budget without changing the approved acceptance policy.
Intent and evaluator digests are separate.
Approval binds the exact validation evidence and candidate/environment identity as well as the semantic plan.

### Semantic limits

Independent review reduces correlated evaluator-author mistakes but is still model judgment.
The same selected model can repeat its earlier blind spots in a separate call.
Finite sham tests cannot prove semantic equivalence, exhaustive intent capture, or the absence of every defect.
Review and execution strengthen the evidence; they do not turn approval into a formal proof.

## Isolation and preservation

Every default executable probe uses a fail-closed bubblewrap runner.
This includes custom shell, legacy setup, preparation, completion, and parent reruns.
The runner exposes system runtime trees and an independent workspace, not host home, credentials, sockets, or the real candidate path.
It clears inherited environment variables and mounts private `/proc`, `/dev`, and `/tmp`.
It unshares network, process, IPC, user, and other namespaces, drops capabilities, and creates a new session.
Each stream is capped at 64 KiB.
Timeouts and cancellation kill the runner process group and its private namespace processes.
The supervisor waits for process close before deleting fixtures or releasing the workspace operation lock.
Injected executable runners must honor the signal and settle only after their processes stop.
Fixtures can be writable for setup and builds but never alias real candidate files.
Public sandbox commands use a read-only workspace by default.

Snapshots use independent reflinks where supported and ordinary copies otherwise.
No writable hard links are used.
The logical candidate cap remains 8 GiB and includes ignored build outputs and retained evidence.
Dependencies are independent copies for executable fixtures.
Candidate identities hash full content, file modes, and symlink targets instead of sampling large files.
Dependency identities participate in candidate and evaluator environment checks.
Approved product dependency changes do not relax the frozen evaluator runtime boundary.
Supervisor directories and Git metadata are not candidate content.
Commands cannot infer the candidate's Git ancestry from the isolated workspace.
Large fixtures and dependency copies can still consume substantial disk space.

The extension itself is trusted code running with host permissions.
Bubblewrap is a boundary for probes, not a claim against a compromised kernel or trusted extension.
This runner is not a general-purpose hostile-workload service or CPU/memory quota manager.
Agent tools are host tools in every phase. ExitCode verifies candidate and supervisor state, not what those tools can reach.

## Focused recursion and budgets

A child targets exactly one failed parent criterion.
One child runs at a time.
Passing a child reruns the parent; it never closes the parent by inference.
Conclusive ancestor regressions trigger restoration and fresh reevaluation.
Runner ERROR, timeout, and cancellation are inconclusive and preserve useful edits and the active stack.
A declined child must restore its exact verified pre-child checkpoint before ancestor reevaluation.
A missing or damaged checkpoint pauses without an arbitrary fallback.
Rejected implementation attempts still count.
Fresh completion and boundary parent reruns bypass all preparation caches.
Sealed contracts cannot be revised or weakened.
A changed sealed digest blocks execution.

| Root policy | Default |
| --- | --- |
| `localRepairs` | 2 changed-candidate attempts before ordinary decomposition |
| `maxDepth` | 3 levels below the root |
| `maxTotalAttempts` | 12 changed-candidate attempts across the tree |
| `deadlineMinutes` | 60 execution minutes from successful root seal |
| `evalTimeoutSeconds` | 900-second initial executable preparation watchdog |
| `evaluatorAttempts` | 6 substantive preparation proposals per node |

Initial operational-policy corrections are allowed before first approval.
Changing a draft or its policy invalidates affected preparation and approval.
Approval locks policy even if an unsealed contract is later revised.
Children inherit effective limits.
Initial discovery, clarification, model review, executable E0, and human approval spend no execution time.
Initial executables retain the preparation watchdog to stop hung processes.
After sealing, child preparation, evaluation, restoration, retries, and ancestor reruns share the root deadline.
A free unchanged-candidate rerun still needs time and fresh complete evidence.
Implementation reservations are persisted before executable or snapshot work.
Substantive construction reservations survive interrupted operations.
Confirmed infrastructure failures are recorded without charging a substantive evaluator proposal.

### Pause and resume

A pause preserves root identity, original request, phase, stack, approval, bundle, useful edits, diagnostics, and cumulative counters.
`/exitcode resume` retries the saved operation after its prerequisite is restored.
Only one supervisor operation owns a workspace at a time.
Reload or another session cannot clear a live operation's lock.
A transcript must explicitly adopt another active workspace root through the resume command.
No external worker, scheduler, installation, credential acquisition, or authority grant is automatic.

Execution exhaustion requires `/exitcode resume minutes=N` or `/exitcode resume attempts=N`.
Construction exhaustion reports EVALUATOR_UNBUILDABLE and requires `/exitcode resume evaluators=N` before further proposals.
Values are positive additions, not replacement limits.
Time additions extend the later of the previous deadline and the grant time.
Grants are user-command records separate from sealed policy.
They never reset consumed attempts, execution start, acceptance, or prior evidence.
Contradictory acceptance, missing authority, damaged trusted evidence, or unavailable isolation still require focused intervention.
Fixing an incorrect sealed evaluator requires a superseding contract and fresh user approval, not resume-time editing.

Legacy sealed roots retain exact contracts, policy, deadlines, and original attempt-accounting rules.
They do not acquire new seal-time evidence from current mutable files.
A legacy command evaluator without trustworthy frozen acceptance assets reports LEGACY_EVIDENCE_MISSING.
It requires a superseding approved contract.
Legacy self-contained built-in checks can still run fresh within their original limits.
Unsealed legacy roots with no implementation history can migrate on explicit resume.
Migration preserves timing history and counters, invalidates old approval, and requires fresh preparation and validated-plan approval.
Other legacy terminal execution is not automatically revived.

## Instrumentation and benchmark

Status exposes evaluator proposals, construction attempts, reviewer calls/completions/retries, probe/shell executions, fixture counts/bytes, elapsed preparation time, diagnostics, pauses, grants, review turns, cache hits, and peak concurrency.
Model usage is reported when the provider returns it.
Missing final usage is unavailable cost, not evidence of zero billing.
Other integrations report usage only when their host supplies it.
No token reduction claim is made.

Run the reproducible benchmark:

```bash
node scripts/benchmark-evaluator.mjs
./scripts/verify
```

The benchmark reports cold, warm, selective-repair, and fresh-evaluation counts and timings as JSON.
One content-keyed base snapshot supports independent derivatives.
At most four probes run concurrently.
Unchanged built-in recipe evidence is reused during preparation.
A changed criterion reruns its affected mechanical probes.
Independent review runs again and any changed sham materialization gets its own probe key.
Candidate or environment changes invalidate the base and evidence.
Reload discards in-memory preparation caches, not approved state or budgets.
Final evaluation always runs fresh.
Timing depends on the filesystem and hardware.
The benchmark demonstrates operation-count savings, not a universal latency percentage.

## Remaining limits

Long-running work still requires a live Pi session.
The adapter sends at most three continuation nudges without observable progress, then records an explicit resumable pause.
There is no external scheduler, parallel worker pool, exhaustive semantic test writer, or universal repair engine.
Useful criteria, ambiguity selection, and child decomposition remain model-dependent.
Keep the original objective above extension housekeeping and commit reminders.
