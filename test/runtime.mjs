/** Unit tests keep the host runtime fixed; candidate dependencies remain live. */
import { fingerprintRuntime } from '../exitcode-evaluator.mjs';

let runtime;
export function fixedTestRuntime(options) {
  return structuredClone(runtime ??= fingerprintRuntime(options));
}
