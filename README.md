# exitcode

Contract-first recursive execution for Pi (lean v1).

Every goal starts with a sealed acceptance contract, gets bounded
implementation attempts, and can create one smaller child at a time. Only a
fresh supervisor evaluation can close a goal — the agent never declares
success itself.

This implements the blueprint in `.agents/artifacts/specs.md`, distilled from
`.agents/artifacts/concept.md`.

## Use

The root goal is user-invoked and requires explicit user approval.
Children use the same evaluation protocol without separate user approval.

```
/exitcode Add password reset via emailed tokens
```

Once in exitcode mode, Pi sees the six `exitcode_*` tools and a protocol
section in its system prompt. Outside exitcode mode the extension is inert:
its tools are registered `hidden` (unreachable, unlisted), it injects no
prompt, and it blocks no tool calls.

| Step | Who | What |
| --- | --- | --- |
| Discover | agent + user | inspect the project without implementation and resolve known product ambiguities |
| Draft | agent | `exitcode_draft` proposes goal + observable criteria with executable checks and valid/invalid fixture setups |
| Review | user | approve the root contract with `/exitcode approve`, request revisions naturally, or cancel with `/exitcode exit` |
| Seal | supervisor | `exitcode_seal` runs the fixed gate (structure, discrimination, wiring, baseline) and freezes the bundle |
| Implement | agent | source writes unlock; repair toward the sealed criteria |
| Evaluate | supervisor | `exitcode_evaluate` runs every check fresh; ALL PASS closes the goal |
| Decompose | agent + supervisor | `exitcode_child` proposes one narrower child tied to a failing criterion |
| Dead end | agent | `exitcode_block` reports the exact missing requirement |

Supporting commands:

```
/exitcode approve  approve the exact root draft, run E0, and start autonomous work
/exitcode status   show the active contract, result vectors, budgets, next step
/exitcode resume   re-enter mode for the on-disk root, including pending review
/exitcode exit     leave mode (contracts on disk are preserved)
```

Starting policy per root (overridable once at draft): 2 local repairs before
a child is expected, depth 3 below the root, 12 total attempts, 60-minute
shared deadline, 120s default per-check timeout. Two evaluator proposals per
node; then BLOCKED.

## Root approval

The agent first inspects the project without implementing changes.
It then presents the full acceptance specification in plain language.
The review includes the goal, every requirement, assumptions, exclusions, and verification approach.
Executable checks and fixture setups remain part of the same draft, but are not dumped into the review.
Use `/exitcode status` to see the review again.

Use `/exitcode approve` after reviewing the criteria.
Approval records the SHA-256 digest, timestamp, and user attribution on the root record.
The digest covers the exact draft, including verification commands and expectations.
Only the user command grants approval; there is no agent approval tool.
Root sealing rejects missing or mismatched approval before running E0 or consuming a seal proposal.
Any accepted root revision clears approval and presents the entire contract again.
Direct draft edits require a new `exitcode_draft` revision before approval.

Approval automatically runs E0, seals the contract, and continues autonomous work.
If E0 needs a revised root evaluator, the revised draft needs fresh approval.
Children require no approval and may only advance a failing approved parent criterion.
Children cannot weaken an ancestor contract.
The agent pauses without settle nudges while root approval is pending.
The existing shared deadline still starts at root draft creation.
An expired run remains paused for review, but approval then reports budget exhaustion.
`/exitcode exit` leaves mode without executing checks or deleting the draft.
`/exitcode resume` restores the pending review.
Existing sealed roots remain usable; legacy unsealed drafts must be revised and approved.

## Install

Local directory (this repo):

```bash
pi --extension /home/joshsimon/Projects/pi-extensions/ExitCode/exitcode.ts
```

Or symlink/copy the directory into your Pi extensions path. `typebox` and
`@earendil-works/pi-coding-agent` are host-provided; there is nothing to
`npm install`.

## How it maps to the specs

- `exitcode-core.mjs` — the supervisor: contract schema, E0 gate, fresh
  evaluation, budgets, one-child decomposition rules, file-tree checkpoints,
  atomic JSON records under `<project>/.exitcode/`. Pi-agnostic and tested.
- `exitcode.ts` — thin Pi adapter: `/exitcode` command, hidden-until-active
  tool registration, protocol prompt injection, `tool_call` guards (no source
  writes or shell before sealing; sealed artifacts read-only after), and a
  bounded `agent_before_settle` nudge so the loop keeps going until
  PASS/BLOCKED. Root PASS/BLOCKED auto-exits mode.
- `exitcode.test.mjs` — tests over the core: gate discrimination/wiring,
  attempt accounting, child boundaries (a passing child reruns but never
  closes its parent), regression restore, stale-PASS detection, seal tamper
  detection, budget/deadline enforcement, approval hashing, and guard invisibility.
- `exitcode-adapter.test.mjs` - adapter tests for review pauses, approval commands,
  automatic E0 and continuation, cancellation, and resume.

```bash
./scripts/verify   # syntax checks and the complete test suite
npm test           # node --test ./*.test.mjs
```

## E0 fixture controls

Each behavioral criterion supplies `controls.accept.setup` and at least one
`controls.reject[].setup`.
Each setup prepares a fresh temporary copy of the candidate and must exit 0.
The supervisor then runs the exact `check.command` with its sealed expectation.
The valid fixture must PASS.
Every invalid fixture must FAIL; a timeout or runner error does not count.
The control's exit code is never the evaluator verdict.

```json
{
  "check": { "command": "sh tests/check-reset-token-expiry.sh" },
  "controls": {
    "accept": { "setup": "sh fixtures/make-valid.sh" },
    "reject": [{
      "setup": "sh fixtures/remove-token-expiry-check.sh",
      "reason": "expired reset tokens are incorrectly accepted"
    }]
  }
}
```

Setups and checks run with the fixture as their working directory.
Copies use the existing checkpoint rules and 64 MiB content cap.
They exclude `.git`, `node_modules`, `.exitcode`, and symlinks.
Provide any required dependencies inside each fixture without linking writable
files back to the real candidate.
Fixtures are removed after each probe, including failures.

The same checks must also reject an empty target.
The real candidate digest must stay unchanged during control testing, wiring,
and baseline evaluation before the supervisor seals the contract.
A detected change rejects E0; it does not automatically restore the candidate.
New drafts must replace legacy control `command` fields with `setup` fields.

## Trust limits (read before relying on it)

An extension runs inside the Pi process with your OS permissions, so it is
not a sandbox boundary:

- There is no private checkout or container here. "Sealed" artifacts are
  protected by tool-call guards plus digest tamper detection (a modified
  bundle BLOCKs the node instead of being trusted), not by filesystem
  permissions. A hardened run should execute checks across a real
  process/sandbox boundary with a locked environment.
- Pre-seal, `write`/`edit` outside the draft area and all shell use are
  denied for agent tool calls. E0 also checks that supervisor-run commands
  leave the candidate digest unchanged before sealing. Post-seal,
  shell commands mentioning `.exitcode/` are denied on a best-effort basis;
  a determined bypass would still trip the digest check at the next
  evaluation.
- Checks are shell commands proposed by the agent and frozen at seal. The
  gate requires the same behavioral check to PASS on a known-valid candidate
  fixture, FAIL on each known-invalid fixture, and reject an empty target.
  Temporary copies are not sandboxes; commands can still access absolute paths
  and external services. Digest checks use the existing tree identity rules,
  which ignore dependency and supervisor directories and sample large files.
  Finite probes cannot prove a contract captures intent. Ambiguous requirements
  still need clarification before sealing.
- The loop continues the agent at settle time (max 3 nudges per idle
  stretch); it does not drive Pi from an outer process, so very long runs
  still depend on the session staying alive.
