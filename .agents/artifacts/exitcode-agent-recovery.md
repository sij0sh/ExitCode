# ExitCode: driver setup and recovery

Read this reference before writing a driver or when an ExitCode setup failure points here.
This file does not install a skill or change global agent instructions.

Before approval, define observations; after approval, choose implementation.

## Start with the real boundary

Read the executable [driver](../../examples/file-project/driver.mjs) and [contract](../../examples/file-project/contract.json).
Reuse an existing project driver when it already observes the requested behavior.
Run build and test experiments on disposable product copies before approval.
Ignored build outputs participate in ExitCode's candidate identity.
A clean Git diff does not mean the candidate is unchanged.

Test one observation through the actual driver command before expanding the observer.
Keep every requested outcome in the final approval contract.

## Project files and paths

Use a simple file key such as `driver.py` in `exitcode_project.files`.
Use the matching command argument `driver.py`.
The stored file is `<storeDir>/project/files/driver.py`, not a product-root file.
The driver process starts in the supplied `projectDirectory`.
Keep generated files and bytecode caches outside the driver definitions.

Use the request's directories:

| Directory | Purpose |
| --- | --- |
| `projectDirectory` | Read-only driver definitions during execution. |
| `candidateDirectory` | Disposable product copy to build and observe. |
| `runtimeDirectory` | Prepared evaluator dependencies; unchanged during trials. |
| `runDirectory` | Writable trial work and retained artifacts. |

`prepare` creates reusable runtime dependencies.
`run` observes the candidate using `scenario.input`.
`dispose` performs bounded cleanup.

## Manifest environment and isolation

Start with `environment: []`.
The runner supplies its own `PATH`, `HOME`, and `TMPDIR`.
Do not put those names in the environment allowlist.
List only additional permitted variable names needed by the driver.

`workspace` is a trusted host process, not an OS sandbox.
`bubblewrap` requires working offline isolation and has no silent host fallback.
Verify required isolation with a representative small subprocess first.

## Driver responses and assertions

Write exactly one JSON response to stdout.
Send diagnostic logs to stderr.
Use `protocol: 1` and `status: "OK"`, `"UNAVAILABLE"`, or `"ERROR"`.
Do not add `ok` or return `ready`, `PASS`, or `FAIL` as the driver status.
`UNAVAILABLE` and `ERROR` require a nonempty `reason`.
A successful `run` requires an observations object.
An absent product can return `UNAVAILABLE`; a missing requested feature needs a concrete observed failure.
ExitCode compares observations with the contract and computes PASS or FAIL.

Example response:

```json
{"protocol":1,"status":"OK","observations":{"retrieval":{"found":false}}}
```

Example assertion:

```json
{"path":"/retrieval/found","op":"eq","value":true}
```

Paths are JSON pointers relative to the contents of `observations`.
Do not use dotted paths or prepend `/observations`.
Artifact filenames are relative to `runDirectory`.

Baseline `FAIL` reproduces a measured problem.
Baseline `PASS` protects working behavior.
A missing measurement or runner error is not a useful failing baseline.

## Recover from a failure

Inspect a returned evidence ID without rerunning acceptance:

```json
{"inspect":"run","runId":"<returned evidence ID>"}
```

Pass those arguments to `exitcode_evaluate`.
Follow its `nextOffset` with the same `runId` when evidence is paginated.
With no `runId`, inspection selects the latest retained evidence, including errors.
`NO_EVIDENCE` means no setup or run record exists yet.
Failures retain the stage, scenario/trial when applicable, and bounded process diagnostics.
Read supervisor evidence through ExitCode tools, not private state files.

| Failure | Next action |
| --- | --- |
| `INVALID_SPEC` environment | Remove the named forbidden variables; use runner defaults. |
| `INVALID_SPEC` assertion path | Use a JSON pointer rooted inside `observations`. |
| `INVALID_REPORT` | Check response status, unknown keys, exit status, and stdout format. |
| `INVALID_OBSERVATION` | Supply the required measurement or correct its path. |
| `TREE_TOO_LARGE` | Identify the affected tree; keep prepared runtime bytes within the evaluator budget. |
| `CANDIDATE_CHANGED` before preparation | Stop live workspace writes and ask the user for explicit `/exitcode resume`. |
| `CANDIDATE_CHANGED` during capture | Inspect the stage and differing paths; source/copy mismatch alone does not identify the cause. |
| Isolation or compiler error | Repair the execution environment without weakening acceptance. |

Product snapshots have no default byte cap; prepared evaluator trees currently have a 512 MiB cap.
`exitcode_project(refresh: true)` refreshes environment preparation, not the product baseline.
Do not edit private state, auto-resume, or auto-approve.
If capture diagnostics are missing, report that infrastructure gap instead of repeating a full contract blindly.
Stop at `READY` and wait for user approval.
Only fresh sealed acceptance PASS completes the task.
