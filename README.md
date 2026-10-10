<div align="center">

# ExitCode

**Let the agent change its plan. Not your definition of done.**

[Why ExitCode](#why-exitcode) &bull; [Get started](#get-started) &bull;
[Example](#example) &bull; [Configuration](#configuration)

</div>

---

A coding agent's "done" is a claim.
**ExitCode makes completion a checked result.**

ExitCode is a [Pi](https://pi.dev) extension for ambitious coding tasks.
You describe the problem and the experience you want.
The agent reproduces it, you approve what success looks like, and fresh scenario
observations decide whether the task is complete.

## Why ExitCode

A "keep going" prompt asks the agent to do the work and decide when to stop.
ExitCode separates implementation from certifying completion.

- **Reproduce before repair.** The agent builds or reuses the smallest project driver
  needed to observe the problem before changing product code.
- **Approve outcomes, not plans.** Every declared success condition must map to a
  concrete scenario you can review.
- **Keep Pi as Pi.** The agent keeps your project instructions, tools, context, and
  freedom to revise its approach.
- **Count every trial.** ExitCode runs the approved scenarios on fresh candidate copies.
  Every scheduled trial must pass; stale evidence cannot close the task.

Project drivers and prepared runtimes are reusable across tasks.
Each approval freezes that task's checks, captured driver, and runtime identity.
**The implementation can evolve. The acceptance conditions stay put.**

## Get started

```bash
pi install .
```

Run this from the ExitCode checkout.
Requires [Pi](https://pi.dev) with a configured model and Node.js 22.18 or newer.
Then start `pi` in the project you want to change:

```text
/exitcode Users cannot reset passwords. Add emailed, single-use links and revoke sessions.
```

The agent investigates and presents prepared acceptance conditions.
Review them and request changes if needed.
When they match what you want:

```text
/exitcode approve
```

Pi continues with implementation and submits the candidate for fresh acceptance.
The agent handles the contract and driver; you do not need to write them by hand.

## Example

For that password-reset request, an illustrative review might look like this:

| What must be true | Where it is observed |
| --- | --- |
| The user receives a usable reset link | Reset flow |
| The link changes the password exactly once | Reset flow, including attempted reuse |
| Existing sessions stop authenticating | Session revocation |

One scenario can cover several outcomes.
A fix that changes the password but leaves existing sessions alive still fails these checks.
The agent can try another approach, but it cannot drop the approved revocation requirement.

**Not "the patch looks right." The requested experience works under the approved scenarios.**

## What PASS means

PASS requires every scheduled trial to pass on the exact current candidate.
Changing the product after evaluation makes that evidence stale.
Changed sealed checks or a changed evaluator runtime invalidate acceptance.
Timeouts, missing measurements, and failed cleanup are errors, not successful completion.

Scenario quality still matters.
Coverage checks ensure every declared claim has a scenario, not that it measures the claim well.
Review the actual observations before approving.
Drivers run as trusted host processes or in explicitly selected offline Linux bubblewrap isolation.
Native Pi tools retain their normal permissions.

Product snapshots have no default byte limit.
Ignored files, including build artifacts, remain validation inputs.
Only Git metadata and the selected ExitCode store are excluded.
ExitCode hashes full content in fixed-size chunks.
Copies use independent copy-on-write files where supported, with ordinary copying as the fallback.
Large workspaces still require time and storage for disposable inputs.
Baseline mismatches report both digests and up to eight differing paths.

Setup and trials run in OS scratch outside the product and its Git ancestry.
ExitCode removes scratch after copying requested artifacts and process logs into durable evidence.
Put mutable build output under `runDirectory/work`, not inside `candidateDirectory`.
Keep other extensions' databases and logs outside the product workspace.
A disposable workspace is not an operating-system sandbox.

## Configuration

```json
{
  "storeDir": ".agents/.exitcode",
  "maxNudges": 2,
  "showStatus": true
}
```

These defaults need no setup.
Override them in `~/.pi/agent/exitcode.json` or a trusted project's `.pi/exitcode.json`.
Project values take precedence.
Run `/reload` after editing.

| Setting | Meaning |
| --- | --- |
| `storeDir` | Dedicated project-relative folder for validation definitions and evidence |
| `maxNudges` | Continuation nudges on unchanged progress; 0 disables them, maximum 10 |
| `showStatus` | Show the phase and result in Pi's terminal footer |

Share reusable definitions under `project/` if useful.
Keep private evidence under `state/` out of Git.

## Try the acceptance boundary

```bash
node examples/file-project/demo.mjs
```

```json
{
  "preparation": "READY",
  "before": "FAIL",
  "after": "PASS",
  "warmEnvironment": true
}
```

This local demo simulates approval and an ordinary product edit in a temporary workspace.
The task passes only after the edit, using the same prepared environment.
It needs no model and cleans up afterward.
See the [driver](./examples/file-project/driver.mjs) and
[complete contract](./examples/file-project/contract.json) for the runnable example.

## Development

```bash
npm test
npm run check
```

The tests exercise local drivers and Pi host/SDK fixtures.
Offline lifecycle regressions also use the installed Pi SDK, without model network calls.
Set `EXITCODE_PI_SDK` to its package directory if it is not installed locally or beside Node.
Those regressions report a skip when the peer dependency is unavailable.

For driver setup or failure recovery, read the short
[agent reference](./.agents/artifacts/exitcode-agent-recovery.md).
Project registration and setup failures return its installed absolute path.

## License

MIT, as declared in [package.json](./package.json).

---

<div align="center">

**Done should come with evidence.**

[Report an issue](https://github.com/sij0sh/ExitCode/issues) &bull; [Examples](./examples/)

</div>
