import { test as nodeTest } from 'node:test';

// Direct node --test runs retain full coverage; npm test selects the baseline.
export const fullSuite = process.env.EXITCODE_TEST_SUITE !== 'baseline';
export const baseline = nodeTest;
export const test = fullSuite ? nodeTest : () => {};
export const variants = (all, representative) => fullSuite ? all : representative;
