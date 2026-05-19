import { Context } from "effect";
import type { RequestLogger } from "../evlog.js";

/** Explicit wide-event logger for one webhook HTTP intake (not AsyncLocalStorage). */
export class IntakeLogger extends Context.Tag("IntakeLogger")<
	IntakeLogger,
	RequestLogger
>() {}
