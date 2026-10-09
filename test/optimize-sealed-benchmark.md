# Sealed execution benchmark

Measured on 2026-10-09 with Node v24.19.0. The baseline scheduler is commit
`ebd100947bba022312c5689d9294cb4675fde31a`, with diagnostic counters added without
changing scheduling or verification decisions. The updated scheduler uses the
same contract and fixture. Runs were sequential, after the verification suite
finished.

The fixture has two independent slices, C1 and C2, plus global regression R1.
Checks and workers are injected; candidate capture, materialization, merging,
publication, and canonical evaluation use the real supervisor. Preparation and
sealing are excluded from the measured evaluation interval. There are no
concurrent canonical edits or semantic repairs.

| Measurement | Baseline | Updated |
| --- | ---: | ---: |
| Worker starts / turns | 2 / 2 | 2 / 2 |
| Worker wall time, summed startup and turns | 6.99 ms | 5.33 ms |
| Evaluation runs, including final canonical proof | 8 | 5 |
| Evaluation wall time, summed | 4,958.14 ms | 3,173.48 ms |
| C1 executions | 7 | 4 |
| C2 executions | 5 | 3 |
| R1 executions | 8 | 3 |
| Proof reuse hits | 0 | 2 |
| Merges | 3 | 2 |
| Reconciliation turns | 0 | 0 |
| Total `exitcode_evaluate` wall time | 7,223.79 ms | 6,091.59 ms |

The updated trace is:

```text
worker S1:       C1
worker S2:       C2
integration S1:  C1 + R1
integration S2:  C1 + C2 + R1
publication:     canonical unchanged, mechanical apply
final canonical: C1 + C2 + R1
```

The two reuse hits cover unchanged integration readiness and the final full
integration scope. R1 executions fall by 62.5%, total criterion executions by
50%, evaluation wall time by about 36%, and total wall time by about 16% in this
single pair of runs. Injected workers and checks have negligible execution cost;
these timings measure orchestration overhead and are illustrative rather than
a model-startup or real repository-suite benchmark. Criterion counts are the
stable comparison.

Run the updated fixture with:

```sh
node scripts/benchmark-sealed.mjs
```

It prints counts and execution metrics as JSON and cleans up its temporary
workspace. Its root completion still performs one full fresh canonical proof.
