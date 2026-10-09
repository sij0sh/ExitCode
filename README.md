# ExitCode

ExitCode keeps long-running coding agents tied to a fixed definition of done.
It validates acceptance checks before asking you to approve the plan.
It then enforces that exact plan through fresh evaluation, bounded repair, isolated parallel workers, and focused recursion.

## Workflow

```text
Request -> Discovery -> EVALUATOR_PREPARATION -> READY_FOR_APPROVAL
        -> Approval -> Seal -> Execution -> fresh Evaluation
        -> Repair or child -> fresh root PASS
```

1. Inspect the request, implementation, tests, and likely regressions.
2. Submit the smallest observable contract: a goal, explicit outcomes, a few criteria with checks, and any assumptions or exclusions.
3. ExitCode validates the outcome mapping deterministically, proves each check discriminates inside candidate copies, and runs a best-effort semantic critic on the outcomes.
4. Repair typed evaluator failures before asking for approval.
5. Present the validated plan; ExitCode generates its verification summary from the evidence.
6. Approve the exact validated plan or request changes.
7. Implement and evaluate all sealed criteria fresh.

A pre-seal evaluator describes evidence; it must not encode a second implementation of the goal.

Mechanical evaluator failures do not request another approval.
A requested plan change requires preparation and review again.
Preparation never approves, seals, changes the real candidate, or consumes implementation attempts.
A passing baseline does not complete the goal.
Only fresh supervisor evaluation can close it.

The normal path needs one approval and no clarification turn.
Contract-specific acceptance tests and challenge fixtures belong in the draft's `assets` map.
ExitCode stores those files privately and validates them without changing the repository.
Durable product regression tests stay in the repository and may change after sealing.
Ask a question in conversation, before drafting, only when ambiguity materially changes success and no repository convention or default resolves it.
Clarification is not part of the contract schema.
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
Parallel execution also requires Git with `merge-tree --write-tree --merge-base` support. E0 checks this option form and verifies that the Pi worker backend can construct its runtime and use the selected model before the plan reaches approval; it creates no workers or Git candidates.

**Executable evaluation prefers Linux bubblewrap with usable unprivileged namespaces.**
Install bubblewrap with your system package manager for the full isolation boundary; ExitCode never installs it.
Without it, checks degrade to reduced isolation: sanitized host processes in disposable copies, with a preparation warning.
Set `EXITCODE_STRICT_ISOLATION=1` to fail closed instead; unavailable isolation is then a runner error, not evidence of a defect.
Built-in file and JSON recipes do not need bubblewrap.

```text
/exitcode Add password reset via emailed tokens
```

| Command | Purpose |
| --- | --- |
| `/exitcode approve` | Approve and seal the exact validated plan. |
| `/exitcode status [evidence]` | Show phase, criteria, budgets, diagnostics, and next action; `evidence` adds the full contract, E0 evidence, digests, and metrics. |
| `/exitcode <goal>` | Always start a fresh root. An unfinished root is detached with all its state, never deleted. |
| `/exitcode exit` | Stop and detach the current root without claiming success or deleting work. |
| `/exitcode resume [Gid]` | Continue a detached or paused root, switching workspace ownership if needed. Without an id: the owner, then this session's root, then the most recently detached one. |
| `/exitcode resume minutes=N attempts=N evaluators=N` | Record explicit positive execution or evaluator-construction grants and resume. |

Plain-English approval also works.
The agent quotes your acceptance when calling `exitcode_seal`.
The supervisor binds it to the prepared bundle and policy.
Roots approve an execution duration, not a countdown spent during review.
It does not authenticate the origin or semantic meaning of that quote.

The adapter exposes six tools only during ExitCode mode.
`exitcode_draft` automatically prepares root proposals and returns either typed repair diagnostics or a validated review.
Include `assets` and a `test_asset` recipe for new contract-specific tests.
Preparation infrastructure failures leave an unsealed root ACTIVE with a DRAFT and diagnostics, without spending evaluator-quality budget. The agent can revise, inspect evidence, or retry preparation.
`exitcode_seal` seals a reviewed bundle without rerunning preparation.
Stale candidate, environment, or evaluator evidence requires preparation and approval again.
`exitcode_evaluate` runs sealed checks fresh.
`exitcode_child` proposes one reduction of a failed parent criterion.
`exitcode_block` requests only what the user or the external world must supply: `REQUIREMENT_MISSING`, `CREDENTIAL_MISSING`, `AUTHORIZATION_MISSING`, or `EXTERNAL_BLOCKED`. Runner, Git, worker, configuration, and budget conditions are supervisor-owned; the agent cannot pause on them.
A draft whose diagnostics are all agent-repairable (lint, witness, or discrimination findings) cannot be blocked; the supervisor rejects the call and returns the existing next action.
Acceptance-asset edits use `exitcode_draft`; repository tests are mutable product content after sealing.
Only a genuinely declined child path uses `NO_PATH` to withdraw child edits and rerun its ancestors; a root cannot use it.
`exitcode_status` shows operational state; `detail: "evidence"` adds full mechanics for debugging.
Each agent turn receives only the five-sentence protocol and a status summary capped at 4 KiB.
That summary never includes checks, controls, evaluator evidence, or metrics.
Only root PASS automatically exits mode, and it is the only terminal root state.
PAUSED means only user or external intervention can continue; PAUSED roots keep enforcement on until the user resumes or exits.
BLOCKED applies only to a withdrawn child, which suppresses repeating the same child against unchanged evidence.

## Before sealing

ExitCode never changes your tool loadout or classifies tools by name.
Any built-in, custom, or extension tool stays available in every phase.
Instead, ExitCode enforces two state invariants:

- Before sealing, the entire product candidate, including repository tests, is immutable.
- `.exitcode/` is private to the supervisor in every phase.

Entering `/exitcode` or proposing a child snapshots the current candidate as the pre-seal baseline.
A resumable pause freezes its useful work, not an earlier execution candidate.
Resuming from mode-off captures the current tree after cancellation.
ExitCode compares the candidate to that baseline before preparation, after preparation, before approval, before sealing, and when an agent run settles.
On any difference, it saves the changed and added files under `.exitcode/discarded/`, restores the baseline, and reports the change to the agent.
Evidence prepared from a changed candidate never reaches approval.
The latest three discarded change sets are kept.
This applies to every source, including your own edits during review.
To change product files before approval, use `/exitcode exit`, edit, then `/exitcode resume`; the reattached root drops stale preparation and approval, and you review a fresh preparation.
To author or revise contract-specific tests before sealing, submit their bytes through `exitcode_draft.assets`; the supervisor writes them under `.exitcode/`, and the candidate remains unchanged. Asset revisions invalidate preparation and approval, requiring fresh validation.
Sealing releases the baseline, and the agent then implements normally.


## Recipes and discovery

### Parallel execution

A root contract can declare `execution` as a proof DAG. Every behavior criterion belongs to exactly one slice; `after` names prerequisite behavior criteria. Array order has no scheduling meaning. ExitCode rejects unknown references, duplicate ownership, self dependencies, and cycles before approval.

```json
{
  "execution": [
    { "id": "S1", "objective": "Implement token issuance", "verify": ["C1"], "after": [] },
    { "id": "S2", "objective": "Implement request UI", "verify": ["C2"], "after": [] },
    { "id": "S3", "objective": "Connect confirmation", "verify": ["C3"], "after": ["C1", "C2"] }
  ],
  "policy": { "maxParallelWorkers": 2 }
}
```

After sealing, `exitcode_evaluate` runs the graph autonomously. One supervisor launches independent Pi SDK sessions in private Git repositories with separate metadata and object files. The default concurrency limit is two; deadline and implementation attempts remain shared across all workers and reconciliation. Workers use the selected model and native coding tools, with no ExitCode tools or recursive children. Repository bytes provide context; workers do not load project extensions or execute project configuration as session resources.

At seal, Git plumbing captures the exact approved candidate, including uncommitted, untracked, and ignored files that participate in candidate identity. It neither requires a clean repository nor changes the user's Git index, branches, or commits. Worker history is internal state under `.exitcode/parallel/`. Private repositories isolate Git metadata; they do not sandbox trusted worker shell tools from the host.

The worker horizon contains its own criteria, all transitive prerequisites, and every regression criterion. A worker's fresh PASS records `WORKER_VERIFIED`. It becomes `INTEGRATED` only after Git reconciliation and fresh evaluation of the combined candidate. Only that integrated evidence unlocks dependent slices. Clean passing merges need no agent; textual conflicts and behavioral failures use an isolated reconciliation session with the exact candidate tips and evaluator feedback.

Root completion requires every slice integrated, no outstanding workers or reconciliation, a fresh full integration PASS, reconciliation with the latest canonical workspace, and a fresh full PASS there. Concurrent canonical edits enter a three-way merge; edits detected during publication record a retry fault on the ACTIVE root. Changed worker candidates and agent reconciliation consume shared attempts; unchanged reruns and mechanical integration do not. Recovery preserves candidate artifacts, charged attempts, and the original deadline while requiring fresh proof. `/exitcode exit` aborts and disposes worker sessions and preserves their saved work.

Contracts without `execution` retain serial repair and focused recursion. Legacy `sequence` retains its cumulative ordered proof behavior and cannot be combined with `execution`. Before approval, `WORKER_UNAVAILABLE` and `GIT_UNAVAILABLE` preparation diagnostics recommend revising to a serial draft without `execution` (optionally an ordered `sequence`), with no evaluator-quality charge; the draft stays editable and requires fresh preparation and user approval, never an automatic graph rewrite or a runtime switch of a sealed graph to serial execution.

`node scripts/smoke-workers.mjs /path/to/pi-coding-agent/dist/index.js` checks the installed SDK offline using a scripted local provider, native file writing, feedback, and cancellation.

### Check recipes

The bounded initial recipe set is:

| Kind | Parameters | Behavior |
| --- | --- | --- |
| `file_exists` | `path` | Require a regular file. |
| `file_contains` | `path`, `value` | Require a nonempty literal substring. |
| `file_not_contains` | `path`, `value` | Require a file without the literal substring. |
| `json_value` | `path`, `pointer`, `value` | Compare a JSON pointer value. |
| `existing_test` | `path`, `selector` | Run a discovered literal node:test name. |
| `test_asset` | `asset`, `command`, `args` | Run a supervisor-owned test with the project's runtime; append its disposable `.exitcode-evaluator/` path after the arguments. |
| `test_suite` | none | Run the discovered npm test script. |
| `build_succeeds` | none | Run the discovered npm build script. |
| `typecheck_succeeds` | none | Run the discovered npm typecheck script. |
| `command_exit` | `command`, `args` | Run an executable basename and explicit arguments. |
| `custom_command` | `command` | Run a visibly identified shell escape hatch inside isolation. |

Every check has exactly one representation, `check.recipe`; `custom_command` is the isolated shell escape hatch.
Regression criteria are optional; add focused checks for existing behavior the work could break.
`check.expect` can fix exit and stdout expectations.
`check.timeoutSeconds` is an immutable explicit watchdog and is never silently shortened in the contract.
Its actual execution allowance cannot exceed the remaining global deadline.
Without an explicit timeout, post-seal checks use the remaining execution budget.
Discovery reads package scripts, conventional source/test roots, and literal Node test names without executing repository code.
The capability manifest is content-keyed and cached.
Dynamic test names are not discovered.
Selectors must resolve to a discovered literal and execute at least one test.
Never invent a future test name for `existing_test`; controls cannot make an undiscovered selector pass lint.
Copy the exact name from the current test file or discovery manifest. For future behavior, supply a contract-owned `test_asset` instead of inventing a selector.
The initial script recipes support npm only.
Missing file/JSON targets fail normally, including negative-content checks.
Malformed JSON fails normally.
Unsafe paths and malformed evaluator specs produce diagnostics.
No HTTP, JSON Schema, or non-Node runner integration is included.

| Intent | Recipe |
| --- | --- |
| Run one test already discovered | `existing_test` with its exact `path` and literal `selector` |
| Observe new behavior before implementation | A baseline-failing contract-owned `test_asset`; focused `command_exit` or `custom_command` is also supported |
| Require literal artifact content | `file_contains`; source text alone does not prove runtime behavior |
| Preserve the discovered npm test suite | `test_suite` as a regression criterion; it runs `npm test`, not `scripts/verify` |
| Run this repository's baseline verification | `{"kind":"command_exit","command":"sh","args":["scripts/verify"]}` or `{"kind":"custom_command","command":"sh scripts/verify"}` |
| Run all verification and fault variants | `{"kind":"command_exit","command":"sh","args":["scripts/verify-full"]}` |

`command_exit.command` must be an executable basename: `./scripts/verify` is invalid.
Use `sh` with `scripts/verify` in `args`, or a `custom_command` shell string when shell syntax is needed. For custom commands, declare assertion runners and tests in `check.assets`; add `test_suite` when the conventional suite surface is part of the approved evaluator. Referenced scripts are not inferred from shell text.
Each behavior outcome needs exactly one focused criterion. Behavior criteria contain `outcome` and `check`; their display text comes from `outcome.requirement`. Only regressions have their own `requirement`. Split separate contracts such as response schema, model selection, and cancellation into focused outcomes; the semantic critic reports `BUNDLED_OUTCOME` for combined outcomes.

```json
{
  "goal": "Finish the feature",
  "outcomes": [{ "id": "O1", "requirement": "Feature artifact contains the result" }],
  "criteria": [
    {
      "outcome": "O1",
      "check": {"recipe": {"kind": "file_contains", "path": "result.txt", "value": "done"}}
    },
    {
      "type": "regression",
      "requirement": "Existing profile behavior still passes",
      "check": {"recipe": {"kind": "existing_test", "path": "profile.test.mjs", "selector": "profile artifact remains"}}
    }
  ]
}
```

### Positive witnesses and controls

Controls are optional.
Validate the test, not the solution. Define the smallest check that observes the requested outcome; prefer existing evidence.
For new behavior, a baseline-failing acceptance check is sufficient. Use a positive witness only when known-good state is cheaper to create than implementing the feature. Prefer fixture/input/dependency state over production-source changes, and leave exhaustive permutations to product regression tests.

| Check | Positive witness | Negative evidence |
| --- | --- | --- |
| Built-in file/JSON recipe | Generated by ExitCode | Generated deletion, wrong-content, and invalid-JSON probes |
| Check already passing on the candidate | The unmodified candidate | Author-supplied `controls.reject` |
| New behavioral check | Optional `controls.accept` | Baseline failure with sound wiring |

Supply `controls.reject` for behavior the baseline already satisfies; a baseline failure already counts as negative evidence.
A behavior criterion without baseline failure, built-in negative, or explicit reject reports NEGATIVE_EVIDENCE_MISSING.
A baseline-failing check with valid wiring may reach approval without positive evidence; the validated plan states that implementation will establish success post-seal.
An existing small source-mutating witness remains usable if otherwise valid.
EVALUATOR_OVERBUILT rejects a control over 64 KiB, touching more than 16 files, or repeating the same substantial body across criteria.
Prefer an existing test, narrow the criterion, or shrink the witness.

Fixture operations are `write_file`, `delete_file`, `replace_text`, `copy_fixture`, and `set_json_value`.
Each fixture allows at most 32 operations.
Writes are limited to 8 MiB per operation.
Paths must be relative and cannot cross symlinks or supervisor directories.
JSON pointer edits reject prototype-related keys.
`replace_text` must make a change.
`copy_fixture` copies another regular file within the candidate fixture.
Fixtures are only these confined mutations; there is no shell setup.

## Evaluator preparation

E0 is deterministic mechanical validation plus one best-effort semantic critic.

1. **Contract:** Every behavior outcome has exactly one criterion; every behavior criterion maps to exactly one declared outcome; regressions claim no outcomes.
2. **Compile:** Reject duplicate and overbuilt criteria, then validate recipes, runners, selectors, confined paths, frozen assets, and external dependencies.
3. **Baseline and wiring:** Run the real candidate and an empty project first. Baseline ERROR and empty-project PASS/ERROR block approval; regression baselines must PASS. A behavior baseline FAIL with sound wiring needs no positive witness.
4. **Challenge:** Authored and generated witnesses must PASS; explicit rejects and generated negatives must FAIL, never ERROR. Passing baselines serve as positive evidence and still require a negative challenge. Repeat positive evidence for determinism and check regressions against mutated positive witnesses. Skip positive and regression-on-witness probes when there is no positive evidence. Confirm candidate and environment integrity and package evidence without completing the goal.
5. **Critic:** A tiny semantic check compares the request with the declared outcomes only. Unavailable, malformed, or slow critics never block mechanical evidence.

An unchanged fixture, unappliable or unsafe mutation, timeout, or runner ERROR is not successful challenge evidence.
Existing means discovered now; tests for future behavior normally use `test_asset` and a focused witness.
Critic concerns are prominent plan warnings; they never veto mechanical validation or user approval.

### Immutable evaluator assets

Keep three kinds of evidence distinct: durable product regression tests remain in the repository; contract-specific acceptance tests belong in `draft.assets`; challenge helpers, fixtures, and expected-output files also belong in `draft.assets`.
Use the project's installed runtime and assertion libraries. ExitCode provides no separate package manager or test framework.

For example, add the following fields to a draft with the usual goal, outcomes, and criteria:

```json
{
  "assets": {
    "C1.test.mjs": "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; test('reports done', () => assert.equal(value, 'done'));"
  },
  "criteria": [{
    "id": "C1", "outcome": "O1",
    "check": {"recipe": {"kind": "test_asset", "asset": "C1.test.mjs", "command": "node", "args": ["--test"]}}
  }]
}
```

Asset names are canonical relative paths, with at most 16 files and 128 KiB of UTF-8 content per draft. Larger payloads return `EVALUATOR_ASSETS_OVERBUILT`; narrow the proof.
The supervisor stores the authoritative bytes under `.exitcode/assets/<node>.prepared/.exitcode-evaluator/`, then copies them into `<node>.sealed` at sealing.
Every probe installs those files at `.exitcode-evaluator/` inside its disposable candidate copy, read-only during execution.
Relative imports such as `../src/value.mjs` resolve against that copy; auxiliary fixtures can use `new URL('./fixtures/input.json', import.meta.url)`.
Controls can copy an authored fixture into the disposable product tree with `{"kind":"copy_fixture","asset":"fixtures/positive.json","path":"data/state.json"}`. The `asset` and candidate-relative `from` forms are mutually exclusive.
For other runners, specify their executable and options, for example `command: "python3", args: ["-m", "pytest"]` with an authored Python test asset.
Node `--test` recipes must execute at least one passing test; skipped-only runs do not pass.
Empty-project probes receive the authored evaluator and installed runtime without product source, so an always-passing asset is rejected.
The live candidate must not contain the reserved `.exitcode-evaluator/` mount.
Revisions retain assets when omitted; an explicit `assets` map replaces them in full. Children may author their own assets without changing an ancestor's sealed evaluator.
`/exitcode status evidence` shows each asset's supervisor source and execution command.
Promotion to a durable repository test is an explicit follow-up after the contract passes, separate from the success path.

Repository tests, fixtures, and test runners are mutable product files after sealing.
For `existing_test`, preparation seals a copy of the exact referenced test. For `test_suite`, it seals the approved conventional test, fixture, and runner configuration surface and constructs that exact suite in each disposable candidate, removing newly added conventional tests from that copy.
Custom assertion helpers and imported expectation/configuration files outside those paths must appear in `check.assets`.
For example, `"assets": ["checks/accept.mjs", "checks/expected.json"]` seals copies of those helpers.
Product source remains mutable merely because a check imports or executes it.
Automatic discovery cannot infer arbitrary shell or import graphs; declare unconventional suite helpers and runners explicitly.
Each executable check receives the sealed copies read-only after fixture setup.
Live repository test edits, additions, and deletions remain in the product candidate and never replace the evaluator copies.
Tampering with supervisor-owned sealed copies pauses evaluation. Live drift of pinned evaluator runtime files is re-overlaid from the sealed copies before every evaluation and reproved, preserving product tests.

Use `specificationPaths` to include small referenced Markdown plans as critic context.
Missing specifications are omitted; they never block mechanical validation.

Set `mutableDependencies: true` only when the approved goal needs product dependency changes.
This initial boundary supports npm-style `package.json` and regular installed `node_modules` trees.
Product dependency declarations and product-only library bytes become identified candidate inputs.
Development dependencies, installed executable packages, their transitive installed dependencies, and runner configuration remain frozen.
Added files or changed optional dependency resolution in that evaluator boundary invalidate evidence.
Other package-manager layouts may need intervention rather than a relaxed boundary.
This flag does not grant installation, network, credentials, or external authority.

### Model calls and bounds

New root and child preparation optionally uses the currently selected Pi model through `ctx.modelRegistry.streamSimple()` for one best-effort semantic critic call.
The call starts with a fresh context containing only the request, goal, outcomes, assumptions, exclusions, and small specification text, not the session history, and offers at most one `submit_review` response tool.
Changing the session model applies to subsequent critic calls.
The critic has a 12-second timeout, a 1024 output-token ceiling and an 8 KiB response bound, with at most three clipped concerns.
Tool updates report phase and elapsed progress.
Cancellation still aborts preparation.
Provider errors, invalid responses, malformed evidence, timeouts, and missing models mark the critic unavailable; deterministic E0 continues and the user can still approve.
Concerns and availability failures are warnings; cancellation still stops preparation. There are no critic retries.
Model calls add cost and latency even when mechanical probe evidence is cached.
Nested model usage is reported in tool results and accumulated in preparation metrics.
Core integrations may supply an `io.review(input, {signal})` callback; without one, the critic is unavailable.
Tests and benchmarks use explicitly injected deterministic reviewers, not a production bypass.

Diagnostics contain `code`, `stage`, `criterionId`, `evidence`, `repairability`, and `recommendedRepair`.
Examples include OUTCOME_UNCOVERED, EVALUATOR_OVERBUILT, EVALUATOR_ASSETS_OVERBUILT, NEGATIVE_EVIDENCE_MISSING, REGRESSION_ON_WITNESS, REJECT_NOT_DISCRIMINATED, EMPTY_TARGET_PASS, NONDETERMINISTIC, and EXTERNAL_DEPENDENCY.
Mechanical repair normalizes numeric timeouts.
Other repairs are agent-authored evaluator revisions inside a bounded construction budget.
The sealed execution start and implementation counters never reset.
An explicit user grant adds budget without changing the approved acceptance policy.
Intent and evaluator digests are separate.
Approval binds the exact validation evidence and candidate/environment identity as well as the semantic plan.

### Semantic limits

The semantic critic catches only obvious request-to-outcome mismatches and is still model judgment.
The same selected model can repeat its earlier blind spots in a separate call.
Finite negative probes cannot prove semantic equivalence, exhaustive intent capture, or the absence of every defect.
Mechanical validation and execution strengthen the evidence; they do not turn approval into a formal proof.

## Isolation and preservation

Every default executable probe uses a bubblewrap runner; without bubblewrap it degrades to reduced isolation unless strict isolation is set.
This includes custom shell, preparation, completion, and parent reruns.
The runner exposes system runtime trees and an independent workspace, not host home, credentials, sockets, or the real candidate path.
It clears inherited environment variables and mounts private `/proc`, `/dev`, and `/tmp`.
It unshares network, process, IPC, user, and other namespaces, drops capabilities, and creates a new session.
Each stream is capped at 64 KiB.
Timeouts and cancellation kill the runner process group and its private namespace processes.
The supervisor waits for process close before deleting fixtures or releasing the workspace operation lock.
Injected executable runners must honor the signal and settle only after their processes stop.
Fixtures can be writable for builds but never alias real candidate files.
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
Reduced isolation runs `/bin/sh` in the disposable copy with only `PATH`, a private `HOME`/`TMPDIR`, and `LANG`; candidate and evaluator identities are still verified around every evaluation, but there is no OS boundary.
This runner is not a general-purpose hostile-workload service or CPU/memory quota manager.
Agent tools are host tools in every phase. ExitCode verifies candidate and supervisor state, not what those tools can reach.

## Focused recursion and budgets

A child targets exactly one failed parent criterion.
One child runs at a time.
Passing a child reruns the parent; it never closes the parent by inference.
Conclusive ancestor regressions trigger restoration and fresh reevaluation.
Runner ERROR, timeout, and cancellation are inconclusive and preserve useful edits and the active stack.
A declined child must restore its exact verified pre-child checkpoint before ancestor reevaluation.
A missing or damaged checkpoint pauses without an arbitrary fallback; continuing could lose work.
Rejected implementation attempts still count.
Fresh completion and boundary parent reruns bypass all preparation caches.
Sealed contracts cannot be revised or weakened.
A changed sealed digest blocks execution.

| Root policy | Default |
| --- | --- |
| `localRepairs` | 2 changed-candidate attempts before ordinary decomposition |
| `maxDepth` | 3 levels below the root |
| `maxTotalAttempts` | 12 changed-candidate attempts across the tree (soft) |
| `deadlineMinutes` | 60 execution minutes from successful root seal (soft) |
| `evalTimeoutSeconds` | 900-second initial executable preparation watchdog |
| `evaluatorAttempts` | 6 substantive preparation proposals per node (soft) |

Defaults for attempts, time, and evaluator proposals are soft thresholds: crossing one adds a strategy check to the next action, and work continues.
A default stops work only at the safety ceiling of four times its threshold.
A value set explicitly in the draft policy is a hard limit, listed in the reviewed plan and bound by approval.
Initial operational-policy corrections are allowed before first approval.
Changing a draft or its policy invalidates affected preparation and approval.
Approval locks policy even if an unsealed contract is later revised.
Children inherit effective limits.
Initial discovery, model review, executable E0, and human approval spend no execution time.
Initial executables retain the preparation watchdog to stop hung processes.
After sealing, child preparation, evaluation, restoration, retries, and ancestor reruns share the root deadline.
A free unchanged-candidate rerun still needs time and fresh complete evidence.
Implementation reservations are persisted before executable or snapshot work.
Substantive construction reservations survive interrupted operations.
Confirmed infrastructure failures are recorded without charging a substantive evaluator proposal.

### Faults, pauses, and resume

Every failure has one disposition:

| Disposition | Examples | Root |
| --- | --- | --- |
| `retry` | runner, isolation, Git, worker, cancellation, candidate or environment changed mid-operation | stays ACTIVE; run the operation again |
| `repair` | no progress, evaluator drift the agent must fix | stays ACTIVE; the fault leads the next action |
| `intervention` | missing requirement, credential, authorization, or external action; hard budget; damaged supervisor evidence; failed restoration | PAUSED until `/exitcode resume` |

Evaluation automatically retries `RUNNER_ERROR`, `IO_ERROR`, `GIT_FAILED`, or `WORKER_FAILED` once under the same workspace lock and deadline, preserving attempt charges and reporting a retry warning; persistent faults and other codes keep their existing handling.
A recorded fault appears as `last issue` in status and the next action, and the next successful operation clears it.
That something failed is not by itself a reason to transfer control to the user.
A pause preserves root identity, original request, phase, stack, approval, bundle, useful edits, diagnostics, and cumulative counters.
Pauses record a recovery kind: `retry`, `repair`, `grant`, or `external`. `/exitcode resume` replays only explicitly retry-safe sealed operations, including evaluation after an explicit budget grant. An unsealed DRAFT returns control to the agent and never automatically replays preparation.
Draft revision and explicit preparation also recover legacy preparation pauses on an unsealed root. Recovery retains pause history, diagnostics, approval records, policy, grants, and cumulative budgets, and grants no product-write authority.
Only one supervisor operation owns a workspace at a time.
Reload or another session cannot clear a live operation's lock; a lock left by a dead or earlier process, or a malformed one, is removed automatically.
At most one root owns the workspace. `/exitcode <goal>`, `/exitcode exit`, and `/exitcode resume Gid` detach the current owner without deleting state; a stale transcript cannot act on a detached root.
A new goal's discovery receives a compact summary of the detached root, and the current workspace is authoritative.
A reattached root reconciles with the current workspace instead of rewinding it: unsealed roots drop stale preparation and approval; sealed roots evaluate the current tree fresh, and verdicts recorded for an older tree never trigger regression restoration.
Independent workers start only for approved execution graphs. Installation, credential acquisition, and authority grants remain external prerequisites.

Execution exhaustion requires `/exitcode resume minutes=N` or `/exitcode resume attempts=N`.
Construction exhaustion reports EVALUATOR_UNBUILDABLE and requires `/exitcode resume evaluators=N` before further E0 attempts. Revision remains available, and never reset consumed construction attempts.
Values are positive additions, not replacement limits.
Time additions extend the later of the previous deadline and the grant time.
Grants are user-command records separate from sealed policy.
They never reset consumed attempts, execution start, acceptance, or prior evidence.
Contradictory acceptance, missing authority, or damaged trusted evidence still require focused intervention.
Fixing an incorrect sealed evaluator requires a superseding contract and fresh user approval, not resume-time editing.

### Store generations

Supervisor state is pre-1.0 and not backward compatible.
`.exitcode/index.json` records one `formatVersion` for everything persisted under `.exitcode/` (currently generation 2).
A store from any other generation is never migrated or partially interpreted.
On first access, ExitCode moves it untouched to `.exitcode/archive/<timestamp>/` and starts fresh; the candidate is not modified.

## Instrumentation and benchmark

Status exposes evaluator proposals, construction attempts, critic calls/completions, probe/shell executions, fixture counts/bytes, elapsed preparation time, diagnostics, pauses, grants, review turns, cache hits, and peak concurrency.
Model usage is reported when the provider returns it.
Missing final usage is unavailable cost, not evidence of zero billing.
Other integrations report usage only when their host supplies it.
No token reduction claim is made.

Run the reproducible benchmark:

```bash
node scripts/benchmark-evaluator.mjs
./scripts/verify
```

The test suite is organized around the product invariants in [INVARIANTS.md](INVARIANTS.md).
`npm test` runs 45 baseline invariant tests, with representative nested scenarios.
`./scripts/verify` checks syntax and runs that baseline for normal development and E0.
`npm run test:full` runs every invariant and fault matrix; `./scripts/verify-full` adds syntax checks.
Use the full suite for CI, release checks, and changes to recovery or isolation boundaries.
Direct `node --test` invocations also run the full suite unless `EXITCODE_TEST_SUITE=baseline` is set.
Baseline tests are marked with `baseline()` in each test file; extended tests use `test()`.
`variants()` retains complete matrices in the full suite and chooses representative cases in the baseline.
State-transition tests use [prepared fixtures](test/prepared-fixture.mjs) to avoid repeating E0;
the lifecycle, evaluator quality, sandbox, and frozen-asset tests exercise real preparation.

The benchmark reports cold, warm, selective-repair, and fresh-evaluation counts and timings as JSON.
One content-keyed base snapshot supports independent derivatives.
At most four probes run concurrently.
Unchanged built-in recipe evidence is reused during preparation.
A changed criterion reruns its affected mechanical probes.
The critic runs again per preparation; mechanical probe evidence is keyed by criterion, control, and expectation.
Candidate or environment changes invalidate the base and evidence.
Reload discards in-memory preparation caches, not approved state or budgets.
Final evaluation always runs fresh.
Timing depends on the filesystem and hardware.
The benchmark demonstrates operation-count savings, not a universal latency percentage.

## Remaining limits

Long-running work still requires a live Pi session.
The adapter sends at most three continuation nudges without observable progress, then records a NO_PROGRESS fault and lets the turn end; the next user message continues the same ACTIVE root.
There is no external scheduler, parallel worker pool, exhaustive semantic test writer, or universal repair engine.
Useful criteria, ambiguity selection, and child decomposition remain model-dependent.
Keep the original objective above extension housekeeping and commit reminders.
