/** AST statements/expressions/loop iterations admitted per `execute` script. */
export const CODE_MODE_AST_FUEL = 50_000;

/** Workspace capability calls admitted per `execute` script. */
export const CODE_MODE_MAX_TOOL_CALLS = 25;

/** Wall-clock budget for in-flight async workspace ops inside one script. */
export const CODE_MODE_TIMEOUT_MS = 15_000;

/** Max object depth before the defensive serializer truncates. */
export const CODE_MODE_SERIALIZE_MAX_DEPTH = 8;

/** Max array elements retained by the defensive serializer. */
export const CODE_MODE_SERIALIZE_MAX_ARRAY_LENGTH = 100;

/** Max UTF-8 bytes retained for one serialized string. */
export const CODE_MODE_SERIALIZE_MAX_STRING_BYTES = 32 * 1024;

/** Max characters a host-native `String.prototype.repeat` or `+` concat may allocate. */
export const CODE_MODE_MAX_STRING_REPEAT = 64 * 1024;

/** Max length a host-native `Array(n)` or `Array.from` may allocate. */
export const CODE_MODE_MAX_ARRAY_ALLOCATION = 64 * 1024;

/** Max input length admitted to a regular expression execution. */
export const CODE_MODE_MAX_REGEX_INPUT_CHARS = 64 * 1024;
