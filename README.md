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
3. Construct recipes and positive/negative fixture mutations.
4. Prepare the evaluator inside independent candidate copies.
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
READY_FOR_APPROVAL pauses automatic continuation and keeps coding tools locked.
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
| `/exitcode resume` | Resume on-disk work or a pending review. |

Plain-English approval also works.
The agent quotes your acceptance when calling `exitcode_seal`.
The supervisor binds it to the prepared bundle, policy, and original clock.
It does not authenticate the origin or semantic meaning of that quote.

The adapter exposes six tools only during ExitCode mode.
`exitcode_draft` automatically prepares root proposals and returns either typed repair diagnostics or a validated review.
`exitcode_seal` seals a reviewed bundle without rerunning preparation.
Stale candidate, environment, or evaluator evidence requires preparation and approval again.
`exitcode_evaluate` runs sealed checks fresh.
`exitcode_child` proposes one reduction of a failed parent criterion.
`exitcode_block` reports a concrete blocker.
`exitcode_status` exposes detailed mechanics.
Only root PASS automatically exits mode.
BLOCKED keeps enforcement on until user cancellation.

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
    {"id": "I1", "outcome": "Feature returns the result", "criteria": ["C1"]},
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

E0 records seven explicit stages:

1. **Intent:** Audit declared coverage, unknown mappings, duplicate criteria, and material ambiguities.
2. **Lint:** Compile recipes and validate runners, selectors, confined paths, and external dependencies.
3. **Discrimination:** Require PASS on the valid fixture and FAIL on every invalid fixture, not ERROR.
4. **Adversarial:** Add bounded target deletion and incorrect-content mutations where recipes permit them.
5. **Determinism:** Repeat independent valid fixtures and reject inconsistent outcomes.
6. **Wiring:** Reject checks that pass against an empty target.
7. **Baseline:** Record all current-candidate outcomes without completing the goal.

Diagnostics contain `code`, `stage`, `criterionId`, `evidence`, `repairability`, and `recommendedRepair`.
Examples include INTENT_UNCOVERED, TEST_SELECTOR_NOT_FOUND, REJECT_NOT_DISCRIMINATED, EMPTY_TARGET_PASS, NONDETERMINISTIC, and EXTERNAL_DEPENDENCY.
Mechanical repair normalizes numeric timeouts and discovered runner selection.
Other repairs are agent-authored evaluator revisions inside a bounded construction budget.
The original clock and implementation counters never reset.
Intent and evaluator digests are separate.
Approval binds the exact validation evidence and candidate/environment identity as well as the semantic plan.

### Semantic audit rubric

The agent must review each criterion against these questions before submission.

- Does every materially distinct requested outcome have a criterion mapping?
- Is the requirement observable from user-visible behavior or an actual artifact?
- Does it duplicate another criterion or merely restate the goal?
- Is it an implementation preference rather than a required outcome?
- Is an assumption being presented as a user requirement?
- Can fixtures detect plausible defects beyond the author's example?
- Does a repository convention resolve an ambiguity without asking the user?

Declared coverage is mechanically testable.
The choice and completeness of intent atoms remain judgment-dependent.
ExitCode does not prove semantic equivalence or exhaustive intent capture.
Finite adversarial mutations cannot prove the absence of every defect.

## Isolation and preservation

Every default executable probe uses a fail-closed bubblewrap runner.
This includes custom shell, legacy setup, preparation, completion, and parent reruns.
The runner exposes system runtime trees and an independent workspace, not host home, credentials, sockets, or the real candidate path.
It clears inherited environment variables and mounts private `/proc`, `/dev`, and `/tmp`.
It unshares network, process, IPC, user, and other namespaces, drops capabilities, and creates a new session.
Each stream is capped at 64 KiB.
Timeouts kill the runner process group and its private namespace processes.
Fixtures can be writable for setup and builds but never alias real candidate files.
Public sandbox commands use a read-only workspace by default.

Snapshots use independent reflinks where supported and ordinary copies otherwise.
No writable hard links are used.
The logical candidate cap remains 8 GiB and includes ignored build outputs and retained evidence.
Dependencies are independent copies for executable fixtures.
Candidate identities hash full content, file modes, and symlink targets instead of sampling large files.
Dependency identities participate in evaluator environment invalidation.
Supervisor directories and Git metadata are not candidate content.
Commands cannot infer the candidate's Git ancestry from the isolated workspace.
Large fixtures and dependency copies can still consume substantial disk space.

The extension itself is trusted code running with host permissions.
Bubblewrap is a boundary for probes, not a claim against a compromised kernel or trusted extension.
This runner is not a general-purpose hostile-workload service or CPU/memory quota manager.
Agent coding tools after sealing remain host tools guarded by the existing supervisor protocol.

## Focused recursion and budgets

A child targets exactly one failed parent criterion.
One child runs at a time.
Passing a child reruns the parent; it never closes the parent by inference.
Ancestor regressions trigger restoration and fresh reevaluation.
Rejected implementation attempts still count.
Fresh completion and boundary parent reruns bypass all preparation caches.
Sealed contracts cannot be revised or weakened.
A changed sealed digest blocks execution.

| Root policy | Default |
| --- | --- |
| `localRepairs` | 2 changed-candidate attempts before ordinary decomposition |
| `maxDepth` | 3 levels below the root |
| `maxTotalAttempts` | 12 changed-candidate attempts across the tree |
| `deadlineMinutes` | 60 minutes from root creation, including review |
| `evalTimeoutSeconds` | 120 seconds per executable check |
| `evaluatorAttempts` | 6 preparation attempts per node |

Initial policy corrections are allowed before preparation or approval.
Preparation locks policy permanently, even when it fails.
Children inherit effective limits.
Revisions, reloads, resume, and children never reset time or counters.
Construction failures use `evaluatorAttempts`, not implementation attempts or user reviews.
Budget exhaustion reports EVALUATOR_UNBUILDABLE.

Legacy sealed bundles retain their acceptance contracts and fresh recursive evaluation.
Unsealed legacy drafts cannot reuse old draft-only approval.
They must prepare safely and obtain fresh validated-plan approval.
Legacy shell drafts acquire an explicit criterion coverage map during migration.
That map does not substitute for the agent's semantic audit.
Interrupted preparation returns to a locked preparation phase on reload.

## Instrumentation and benchmark

Status exposes evaluator proposals, preparation attempts, probe/shell executions, fixture counts/bytes, elapsed preparation time, diagnostic categories, review turns, cache hits, and peak concurrency.
Token usage is explicitly unavailable unless the host supplies it.
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
A changed criterion reruns only its affected probes.
Candidate or environment changes invalidate the base and evidence.
Reload discards in-memory preparation caches, not approved state or budgets.
Final evaluation always runs fresh.
Timing depends on the filesystem and hardware.
The benchmark demonstrates operation-count savings, not a universal latency percentage.

## Remaining limits

Long-running work still requires a live Pi session.
The adapter sends at most three continuation nudges per idle stretch.
There is no external scheduler, parallel worker pool, automatic semantic test writer, or universal repair engine.
Useful criteria, ambiguity selection, and child decomposition remain model-dependent.
Keep the original objective above extension housekeeping and commit reminders.
