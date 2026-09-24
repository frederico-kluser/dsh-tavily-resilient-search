/**
 * ESPELHO VERBATIM de declarações .d.ts publicadas — NUNCA edite o corpo dos
 * blocos espelhados. Este ficheiro existe para o contrato de tipos
 * (test/contract) alarmar quando a API real publicada divergir do que este
 * plugin assume, e para documentar a superfície medida (Q-1: validar contra
 * .d.ts/tarballs, nunca contra prosa).
 *
 * Regeneração: `node scripts/verify-upstream.mjs --write-mirrors` reextrai os
 * blocos dos tarballs oficiais; `pnpm test` valida a correspondência byte a
 * byte (normalizada) contra o pacote instalado em node_modules.
 */

// #provenance package=@deepseek-ai/dsh-tools version=0.1.7-rc.1 file=lib/types/index.d.ts tarball-sha256=9549f080afb5be55013eeeca728b0658321182af909c18890d6e6f1a3996e31b retrieved=2026-09-24

// #mirror-begin ToolOutputDefinition
export interface ToolOutputDefinition {
    /** Raw supported JSON Schema enforced against every successful canonical value. */
    readonly schema: JsonSchemaNode;
    /** Pure projection from validated arguments and value to Native/model content. */
    render(args: unknown, value: JsonValue): ContentBlock[];
    /** Pure replayable presentation projection, computed only for top-level calls. */
    presentationMeta?(args: unknown, value: JsonValue): JsonValue;
}
// #mirror-end ToolOutputDefinition

// #mirror-begin ToolDefinition
export interface ToolDefinition extends ToolSchema {
    /** Mandatory canonical output declaration. */
    readonly output: ToolOutputDefinition;
    /**
     * Run one accepted call and return only its canonical lossless-JSON value.
     * Async work must observe or forward `exec.signal` and settle only after its
     * owned work reaches quiescence. The registry preserves caller cancellation
     * through around-dispatch signal replacement and does not abandon this
     * promise, but it cannot hard-kill same-process code.
     * @param args - losslessly snapshotted, frozen model arguments.
     * @param exec - execution identity, cancellation signal, and context deferral.
     * @returns the canonical value declared by `output.schema`.
     */
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
    /**
     * Install execution-prepared content before `tools/post-execute` policies.
     * The callback is captured when the call starts and runs once for a
     * normalized outcome entering post-execute. Policy replacements remain
     * authoritative; pipeline failures that bypass post-execute skip projection.
     * @param exec - immutable execution identity and arguments.
     * @param result - normalized result before post-execute policy.
     * @returns replacement content, or undefined to preserve the renderer output.
     */
    projectContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
    /**
     * Synchronous last-mile transform for model-facing content. The registry
     * snapshots this callback when execution starts and invokes it exactly once
     * for every normalized outcome, including pipeline failures that bypass
     * `tools/post-execute`, immediately before lossless materialization.
     * Returning `undefined` preserves the content; every other result field
     * remains registry-owned. The callback must be total and must not throw.
     * @param exec - immutable execution identity and arguments.
     * @param result - complete normalized outcome before materialization.
     * @returns replacement content, or `undefined` to preserve it.
     */
    finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
    /**
     * Cooperative tool-call timeout budget in milliseconds. Omit for no deadline.
     * Enforced by `@deepseek-ai/dsh-tool-call-timeout-policy` (a `tools/execute` wrapper); it
     * is NEVER sent to the model — `schemas()` whitelists only name/description/
     * parameters. Declaring it asserts this tool forwards `exec.signal` to a
     * cooperative implementation that can reach quiescence when the signal aborts.
     */
    timeoutMs?: number;
    /**
     * Pure synchronous classifier for overlap with sibling tool calls. Only
     * `true` opts in; omission, exceptions, non-`true` returns, and invalid
     * `defineTool` arguments are exclusive. This metadata is never model-visible.
     *
     * Opted-in executions must not mutate parent-owned state. Shared state must
     * tolerate concurrent dispatch; recorder races are permitted only when they
     * commute or fail closed. See the
     * [parallel-tool-call Agent Note](../../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md)
     * for the full contract.
     * @param args - parsed arguments; `defineTool` validates before calling.
     * @returns Whether this call may join a parallel group.
     */
    isConcurrencySafe?(args: unknown): boolean;
    /**
     * Optional: how to present the PENDING state of one call in a UI, derived from
     * the call's `args` (parsed arguments, `unknown` — the tool validates/narrows
     * its own input). Returns a {@link ToolCallView} (a `card`-tagged render intent),
     * or `undefined` (or omit the method) to fall back to a generic presentation
     * (title = tool name, raw args as input). Pure and side-effect-free: a UI may
     * call it during live streaming AND a session-log replay, so it must depend
     * only on `args`.
     */
    presentCall?(args: unknown): ToolCallView | undefined;
    /**
     * Optional: how to present the COMPLETED state, given the same `args` and the
     * durable result projection (`content`, failure state, and optional `meta`). Returns a
     * {@link ToolResultView}, or `undefined` (or omit the method) to keep the
     * pending title and render the raw result content. Pure and side-effect-free
     * for the same replay reason.
     */
    presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined;
}
// #mirror-end ToolDefinition

// #mirror-begin ToolExecutionInput
export interface ToolExecutionInput {
    readonly callId: ToolCallId;
    /**
     * Root model-requested call owning this execution tree. Callers omit it for
     * a root execution; nested dispatchers propagate the enclosing value.
     */
    readonly rootCallId?: ToolCallId;
    readonly name: string;
    /** Binding-time tool schema for a PTC inner call; frozen by its producer and never logged. */
    readonly schema?: ToolSchema;
    /** Losslessly JSON-serializable parsed arguments (tools validate their own schema). */
    readonly arguments: unknown;
    /** The agent on whose behalf the call runs (set by the agent loop). */
    readonly agent?: Agent;
    /**
     * Opaque token of the enclosing transport execution, when one exists. PTC
     * mode sets this on SDK sub-dispatches so commit-style observers can wait for
     * the outer `run_code` outcome without receiving its live mutable execution.
     * The token also marks the call as a transport sub-dispatch rather than a
     * model-direct call: under `mode: 'ptc'`, only calls WITH a parent may
     * execute a native tool name — a model-direct call (no parent) is denied as
     * `UNKNOWN_TOOL` before the policy pipeline. See {@link ToolRuntime.execute}.
     */
    readonly parent?: ToolExecutionToken;
    /** Required caller-owned cancellation for this invocation. */
    readonly signal: AbortSignal;
}
// #mirror-end ToolExecutionInput

// #mirror-begin ToolRunContext
export interface ToolRunContext extends ToolExecution {
    /**
     * Defer one context — typically a nested-dispatch context ferried by a
     * composite tool, or a fresh plugin-sourced instruction — until this tool's
     * final result reaches the agent loop. Contexts retain their individual
     * source and metadata and are emitted in call order.
     */
    deferContext(context: UserMessage): void;
    /**
     * Mark a successful final result as terminal for the current agent turn.
     * The marker rides this execution's own result (`concludesTurn` exists only
     * on {@link ToolExecutionSuccess}); a composite that dispatches nested
     * calls forwards it from the nested result, exactly like
     * `additionalContexts`, so only an authoritative nested success can
     * conclude the enclosing run.
     */
    concludeTurn(): void;
}
// #mirror-end ToolRunContext

// #mirror-begin ToolGuard
export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined;
// #mirror-end ToolGuard

// #mirror-begin cordis-augmentation-tools
declare module '@deepseek-ai/cordis' {
    interface Context {
        tools: ToolRuntime;
    }
// #mirror-end cordis-augmentation-tools

// #mirror-begin ToolRuntime-register
    register(definition: ToolDefinition): () => void;
// #mirror-end ToolRuntime-register

// #mirror-begin ToolRuntime-guard
    guard(guard: ToolGuard): () => void;
// #mirror-end ToolRuntime-guard

