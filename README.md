# ExitCode scenario implementation

ExitCode holds an agent to a fixed, observable definition of done. The user describes a problem and the desired happy path. Before approval, the agent establishes a reusable way to exercise the project and prepares scenarios that reproduce the problem. After approval, the normal Pi session chooses and changes its implementation approach. Fresh scenario observations determine completion.

This is a replacement for the supplied contract and proof-DAG implementation. It has one state format and one driver protocol. It does not read, migrate, or execute older contracts. Read [IMPLEMENTATION.md](IMPLEMENTATION.md) for the exact removal scope.

## Start and approve a task

Load the replacement entry point with your existing Pi installation:

```sh
pi --extension /absolute/path/to/exitcode/exitcode.ts
```

For persistent loading, run `pi install .` from this directory. Remove the previous ExitCode extension registration before loading this implementation; run one ExitCode implementation in a session.

Node 22.18 or newer is required. Pi supplies its extension API and TypeBox. There are no added production dependencies. The adapter uses the current Pi APIs represented by the attached source and documented at [Pi SDK](https://pi.dev/docs/latest/sdk) and [Pi extensions](https://pi.dev/docs/latest/extensions).

| Command | Behavior |
| --- | --- |
| `/exitcode <problem>` | Start a fresh task and detach an unfinished owner without deleting work |
| `/exitcode approve` | Approve the exact prepared acceptance and seal it |
| `/exitcode status` | Show the current phase, latest result, issue, and working hypothesis |
| `/exitcode status evidence` | Show the stored contract, preparation, and latest run |
| `/exitcode resume [taskId]` | Adopt an unfinished task against the current workspace |
| `/exitcode exit` | Cancel validation, detach the task, and preserve work without claiming completion |

Approval is a user command. There is no model-callable sealing tool and no interpretation of quoted plain-English approval.

The lifecycle is `DISCOVERY -> READY -> SEALED -> PASS`. A failed acceptance or infrastructure error leaves the task sealed and unfinished. A detached task retains its phase. Resuming an unsealed task adopts the current candidate and drops preparation; resuming a sealed task preserves its exact acceptance and starts from current product files. There is no automatic rewind.

## Reusable project definitions

On initial use, the agent inspects project instructions, entry points, dependencies, and existing tests. It creates the smallest useful execution boundary for the reported issue. It can wrap a library, command, API, browser, installation, container, or isolated remote service. It can use an SDK agent for scenario actions. ExitCode does not prescribe a testing framework or package manager.

The agent submits a manifest and UTF-8 driver files through `exitcode_project`. The same files remain readable and editable before sealing under `.exitcode/project/`. Future tasks reuse them when sufficient. More coverage can be added as actual problems require it; bootstrap is not an exhaustive model of the codebase.

| Location | Purpose |
| --- | --- |
| `.exitcode/project/manifest.json` | Versioned driver command, watchdog, explicit environment-variable names, and isolation choice |
| `.exitcode/project/files/` | Versioned setup scripts, drivers, fixtures, lockfiles, and project notes |
| `.exitcode/state/environments/` | Prepared environment instances identified by content |
| `.exitcode/state/tasks/` | Private task state, sealed bundles, evidence, and work journals |

Commit the project definitions if they should be shared. Ignore `.exitcode/state/`. If a project still ignores the whole `.exitcode/` directory, replace that broad rule with the state-directory rule before committing its definitions.

Preparation creates an environment once per project definition and reuses it across tasks. Its files and runner identity are checked. `exitcode_project` with `refresh: true` rebuilds the latest environment pointer while retaining earlier immutable instances required by sealed tasks. An existing seal continues to use its original driver and environment even when live project definitions change.

Validation dependencies belong in `runtimeDirectory`. Mutable product dependencies belong in the independent candidate. Provisioning should use pinned versions and lockfiles, install into the provided directory, and avoid host-file aliases. The fingerprint covers the prepared directory, selected runner executable, and platform identity. It does not automatically discover every system library or remote dependency; make material inputs part of the provisioned environment or scenario and describe remaining external conditions.

## Driver protocol

A manifest has this shape:

```json
{
  "protocol": 1,
  "name": "Project validation",
  "command": { "program": "node", "args": ["driver.mjs"] },
  "timeoutSeconds": 300,
  "environment": [],
  "isolation": "workspace"
}
```

ExitCode launches the command without implicit shell interpretation. Its working directory contains the captured driver files. Standard input is one JSON request. Standard output must contain one JSON response, without prose or Markdown; diagnostic text belongs on stderr.

Every request supplies `protocol: 1`, `operation`, `projectDirectory`, `runtimeDirectory`, `candidateDirectory`, and `runDirectory`. A run additionally supplies `scenario: {id, instructions, input}` and a trial number.

| Operation | Driver responsibility |
| --- | --- |
| `prepare` | Provision a reusable, pinned runtime; leave product source unchanged |
| `run` | Reset scenario state, exercise this candidate, and collect observations |
| `dispose` | Release trial or setup resources while retaining installed runtime files |

Each operation runs in a new process. Carry required handles through the supplied directories, not module globals. Each trial receives an independent candidate copy. Put scenario state and writable caches in its candidate or run directory; the prepared runtime is frozen during trials. Dispose runs after successful and failed setup or trials, with an independent watchdog of at most ten seconds. Drivers managing external resources must make disposal idempotent and be able to identify those resources from the supplied directories.

Successful setup and disposal return:

```json
{ "protocol": 1, "status": "OK" }
```

Successful observation returns:

```json
{
  "protocol": 1,
  "status": "OK",
  "observations": { "completed": true, "elapsedMs": 900000 },
  "artifacts": ["artifacts/events.json"]
}
```

`UNAVAILABLE` with a reason means the target software is absent. This is accepted only for the empty-target wiring probe. An unavailable real baseline is an error. A missing feature or artifact within an available product is a valid observation, such as `exists: false`, rather than target unavailability. `ERROR` with a reason reports failed setup, invalid conditions, or another inconclusive run; it is never successful reproduction evidence.

Artifact paths must identify regular files confined to the run directory. ExitCode copies and hashes them into retained evidence. Candidate, project, and temporary home copies are removed after the trial. stdout and stderr are retained for diagnosis; drivers should avoid printing credentials.

`$run` is reserved for externally collected elapsed time and timestamps. A driver cannot supply or overwrite it. For a scenario driven by an agent, schema validation confirms the response shape, and assertions compare the observations mechanically. It does not make an agent's choices or semantic interpretations deterministic. Prefer timestamps, actual responses, artifacts, and independent checks over an agent's declaration that it succeeded.

## Isolation choices

Choose the execution boundary explicitly in the manifest. ExitCode never silently changes it.

`workspace` uses a trusted host process in disposable copies, with a private home and a sanitized environment. Only named environment variables are passed. It can access the network and wrap project-managed containers or other environments. It is suitable for trusted infrastructure and the live SDK example; it is not an adversarial operating-system sandbox. Native implementation tools also retain their normal host permissions.

`bubblewrap` is an offline Linux sandbox. It mounts driver files and the prepared runtime read-only during a trial, exposes the disposable candidate and run directory, and excludes the canonical workspace, supervisor state, host home, and sockets. Missing bubblewrap or unusable namespaces produce `ISOLATION_UNAVAILABLE`; there is no host fallback. System runtimes are read-only. Projects needing networked provisioning or a live model can explicitly use a project-managed boundary through workspace mode.

## Scenarios and observations

`exitcode_contract` accepts `version: 1`, `problem`, `happyPath`, `constraints`, and `scenarios`. It does not accept an implementation plan, worker graph, validation sequence, controls, or source patches.

Each scenario declares its initial-state input, action instructions, expected baseline, number of trials, watchdog, and assertions. `baseline: "FAIL"` reproduces a defect or missing behavior. `baseline: "PASS"` protects existing behavior. All scheduled trials must match that baseline during preparation. Each scenario also receives an empty target; a passing empty target rejects the observer. Neither preparation PASS nor a passing baseline completes the task.

Assertions use JSON pointers into observations:

| Operator | Passing condition |
| --- | --- |
| `eq` | JSON values are equal |
| `lte` | A finite number is at most the threshold |
| `gte` | A finite number is at least the threshold |
| `contains` | A string contains the specified nonempty text |
| `present` | The specified field exists |

Missing required measurements, invalid numeric measurements, malformed reports, driver watchdogs, failed cleanup, and environment drift are ERROR. A valid measurement outside its accepted range is FAIL. A driver measuring a task deadline should stop that inner task and report its incomplete state; an outer watchdog only proves that the driver did not finish valid observation.

After sealing, every scheduled trial must pass. Trials are retained rather than retried until a favorable sample appears. There is no proof reuse or automatic retry. For live systems, start with a clearly scoped trial and increase repetitions or representative fixtures when the requested claim requires them.

The contract is limited to 64 KiB, project definitions to 64 UTF-8 files and 2 MiB, candidate/environment inventories to 512 MiB, command output to 1 MiB, and copied artifacts to 16 MiB per trial. Use focused workspaces and reusable fixture definitions when a bound is reached.

## Ordinary implementation and long-session state

After approval, the agent follows native project instructions, chooses a plan, edits normally, and uses focused checks. The extension preserves the existing tool loadout and prompt sections. It does not create worker sessions, override project context loading, schedule a DAG, force decomposition, or own compaction. Pi owns conversation persistence and compaction; its harness or available tools own any delegation.

The four model-facing tools are:

| Tool | Purpose |
| --- | --- |
| `exitcode_project` | Publish or refresh reusable validation definitions before sealing |
| `exitcode_contract` | Prepare problem and happy-path acceptance before sealing |
| `exitcode_evaluate` | Run fresh acceptance, or explicitly inspect the contract, historical run, or notes |
| `exitcode_note` | Record a short hypothesis, attempted change, result, disposition, next experiment, and evidence IDs |

An inspection does not execute validation or certify completion. `inspect: "contract"`, `inspect: "run"`, and `inspect: "notes"` are read-only views; a `runId` selects older evidence and an `offset` continues a long result. This lets the agent recover exact acceptance and earlier experiments after compaction without another state-management tool.

Notes reference real evidence but retain agent interpretations separately. A `revert` disposition records a decision and never rolls files back. `waitingFor` records needed user or external input and ends automatic continuation. The next user input releases that wait. Only the latest working hypothesis and next experiment appear in the small per-turn summary. Two unchanged continuation nudges are allowed; native session control then takes over without a forced strategy loop.

Before approval, direct product writes through standard edit tools are blocked. Other or external mutations are detected at supervisor boundaries and invalidate preparation. Files are preserved; explicit resume adopts the changed candidate. These guards supplement the normal trusted-agent workflow rather than provide an adversarial capability boundary.

## Examples and verification

Run the complete deterministic example:

```sh
node examples/file-project/demo.mjs
```

It demonstrates prepared baseline failure, approval, fresh implementation failure, a normal product edit, and fresh PASS using the same warm environment. It uses a temporary workspace and cleans it up.

`examples/pi-extension/` supplies a live Pi scenario driver. It copies a self-contained npm SDK installation with a matching pinned lockfile into the frozen runtime, selects a fixed model from scenario input, loads the candidate extension into a separate fixture session, preserves `AGENTS.md`, supplies one immediate simulated approval, and independently reads expected output files. Its clock covers the task through verified completion, including discovery and acceptance preparation. This example targets this replacement's single state format.

Before using that live example, provide `EXITCODE_PI_INSTALLATION`, the declared provider credential, and concrete `input.model.provider` and `input.model.id` values. The installation must contain its package-lock and installed SDK dependencies, with no credentials or unrelated project files. Set the baseline to the behavior actually reproduced; if the replacement already satisfies the time limit, a baseline FAIL is correctly rejected. The twenty-minute example can itself require twenty minutes to reproduce a timeout and is not the default bootstrap for ordinary tasks.

```sh
npm test
npm run check
```

The tests execute real local drivers and the Pi adapter against a host fixture. The SDK observer test uses an explicitly labeled SDK fixture, not a live provider. Live Pi/provider behavior and the twenty-minute latency target require a separately configured integration run. A successful local test suite is not evidence of that latency claim.
