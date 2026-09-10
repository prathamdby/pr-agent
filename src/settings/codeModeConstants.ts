/** Interrupt-handler check budget per `execute` cell. Not an instruction count. */
export const CODE_MODE_INTERRUPT_CHECKS = 50_000;

/** Guest CPU wall-clock budget before the interrupt handler stops the cell. Host waits are excluded. */
export const CODE_MODE_CPU_BUDGET_MS = 80;

/** Workspace capability calls admitted per `execute` script. */
export const CODE_MODE_MAX_TOOL_CALLS = 25;

/** Simultaneous host capability calls inside one cell. */
export const CODE_MODE_HOST_IN_FLIGHT = 4;

/** Wall-clock budget for one `execute` cell, including host calls. */
export const CODE_MODE_TIMEOUT_MS = 15_000;

/** Max object depth before the marshalling boundary truncates. */
export const CODE_MODE_SERIALIZE_MAX_DEPTH = 8;

/** Max array elements retained by the marshalling boundary. */
export const CODE_MODE_SERIALIZE_MAX_ARRAY_LENGTH = 100;

/** Max UTF-8 bytes retained for one marshalled string. */
export const CODE_MODE_SERIALIZE_MAX_STRING_BYTES = 32 * 1024;

/** Max characters a guest `String.prototype.repeat` may allocate. */
export const CODE_MODE_MAX_STRING_REPEAT = 64 * 1024;

/** Max length a guest `Array(n)` or `Array.from` may allocate. */
export const CODE_MODE_MAX_ARRAY_ALLOCATION = 64 * 1024;

/** Max UTF-8 bytes of source admitted before evaluation. */
export const CODE_MODE_MAX_SOURCE_BYTES = 64 * 1024;

/** Max UTF-8 bytes of explicit `state` JSON. */
export const CODE_MODE_STATE_MAX_BYTES = 64 * 1024;

/** Max UTF-8 bytes transferred from one host capability call into the guest. */
export const CODE_MODE_HOST_TO_GUEST_MAX_BYTES = 256 * 1024;

/** Max UTF-8 bytes of model-visible `execute` output. */
export const CODE_MODE_MAX_OUTPUT_BYTES = 256 * 1024;

/** QuickJS heap ceiling for one execution context. */
export const CODE_MODE_GUEST_HEAP_BYTES = 8 * 1024 * 1024;

/** QuickJS stack ceiling in bytes. */
export const CODE_MODE_GUEST_STACK_BYTES = 512 * 1024;

/** `executePendingJobs` budget per pump. */
export const CODE_MODE_PENDING_JOBS_PER_PUMP = 64;

/** Reused worker-thread executors. */
export const CODE_MODE_EXECUTOR_POOL_SIZE = 2;

/** Waiting executions admitted onto the pool. */
export const CODE_MODE_EXECUTOR_QUEUE_LENGTH = 8;

/** Max wait for a free executor. */
export const CODE_MODE_EXECUTOR_QUEUE_WAIT_MS = 10_000;
