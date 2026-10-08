/** Cancellation, deadlines, and typed errors at supervisor boundaries. */
export function operationError(code, message, options) {
  return Object.assign(new Error(message, options), { code });
}

export function stopReason(signal) {
  return ['DEADLINE_EXCEEDED', 'CHECK_TIMEOUT', 'REVIEW_TIMEOUT'].includes(signal?.reason?.code)
    ? signal.reason : operationError('CANCELLED', 'operation cancelled');
}

export function ensureRunning(signal, deadlineAt, nowMs = Date.now) {
  if (signal?.aborted) throw stopReason(signal);
  if (Number.isFinite(deadlineAt) && nowMs() >= deadlineAt)
    throw operationError('DEADLINE_EXCEEDED', 'shared execution deadline exceeded');
}

/** Initial preparation has no execution deadline. Executable watchdogs are separate. */
export function operationSignal(signal, { deadlineAt, nowMs = Date.now, timeoutMs, timeoutCode = 'CHECK_TIMEOUT' } = {}) {
  if (timeoutMs != null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0))
    throw operationError('INVALID_SPEC', 'timeout must be finite and positive');
  const controller = new AbortController();
  const timers = new Set();
  const abort = () => controller.abort(stopReason(signal));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const schedule = (remaining, reason) => {
    if (controller.signal.aborted) return;
    if (remaining <= 0) { controller.abort(reason); return; }
    const started = performance.now();
    const tick = () => {
      const left = reason.code === 'DEADLINE_EXCEEDED'
        ? deadlineAt - nowMs() : remaining - (performance.now() - started);
      if (left <= 0) controller.abort(reason);
      else {
        const timer = setTimeout(() => { timers.delete(timer); tick(); }, Math.min(left, 2147483647));
        timers.add(timer);
      }
    };
    tick();
  };
  const remaining = Number.isFinite(deadlineAt) ? deadlineAt - nowMs() : null;
  if (remaining !== null) schedule(remaining, operationError('DEADLINE_EXCEEDED', 'shared execution deadline exceeded'));
  // The global clock owns a limiting deadline. A duplicated relative watchdog
  // can fire first because wall and monotonic clocks round differently.
  if (timeoutMs != null && (remaining === null || timeoutMs < remaining))
    schedule(timeoutMs, operationError(timeoutCode, timeoutCode === 'REVIEW_TIMEOUT' ? 'review watchdog elapsed' : 'check watchdog elapsed'));
  return {
    signal: controller.signal,
    dispose() { timers.forEach(clearTimeout); timers.clear(); signal?.removeEventListener('abort', abort); },
  };
}

/** Late results are not evidence. Injected host callbacks must also honor cancellation. */
export async function abortable(work, signal) {
  ensureRunning(signal);
  let abort;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => { ensureRunning(signal); return work(); }),
      new Promise((_, reject) => {
        abort = () => reject(stopReason(signal));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
    ensureRunning(signal);
    return result;
  } finally { if (abort) signal?.removeEventListener('abort', abort); }
}

/**
 * 400 is a request-capability mismatch (tool schema, constrained sampling,
 * reasoning option) that a host may degrade past; 401/403 are real provider
 * authority problems that only the user can fix.
 */
export function reviewFailure(error) {
  if (['CANCELLED', 'DEADLINE_EXCEEDED', 'REVIEW_TIMEOUT', 'REVIEW_RESPONSE_INVALID', 'REVIEW_TOO_LARGE', 'REVIEW_INCOMPATIBLE', 'REVIEW_CONFIGURATION', 'REVIEW_UNAVAILABLE', 'REVIEW_TRANSPORT'].includes(error?.code)) return error;
  if (error instanceof SyntaxError) return operationError('REVIEW_RESPONSE_INVALID', `invalid reviewer JSON: ${error.message}`);
  const message = error?.message ?? String(error);
  const status = Number(error?.status ?? error?.statusCode ?? message.match(/\b(400|401|403|408|429|5\d\d)\b/)?.[1]);
  if ([408, 429].includes(status) || status >= 500 && status < 600 || /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH)\b/.test(message))
    return Object.assign(operationError('REVIEW_TRANSPORT', message), { retryable: true });
  if (status === 400) return operationError('REVIEW_INCOMPATIBLE', message);
  if ([401, 403].includes(status)) return operationError('REVIEW_CONFIGURATION', message);
  return operationError('REVIEW_UNAVAILABLE', message);
}

export async function delay(ms, signal) {
  ensureRunning(signal);
  await new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(stopReason(signal)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
