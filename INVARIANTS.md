# ExitCode invariants

Each rule lives in one authoritative place: the protocol explains the loop, tools explain how to act, the supervisor enforces invariants, and tests verify invariants.
A test belongs in the suite only if a failure would violate one of these rows, a security boundary, or a persisted compatibility contract.
Add variants as table rows inside the canonical test, not as new tests.

| Invariant | Why it exists | Canonical tests |
| --- | --- | --- |
| Pre-seal product is immutable; staged tests are user-authorized | Prevent implementation before approval; test updates need one user reply and re-validation | `core: baseline: pre-seal changes …`, `core: baseline: review-time changes …`, `core: baseline: changes that cannot be saved …`, `core: staging: user-authorized test windows …`, `adapter: settle restores pre-seal changes …`, `adapter: stage-tests opens a bounded test-only window …` |
| Supervisor state is private | Agents cannot forge contracts, approvals, or evidence | `core: guard: supervisor state is private …` |
| Evaluator is validated before approval | The user never approves an evaluator E0 has not passed | `core: prepare: failures spend only the evaluator budget …`, `adapter: a draft returns a compact validated plan only after E0 …` |
| Approval binds the exact validated bundle | Prevent post-review weakening of criteria, checks, policy, or clock | `core: approval: …` (four tests), `core: prepare: candidate, policy, or concurrent changes …` |
| Weak evaluators are rejected | Tests must observe outcomes, and independent shams must fail | `evaluator: semantic: weak, uncovered, unchallenged, or malformed …`, `evaluator: discrimination: …` |
| Evaluators are thin | A pre-seal evaluator describes evidence, not a second implementation | `evaluator: witnesses: built-in recipes need no controls …`, `evaluator: witnesses: controls that resemble a reference implementation …` |
| Evaluation is isolated and identity-bound | Probes cannot reach the host or certify a different candidate | `evaluator: isolation: …`, `evaluator: identity: …`, `core: snapshots: …`, `core: identity: …` |
| Sealed proof is immutable | Acceptance tests, helpers, and evaluator dependencies cannot drift after approval | `evaluator: assets: …` (three tests), `core: evaluate: an own-vector regression restores …` |
| Only fresh root PASS completes | Baselines, seals, child PASS, and stale PASS never close a goal | `core: lifecycle: an approved, validated draft seals exactly …`, `adapter: only a fresh root PASS exits mode …` |
| Recursion is focused | One child targets one failing parent criterion; parent proof stays authoritative | `core: child: …` (three tests), `core: policy: children inherit …` |
| Budgets are monotonic | Retries, children, and resumes never reset time or attempts; grants are explicit | `core: policy: …`, `core: evaluate: only changed trees spend attempts …`, `recovery: deadline crossings never yield PASS …` |
| Inconclusive is not FAIL or PASS | Infrastructure errors, cancellation, and deadline crossings pause without a verdict or quality charge | `core: verdict: …`, `recovery: infrastructure faults …`, `recovery: inconclusive evaluation …`, `recovery: cancellation …` |
| One owner per workspace | Concurrent sessions cannot interleave supervisor operations or adopt a root implicitly | `recovery: live operations and transcript root ownership …`, `adapter: reload, restart, and resume reconnect …` |
| Crash recovery fails closed | Interrupted preparation, verdict commits, and lost checkpoints never grant approval or PASS | `recovery: interrupted preparation …`, `recovery: reload recovers an interrupted provisional verdict …`, `recovery: an inconclusive ancestor or a missing pre-child checkpoint …`, `recovery: checkpoint metadata …` |
| Legacy state migrates or fails closed | Persisted roots and bundles from earlier versions keep their meaning | `recovery: legacy roots and bundles migrate safely or fail closed` |
| Agent context is bounded | Every turn gets the loop, not the evidence; reviews are compact judgments | `core: protocol: …`, `core: status: injected state is bounded …`, `adapter: each turn receives the short protocol …`, `evaluator: review: …` (three tests) |
| The user's environment is untouched | ExitCode never changes the tool loadout, and only the user cancels | `adapter: mode exposes ExitCode tools …`, `adapter: approval comes from a plain-English reply …`, `adapter: independent review uses the selected model …` |
