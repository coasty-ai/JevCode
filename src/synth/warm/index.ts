/** The warm verification plane (docs/HARNESS-NEXT-DESIGN.md §3 M6, wave S1). */
export { interpreterFor, pytestRequestFor, quixbugsRequestFor, parseResponse, requestFor, WARM_OUTPUT_BYTES } from './protocol.js';
export type { WarmMode, WarmPytestRequest, WarmQuixbugsRequest, WarmResponse, WarmRunRequest, WarmRunResult } from './protocol.js';
export { WARM_READY_PREFIX, WARM_REQ_FIFO, WARM_RESP_FIFO, WARM_SERVER_PY } from './server-source.js';
export { emptyWarmStats, WARM_ENV_FLAG, WARM_MAX_FAILURES_PER_RUN, WARM_MAX_RESTARTS_PER_LANE, WARM_SUBDIR, WarmPlane, warmDelta, warmModeFor, warmNote } from './plane.js';
export type { WarmPlaneOptions, WarmScreen, WarmStats } from './plane.js';
export { WARM_BOOT_TIMEOUT_MS, WARM_FIFO_POLL_MS, WARM_IDLE_MS, WARM_MAX_LIFETIME_MS, WARM_RESPONSE_SLACK_MS, WARM_SERVER_FILENAME, WARM_WORKER_OUTPUT_BYTES, WarmError, WarmWorker, writeWarmServer } from './worker.js';
export type { WarmWorkerOptions } from './worker.js';
