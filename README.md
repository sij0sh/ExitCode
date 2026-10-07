<div align="center">

# exitcode

**A lean, long-running harness loop that stays on goal.**

[Why ExitCode](#why-exitcode) &bull; [Focused recursion](#keep-the-goal-fixed-and-the-work-focused) &bull;
[Usage](#usage) &bull; [Guards](#what-keeps-the-loop-on-track) &bull; [Limits](#limits)

</div>

---

ExitCode is a long-running harness loop for coding agents, implemented today as a Pi extension.
It's intentionally lean adding only two anchors:
**immutable acceptance contracts keep the destination fixed; recursive inner loops keep the
next piece of work focused.**
The loop works toward the approved goal until its checks pass or it reports a concrete blocker.

## Why ExitCode

Keeping an agent running is only half the problem.
Over a long task, it can follow tangents, mistake activity for progress, or finish something
other than what you asked for.
More iterations do not help if the definition of done keeps moving.

A Ralph-style "keep trying" loop is an appealing starting point because it stays out of the
agent's way.
ExitCode aims for that same light touch, but adds enough structure to keep repeated work tied
to the original goal.
It does not prescribe a separate planner, worker team, model, or tool stack.
The aim is to work with the harness configuration you already use, not replace it with a fixed
planning and execution system.
The current integration supports Pi; this is not a claim of compatibility with every harness
or custom tool.

The added structure has three jobs:

- **Keep the destination fixed.** You review an acceptance contract before implementation.
  Once sealed, the agent cannot revise it to fit whatever it built.
- **Keep the work focused.** When local repairs stall, one smaller child tackles a failing
  parent requirement through the same loop.
- **Keep completion grounded.** The supervisor runs the contract's checks fresh.
  A completion message or a finished subtask is not enough.

**Lean about how the agent works. Strict about what counts as done.**

## Keep the goal fixed and the work focused

The outer loop holds the approved goal and its acceptance contract.
The inner loop works on the smallest useful next step without changing that destination.

1. Inspect the project and draft observable acceptance criteria with executable checks.
2. Review the root contract with the user.
3. Validate the evaluator and seal the contract before implementation starts.
4. Implement, evaluate, and repair within the run's budget.
5. If a smaller unit is needed, run the same protocol for one child tied to a failing criterion.
6. Rerun the parent after the child passes.

For password reset, the parent might require expired tokens to leave passwords unchanged.
A child can focus on storing and comparing token timestamps.
Passing that child's checks does not prove the end-to-end reset flow rejects expired tokens.
The parent evaluator still has to pass on the integrated code.

**A child PASS closes the child. Only a fresh parent PASS closes the parent.**

This is how recursion aims to help larger tasks: narrow the active problem without losing the
larger goal's requirements.
The agent can change its approach, but not the definition of success.
Ancestor checks and checkpoints protect previously accepted progress as the work moves forward.

Children need no separate user approval because they stay within the approved root contract.
Each child targets one currently failing parent criterion and validates its own evaluator.
Only one child is active at a time.
Depth, attempts, and time are shared across the tree rather than reset for each child.

## Usage

```bash
pi --extension ./exitcode.ts
```

Run this from the repository to load the extension for one Pi invocation.
To work in another checkout, start Pi there and pass the absolute path to `exitcode.ts`.
For persistent loading, run `pi install .` from this repository.
Requires a compatible [Pi installation](https://pi.dev).
Pi supplies `typebox` and `@earendil-works/pi-coding-agent`; no separate `npm install` is needed.

Inside Pi:

```text
/exitcode Add password reset via emailed tokens
```

The agent inspects the project and presents the original request, goal, requirements,
assumptions, exclusions, verification approach, effective policy, and remaining time.
Extension housekeeping and commit reminders do not replace your objective.
Accept in plain English, such as "looks good, go ahead", or use `/exitcode approve`.
You can also ask questions or request changes.
A reply requesting changes does not approve the draft.
Unclear replies require clarification, not inferred approval.

Acceptance starts evaluator validation and autonomous work.
If validation requires a revised root contract, you review it again.
The loop pauses while root review is pending.
Clarification pauses and reloads preserve discovery mode and the original goal.

| Command | Purpose |
| --- | --- |
| `/exitcode approve` | Optional shortcut to approve the exact root draft and start work. |
| `/exitcode status` | Show the contract, review, results, budgets, and next action. |
| `/exitcode exit` | User cancellation without completing the goal or deleting contracts. |
| `/exitcode resume` | Re-enter the on-disk run, including pending review. |

While active, ExitCode adds six `exitcode_*` tools and a protocol prompt section to Pi.
Only a fresh root PASS exits mode automatically.
BLOCKED stops autonomous work but keeps enforcement on until you cancel.
Outside mode, its tools are hidden and unreachable, it adds no protocol, and it blocks no calls.
Contracts and state live under `<project>/.exitcode/`.
Leaving or resuming mode does not reset the budget.
Legacy unsealed root drafts must be revised and approved before use.

## What keeps the loop on track

The contract is the anchor, but it must be worth trusting.
**Evaluator first means validating the definition of success before using it to judge code.**
Human review checks intent.
The fixed supervisor gate, E0, checks the evaluator.
The sealed task checks then judge the implementation.
These are different responsibilities, not an endless recursion of evaluators.

- **Review before implementation.** Approval binds to the exact root draft, including commands
  and expectations, plus the effective policy, creation time, and shared deadline.
  The approval digest is separate from the sealed evaluator-bundle digest.
  Root sealing rejects missing or mismatched approval before E0 runs.
  Every accepted root revision clears approval and requires a new review.
- **Show that checks can detect defects.** E0 requires each behavioral check to pass on a
  known-valid fixture and fail on every supplied known-invalid fixture.
  It runs the actual check, not a separate command that merely declares a fixture valid.
  A timeout or runner error does not count as detecting a defect.
- **Check wiring and baseline.** Every check must reject an empty target.
  E0 records the current candidate's results and rejects detected candidate mutation before
  sealing.
  Mutation rejection does not automatically restore the candidate.
- **Protect the sealed goal.** Before sealing, only `read`, `grep`, `ls`, and the six ExitCode
  tools are allowed.
  Other tools are suspended and denied, including shell, `find`, `context`, `codemode`, custom
  tools, and direct draft-file writes.
  Submit contracts through `exitcode_draft` or `exitcode_child`.
  Sealing restores the execution loadout, but guards still protect `.exitcode/` artifacts.
  A changed sealed bundle blocks the node instead of redefining success.
- **Verify progress and completion.** Evaluations run all criteria fresh.
  Candidate changes make a recorded PASS stale.
  Regressions trigger checkpoint restoration and reevaluation; the rejected attempt still counts.
  A passing child reruns its parent rather than closing it by inference.

Behavioral fixtures use `controls.accept.setup` and `controls.reject[].setup` to prepare
independent candidate copies before `check.command` runs.
Setup success is not the evaluator verdict.
Copies exclude `.git`, `node_modules`, `.exitcode`, and symlinks.
Fixtures and checkpoints share an 8 GiB logical-content cap.
ExitCode checks the total before copying and reports the byte and file counts if it is too large.
It does not honor `.gitignore`; build outputs and retained evidence remain included.
Copies use independent copy-on-write files when supported and ordinary copies otherwise.
Fixtures prefer the project filesystem but stay outside its Git ancestry.
A permissions boundary falls back to the system temporary directory.
Large ordinary copies and multiple checkpoints can still require substantial disk space.
Fixture setup runs after copying, so deleting files in setup cannot fix a cap rejection.
Provide required dependencies without writable links back to the real candidate.
Legacy control `command` fields must become `setup` fields in a revised draft.

### Bounded, not endless

| Root policy | Default |
| --- | --- |
| `localRepairs` | 2 changed-candidate attempts before a child is expected |
| `maxDepth` | 3 levels below the root |
| `maxTotalAttempts` | 12 changed-candidate attempts across the tree |
| `deadlineMinutes` | 60 minutes from root draft creation, including review time |
| `evalTimeoutSeconds` | 120 seconds per check unless the check overrides it |

Policy overrides can be proposed at root creation.
An initial root draft can correct its policy before first approval or evaluator work.
Omitted policy fields retain their effective values.
Every accepted root revision requires a complete fresh review.
The policy locks permanently at first approval, including during E0 recovery.
Children inherit that policy and cannot amend it.
Rejected policy revisions leave the existing draft, approval, and limits unchanged.

The shared deadline still starts at root creation and includes human review time.
A policy correction recomputes the deadline from that original timestamp.
Revisions, reloads, resume, and child work never reset elapsed time or counters.
An expired, never-approved draft can receive a larger policy only while still eligible.
ExitCode rejects an expired approval before recording approval or running E0.
Status reports the effective limits and an actionable correction or cancellation path.
Legacy roots without policy-lock history keep fixed policies.
Legacy unsealed drafts require a new full review and approval; sealed contracts remain usable.
Each node gets at most two E0 proposals before becoming BLOCKED.
Unchanged-candidate evaluations and boundary parent reruns do not consume implementation attempts.
Early decomposition requires a declared prerequisite with an observable artifact.
An identical blocked child cannot be retried on unchanged evidence.

## Limits

This is a lean v1 workflow supervisor, not a sandbox or a guarantee of autonomous success.

- **Long-running still depends on a live Pi session.** The adapter supplies at most three
  continuation nudges per idle stretch, not an external scheduler.
  Per-check timeouts are not hard deadlines for every activity or descendant process.
- **Tool guards are not operating-system isolation.** The pre-seal allowlist denies unknown
  agent tools, including nested calls.
  Post-seal shell checks remain best-effort.
  Guards do not constrain extension-internal execution or supervisor-run check commands.
  The extension and its commands run with your operating-system permissions.
- **Immutable contracts are not complete evaluator isolation.** Digest checks protect contract
  data, not every script or dependency the checks invoke.
  Fixture copies are not sandboxes; commands can access absolute paths and external services.
  Candidate digests exclude dependency and supervisor directories and symlinks and sample files
  larger than 8 MiB.
- **Approval still trusts the agent.** For plain-English acceptance, the agent quotes your reply
  when sealing.
  The supervisor validates the draft and effective limits, not the meaning or origin of the quote.
  This is not a user-only authorization boundary.
- **Focus still requires judgment.** The original request is retained and shown in review.
  ExitCode does not prove that a proposed goal is semantically equivalent to your request.
  Finite fixtures cannot prove the contract captures all of your intent.
  Useful child selection remains model-dependent.
  Recursion uses one session, not isolated child contexts or parallel workers.
  Scaling benefits are intended, not measured throughput or token savings.

---

<div align="center">

**Keep the destination fixed. Keep the next step focused.**

[Start a goal](#usage) &bull; [Understand the loop](#keep-the-goal-fixed-and-the-work-focused)

</div>
