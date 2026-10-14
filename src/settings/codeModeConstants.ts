export const CODE_MODE_INTERRUPT_CHECKS = 50_000;

export const CODE_MODE_CPU_BUDGET_MS = 80;

export const CODE_MODE_MAX_TOOL_CALLS = 25;

export const CODE_MODE_HOST_IN_FLIGHT = 4;

export const CODE_MODE_TIMEOUT_MS = 15_000;

export const CODE_MODE_SERIALIZE_MAX_DEPTH = 8;

export const CODE_MODE_SERIALIZE_MAX_ARRAY_LENGTH = 100;

export const CODE_MODE_SERIALIZE_MAX_STRING_BYTES = 32 * 1024;

export const CODE_MODE_MAX_STRING_REPEAT = 64 * 1024;

export const CODE_MODE_MAX_ARRAY_ALLOCATION = 64 * 1024;

export const CODE_MODE_MAX_SOURCE_BYTES = 64 * 1024;

export const CODE_MODE_STATE_MAX_BYTES = 64 * 1024;

export const CODE_MODE_HOST_TO_GUEST_MAX_BYTES = 256 * 1024;

export const CODE_MODE_MAX_OUTPUT_BYTES = 256 * 1024;

export const CODE_MODE_GUEST_HEAP_BYTES = 8 * 1024 * 1024;

export const CODE_MODE_GUEST_STACK_BYTES = 512 * 1024;

export const CODE_MODE_PENDING_JOBS_PER_PUMP = 64;

export const CODE_MODE_EXECUTOR_KINDS = ["in_process", "worker_threads"] as const;

export type CodeModeExecutorKind = (typeof CODE_MODE_EXECUTOR_KINDS)[number];

export const CODE_MODE_EXECUTOR_POOL_SIZE = 2;

export const CODE_MODE_EXECUTOR_QUEUE_LENGTH = 8;

export const CODE_MODE_EXECUTOR_QUEUE_WAIT_MS = 10_000;
