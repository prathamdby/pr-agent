import type {
  ArrayExpression,
  AssignmentExpression,
  AwaitExpression,
  BinaryExpression,
  BlockStatement,
  CallExpression,
  ConditionalExpression,
  Expression,
  ExpressionStatement,
  ForStatement,
  Function as FunctionNode,
  FunctionDeclaration,
  Identifier,
  IfStatement,
  Literal,
  LogicalExpression,
  MemberExpression,
  NewExpression,
  Node,
  ObjectExpression,
  Program,
  ReturnStatement,
  SequenceExpression,
  TemplateLiteral,
  ThrowStatement,
  TryStatement,
  UnaryExpression,
  UpdateExpression,
  VariableDeclaration,
  WhileStatement,
} from "acorn";
import { CODE_MODE_AST_FUEL } from "../../settings/index.js";
import {
  assertSafePropertyKey,
  assertSafeRegexInput,
  assertSafeRegexPattern,
  boundArrayLength,
  boundStringRepeat,
} from "./bounds.js";
import { CodeModeHostHalt } from "./hostHalt.js";

type ScopeKind = "const" | "let" | "var";

type Binding = {
  kind: ScopeKind;
  value: unknown;
};

type Scope = {
  readonly parent: Scope | null;
  readonly bindings: Map<string, Binding>;
};

export type EvaluateOptions = {
  readonly tools: Record<string, (args?: Record<string, unknown>) => Promise<unknown>>;
  readonly signal?: AbortSignal;
};

const ARRAY_CALLBACK_METHODS = new Set([
  "map",
  "filter",
  "find",
  "findIndex",
  "some",
  "every",
  "forEach",
  "flatMap",
  "reduce",
  "reduceRight",
]);

const RETURN = Symbol("return");

type Flow = { readonly kind: typeof RETURN; readonly value: unknown };

function isFlow(value: unknown): value is Flow {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === RETURN;
}

async function applyArrayCallbackMethod(
  method: string,
  array: unknown[],
  callback: (...fnArgs: unknown[]) => unknown,
  extraArgs: unknown[],
): Promise<unknown> {
  if (method === "reduce" || method === "reduceRight") {
    const source = method === "reduceRight" ? array.toReversed() : array;
    const hasInit = extraArgs.length > 0;
    let index = 0;
    let acc: unknown;
    if (hasInit) {
      acc = extraArgs[0];
    } else {
      if (source.length === 0) {
        throw new CodeModeHostHalt(
          "EXECUTION_ERROR",
          "Reduce of empty array with no initial value",
        );
      }
      acc = source[0];
      index = 1;
    }
    for (let i = index; i < source.length; i += 1) {
      const originalIndex = method === "reduceRight" ? array.length - 1 - i : i;
      acc = await callback(acc, source[i], originalIndex, array);
    }
    return acc;
  }

  const out: unknown[] = [];
  for (let i = 0; i < array.length; i += 1) {
    const item = array[i];
    const mapped = await callback(item, i, array);
    switch (method) {
      case "map":
        out.push(mapped);
        break;
      case "flatMap":
        if (Array.isArray(mapped)) out.push(...mapped);
        else out.push(mapped);
        break;
      case "filter":
        if (mapped) out.push(item);
        break;
      case "find":
        if (mapped) return item;
        break;
      case "findIndex":
        if (mapped) return i;
        break;
      case "some":
        if (mapped) return true;
        break;
      case "every":
        if (!mapped) return false;
        break;
      case "forEach":
        break;
      default:
        throw new CodeModeHostHalt("EXECUTION_ERROR", `Unsupported array method ${method}`);
    }
  }
  if (method === "find") return undefined;
  if (method === "findIndex") return -1;
  if (method === "some") return false;
  if (method === "every") return true;
  if (method === "forEach") return undefined;
  return out;
}

function childScope(parent: Scope | null): Scope {
  return { parent, bindings: new Map() };
}

function define(scope: Scope, name: string, kind: ScopeKind, value: unknown): void {
  scope.bindings.set(name, { kind, value });
}

function resolve(scope: Scope, name: string): Binding | undefined {
  let current: Scope | null = scope;
  while (current) {
    const found = current.bindings.get(name);
    if (found) return found;
    current = current.parent;
  }
  return undefined;
}

function assign(scope: Scope, name: string, value: unknown): void {
  const binding = resolve(scope, name);
  if (!binding) {
    throw new CodeModeHostHalt("EXECUTION_ERROR", `Unknown identifier: ${name}`);
  }
  if (binding.kind === "const") {
    throw new CodeModeHostHalt("EXECUTION_ERROR", `Cannot assign to const ${name}`);
  }
  binding.value = value;
}

function lineOf(node: Node): number | undefined {
  return node.loc?.start.line;
}

function primitiveText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "symbol") return value.toString();
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function allocateArray(length: number): unknown[] {
  return Array.from({ length: boundArrayLength(length) });
}

export async function evaluateProgram(
  program: Program,
  options: EvaluateOptions,
): Promise<unknown> {
  let fuel = CODE_MODE_AST_FUEL;
  const spend = (node: Node): void => {
    if (options.signal?.aborted) {
      throw new CodeModeHostHalt("TIMEOUT", "Code Mode cancelled by host signal", lineOf(node));
    }
    fuel -= 1;
    if (fuel <= 0) {
      throw new CodeModeHostHalt(
        "EXECUTION_BUDGET_EXCEEDED",
        `AST fuel exhausted (${CODE_MODE_AST_FUEL} steps)`,
        lineOf(node),
      );
    }
  };

  const globalScope = childScope(null);
  define(globalScope, "tools", "const", options.tools);
  define(globalScope, "Promise", "const", Promise);
  define(globalScope, "Math", "const", Math);
  define(globalScope, "JSON", "const", JSON);
  define(globalScope, "Object", "const", Object);
  define(globalScope, "Number", "const", Number);
  define(globalScope, "Boolean", "const", Boolean);
  define(globalScope, "Map", "const", Map);
  define(globalScope, "Set", "const", Set);
  define(globalScope, "Error", "const", Error);
  define(globalScope, "TypeError", "const", TypeError);
  define(globalScope, "RangeError", "const", RangeError);
  define(globalScope, "parseInt", "const", parseInt);
  define(globalScope, "parseFloat", "const", parseFloat);
  define(globalScope, "isNaN", "const", isNaN);
  define(globalScope, "isFinite", "const", isFinite);
  define(globalScope, "undefined", "const", undefined);
  define(globalScope, "NaN", "const", Number.NaN);
  define(globalScope, "Infinity", "const", Number.POSITIVE_INFINITY);
  define(globalScope, "Array", "const", createBoundedArray());
  define(globalScope, "String", "const", createBoundedString());
  define(globalScope, "RegExp", "const", createBoundedRegExp());

  let last: unknown;
  for (const statement of program.body) {
    const result = await evalNode(statement, globalScope);
    if (isFlow(result)) return result.value;
    last = result;
  }
  return last;

  function createBoundedArray(): ArrayConstructor {
    const BoundedArray = function BoundedArray(...args: unknown[]) {
      if (args.length === 1 && typeof args[0] === "number") {
        return allocateArray(args[0]);
      }
      return Array.from(args);
    } as unknown as ArrayConstructor;
    Object.setPrototypeOf(BoundedArray, Array);
    Object.defineProperty(BoundedArray, "prototype", { value: Array.prototype });
    return BoundedArray;
  }

  function createBoundedString(): StringConstructor {
    const BoundedString = function BoundedString(value?: unknown) {
      return String(value);
    } as unknown as StringConstructor;
    Object.setPrototypeOf(BoundedString, String);
    Object.defineProperty(BoundedString, "prototype", { value: String.prototype });
    return BoundedString;
  }

  function createBoundedRegExp(): RegExpConstructor {
    const BoundedRegExp = function BoundedRegExp(pattern: string, flags?: string) {
      assertSafeRegexPattern(String(pattern));
      return new RegExp(pattern, flags);
    } as unknown as RegExpConstructor;
    Object.setPrototypeOf(BoundedRegExp, RegExp);
    Object.defineProperty(BoundedRegExp, "prototype", { value: RegExp.prototype });
    return BoundedRegExp;
  }

  async function evalNode(node: Node, scope: Scope): Promise<unknown> {
    spend(node);
    switch (node.type) {
      case "Program":
        throw new CodeModeHostHalt("EXECUTION_ERROR", "Nested program", lineOf(node));
      case "ExpressionStatement":
        return evalNode((node as ExpressionStatement).expression, scope);
      case "BlockStatement": {
        const block = childScope(scope);
        let value: unknown;
        for (const statement of (node as BlockStatement).body) {
          value = await evalNode(statement, block);
          if (isFlow(value)) return value;
        }
        return value;
      }
      case "EmptyStatement":
        return undefined;
      case "VariableDeclaration": {
        const decl = node as VariableDeclaration;
        for (const item of decl.declarations) {
          if (item.id.type !== "Identifier") {
            throw new CodeModeHostHalt(
              "EXECUTION_ERROR",
              "Unsupported binding pattern",
              lineOf(node),
            );
          }
          const value = item.init ? await evalNode(item.init, scope) : undefined;
          const kind: ScopeKind =
            decl.kind === "var" ? "var" : decl.kind === "const" ? "const" : "let";
          define(scope, item.id.name, kind, value);
        }
        return undefined;
      }
      case "Identifier": {
        const name = (node as Identifier).name;
        if (name === "undefined") return undefined;
        const binding = resolve(scope, name);
        if (!binding) {
          throw new CodeModeHostHalt(
            "EXECUTION_ERROR",
            `Unknown identifier: ${name}`,
            lineOf(node),
          );
        }
        return binding.value;
      }
      case "Literal":
        return (node as Literal).value;
      case "TemplateLiteral": {
        const tpl = node as TemplateLiteral;
        let out = "";
        for (let i = 0; i < tpl.quasis.length; i += 1) {
          out += tpl.quasis[i]?.value.cooked ?? "";
          if (i < tpl.expressions.length) {
            const part = await evalNode(tpl.expressions[i]!, scope);
            out += primitiveText(part);
          }
        }
        return out;
      }
      case "ArrayExpression": {
        const arr = node as ArrayExpression;
        const out: unknown[] = [];
        for (const el of arr.elements) {
          if (!el) {
            out.push(undefined);
            continue;
          }
          if (el.type === "SpreadElement") {
            const spread = await evalNode(el.argument, scope);
            if (!Array.isArray(spread)) {
              throw new CodeModeHostHalt("EXECUTION_ERROR", "Spread requires an array", lineOf(el));
            }
            if (out.length + spread.length > 64 * 1024) {
              throw new CodeModeHostHalt(
                "LIMIT_EXCEEDED",
                "Array spread exceeds allocation bound",
                lineOf(el),
              );
            }
            out.push(...spread);
            continue;
          }
          out.push(await evalNode(el, scope));
        }
        return out;
      }
      case "ObjectExpression": {
        const obj = node as ObjectExpression;
        const out: Record<string, unknown> = Object.create(null);
        for (const prop of obj.properties) {
          if (prop.type !== "Property") {
            throw new CodeModeHostHalt(
              "EXECUTION_ERROR",
              "Unsupported object member",
              lineOf(node),
            );
          }
          const keyNode = prop.key;
          const key =
            !prop.computed && keyNode.type === "Identifier"
              ? keyNode.name
              : await evalNode(keyNode, scope);
          assertSafePropertyKey(key);
          out[String(key)] = await evalNode(prop.value, scope);
        }
        return out;
      }
      case "UnaryExpression": {
        const unary = node as UnaryExpression;
        const arg = await evalNode(unary.argument, scope);
        switch (unary.operator) {
          case "!":
            return !arg;
          case "+":
            return +(arg as number);
          case "-":
            return -(arg as number);
          case "typeof":
            return typeof arg;
          case "void":
            return undefined;
          default:
            throw new CodeModeHostHalt(
              "EXECUTION_ERROR",
              `Unsupported unary operator ${unary.operator}`,
              lineOf(node),
            );
        }
      }
      case "UpdateExpression": {
        const update = node as UpdateExpression;
        if (update.argument.type !== "Identifier") {
          throw new CodeModeHostHalt("EXECUTION_ERROR", "Unsupported update target", lineOf(node));
        }
        const current = Number(await evalNode(update.argument, scope));
        const next = update.operator === "++" ? current + 1 : current - 1;
        assign(scope, update.argument.name, next);
        return update.prefix ? next : current;
      }
      case "BinaryExpression": {
        const binary = node as BinaryExpression;
        const left = await evalNode(binary.left, scope);
        const right = await evalNode(binary.right, scope);
        switch (binary.operator) {
          case "+":
            return (left as never) + (right as never);
          case "-":
            return Number(left) - Number(right);
          case "*":
            return Number(left) * Number(right);
          case "/":
            return Number(left) / Number(right);
          case "%":
            return Number(left) % Number(right);
          case "**":
            return Number(left) ** Number(right);
          case "===":
            return left === right;
          case "!==":
            return left !== right;
          case "==":
            return left == right;
          case "!=":
            return left != right;
          case "<":
            return (left as number) < (right as number);
          case "<=":
            return (left as number) <= (right as number);
          case ">":
            return (left as number) > (right as number);
          case ">=":
            return (left as number) >= (right as number);
          case "in":
            return String(left) in (right as object);
          default:
            throw new CodeModeHostHalt(
              "EXECUTION_ERROR",
              `Unsupported binary operator ${binary.operator}`,
              lineOf(node),
            );
        }
      }
      case "LogicalExpression": {
        const logical = node as LogicalExpression;
        const left = await evalNode(logical.left, scope);
        if (logical.operator === "&&") return left ? await evalNode(logical.right, scope) : left;
        if (logical.operator === "||") return left ? left : await evalNode(logical.right, scope);
        if (logical.operator === "??")
          return left == null ? await evalNode(logical.right, scope) : left;
        throw new CodeModeHostHalt("EXECUTION_ERROR", "Unsupported logical operator", lineOf(node));
      }
      case "ConditionalExpression": {
        const cond = node as ConditionalExpression;
        return (await evalNode(cond.test, scope))
          ? await evalNode(cond.consequent, scope)
          : await evalNode(cond.alternate, scope);
      }
      case "AssignmentExpression": {
        const assignExpr = node as AssignmentExpression;
        if (assignExpr.left.type !== "Identifier") {
          throw new CodeModeHostHalt(
            "EXECUTION_ERROR",
            "Unsupported assignment target",
            lineOf(node),
          );
        }
        const value = await evalNode(assignExpr.right, scope);
        if (assignExpr.operator !== "=") {
          throw new CodeModeHostHalt(
            "EXECUTION_ERROR",
            "Compound assignment is unsupported",
            lineOf(node),
          );
        }
        assign(scope, assignExpr.left.name, value);
        return value;
      }
      case "SequenceExpression": {
        const seq = node as SequenceExpression;
        let value: unknown;
        for (const expr of seq.expressions) value = await evalNode(expr, scope);
        return value;
      }
      case "MemberExpression": {
        const member = node as MemberExpression;
        const object = await evalNode(member.object, scope);
        const key = member.computed
          ? await evalNode(member.property, scope)
          : (member.property as Identifier).name;
        assertSafePropertyKey(key);
        if (object == null) {
          throw new CodeModeHostHalt(
            "EXECUTION_ERROR",
            `Cannot read property ${String(key)} of ${object}`,
            lineOf(node),
          );
        }
        return (object as Record<string, unknown>)[String(key)];
      }
      case "CallExpression":
        return evalCall(node as CallExpression, scope);
      case "NewExpression":
        return evalNew(node as NewExpression, scope);
      case "AwaitExpression":
        return await Promise.resolve(await evalNode((node as AwaitExpression).argument, scope));
      case "IfStatement": {
        const ifs = node as IfStatement;
        if (await evalNode(ifs.test, scope)) return evalNode(ifs.consequent, scope);
        if (ifs.alternate) return evalNode(ifs.alternate, scope);
        return undefined;
      }
      case "WhileStatement": {
        const loop = node as WhileStatement;
        let value: unknown;
        while (await evalNode(loop.test, scope)) {
          value = await evalNode(loop.body, scope);
          if (isFlow(value)) return value;
        }
        return value;
      }
      case "ForStatement": {
        const loop = node as ForStatement;
        const forScope = childScope(scope);
        if (loop.init) await evalNode(loop.init, forScope);
        let value: unknown;
        while (!loop.test || (await evalNode(loop.test, forScope))) {
          value = await evalNode(loop.body, forScope);
          if (isFlow(value)) return value;
          if (loop.update) await evalNode(loop.update, forScope);
        }
        return value;
      }
      case "ReturnStatement": {
        const ret = node as ReturnStatement;
        return {
          kind: RETURN,
          value: ret.argument ? await evalNode(ret.argument, scope) : undefined,
        } satisfies Flow;
      }
      case "ThrowStatement":
        throw await evalNode((node as ThrowStatement).argument, scope);
      case "TryStatement": {
        const tryNode = node as TryStatement;
        try {
          return await evalNode(tryNode.block, scope);
        } catch (error) {
          if (error instanceof CodeModeHostHalt) throw error;
          if (!tryNode.handler) throw error;
          const catchScope = childScope(scope);
          if (tryNode.handler.param && tryNode.handler.param.type === "Identifier") {
            define(catchScope, tryNode.handler.param.name, "let", error);
          }
          return evalNode(tryNode.handler.body, catchScope);
        } finally {
          if (tryNode.finalizer) await evalNode(tryNode.finalizer, scope);
        }
      }
      case "FunctionDeclaration": {
        const fn = node as FunctionDeclaration;
        if (!fn.id) {
          throw new CodeModeHostHalt(
            "EXECUTION_ERROR",
            "Anonymous function declaration",
            lineOf(node),
          );
        }
        const fnValue = createFunction(fn, scope);
        define(scope, fn.id.name, "var", fnValue);
        return undefined;
      }
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        return createFunction(node as FunctionNode, scope);
      default:
        throw new CodeModeHostHalt(
          "EXECUTION_ERROR",
          `Unsupported language construct: ${node.type}`,
          lineOf(node),
        );
    }
  }

  function createFunction(
    fn: FunctionNode,
    lexical: Scope,
  ): (...args: unknown[]) => Promise<unknown> {
    return async (...args: unknown[]) => {
      const fnScope = childScope(lexical);
      for (let i = 0; i < fn.params.length; i += 1) {
        const param = fn.params[i];
        if (!param || param.type !== "Identifier") {
          throw new CodeModeHostHalt(
            "EXECUTION_ERROR",
            "Unsupported parameter pattern",
            lineOf(fn),
          );
        }
        define(fnScope, param.name, "let", args[i]);
      }
      const result = await evalNode(fn.body, fnScope);
      return isFlow(result) ? result.value : result;
    };
  }

  async function evalArgs(nodes: readonly Expression[], scope: Scope): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const arg of nodes) out.push(await evalNode(arg, scope));
    return out;
  }

  async function evalCall(node: CallExpression, scope: Scope): Promise<unknown> {
    const calleeNode = node.callee;
    let thisArg: unknown;
    let callee: unknown;
    if (calleeNode.type === "MemberExpression") {
      const member = calleeNode;
      thisArg = await evalNode(member.object, scope);
      const key = member.computed
        ? await evalNode(member.property, scope)
        : (member.property as Identifier).name;
      assertSafePropertyKey(key);
      callee = thisArg == null ? undefined : (thisArg as Record<string, unknown>)[String(key)];
      if (String(key) === "repeat" && typeof thisArg === "string") {
        const args = await evalArgs(node.arguments as Expression[], scope);
        return boundStringRepeat(thisArg, Number(args[0] ?? 0));
      }
      // Native Array.prototype callbacks are sync; interpreter functions are async.
      if (Array.isArray(thisArg) && ARRAY_CALLBACK_METHODS.has(String(key))) {
        const args = await evalArgs(node.arguments as Expression[], scope);
        const callback = args[0];
        if (typeof callback !== "function") {
          throw new CodeModeHostHalt(
            "EXECUTION_ERROR",
            `${String(key)} requires a function`,
            lineOf(node),
          );
        }
        return applyArrayCallbackMethod(
          String(key),
          thisArg,
          callback as (...fnArgs: unknown[]) => unknown,
          args.slice(1),
        );
      }
      if (
        (String(key) === "test" || String(key) === "exec" || String(key) === "match") &&
        (thisArg instanceof RegExp || typeof thisArg === "string")
      ) {
        const args = await evalArgs(node.arguments as Expression[], scope);
        const input = thisArg instanceof RegExp ? primitiveText(args[0]) : thisArg;
        const pattern = thisArg instanceof RegExp ? thisArg.source : primitiveText(args[0]);
        assertSafeRegexPattern(pattern);
        assertSafeRegexInput(input);
      }
    } else {
      callee = await evalNode(calleeNode, scope);
    }
    if (typeof callee !== "function") {
      throw new CodeModeHostHalt(
        "EXECUTION_ERROR",
        "Attempted to call a non-function",
        lineOf(node),
      );
    }
    const args = await evalArgs(node.arguments as Expression[], scope);
    return (callee as (...fnArgs: unknown[]) => unknown).apply(thisArg, args);
  }

  async function evalNew(node: NewExpression, scope: Scope): Promise<unknown> {
    const ctor = await evalNode(node.callee, scope);
    if (typeof ctor !== "function") {
      throw new CodeModeHostHalt("EXECUTION_ERROR", "new requires a constructor", lineOf(node));
    }
    const args = await evalArgs(node.arguments as Expression[], scope);
    if (ctor === Array || ctor?.name === "BoundedArray") {
      if (args.length === 1 && typeof args[0] === "number") {
        return allocateArray(args[0]);
      }
    }
    if (ctor === RegExp || ctor?.name === "BoundedRegExp") {
      assertSafeRegexPattern(primitiveText(args[0]));
    }
    return new (ctor as new (...fnArgs: unknown[]) => unknown)(...args);
  }
}
