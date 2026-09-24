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

// #provenance package=@deepseek-ai/dsh-tools version=0.1.7-rc.1 file=lib/types/schema.d.ts tarball-sha256=9549f080afb5be55013eeeca728b0658321182af909c18890d6e6f1a3996e31b retrieved=2026-09-24

// #mirror-begin ValueSchemaAnnotations..ParameterSchemaSpec
export interface ValueSchemaAnnotations {
    /** Human-readable description projected into JSON Schema and generated types. */
    description?: string;
    /** Human-readable title projected into JSON Schema. */
    title?: string;
    /** Non-validating default annotation; it must be lossless JSON data. */
    default?: JsonValue;
    /** Non-validating examples annotation; it must be lossless JSON data. */
    examples?: JsonValue;
}
/** String value schema with type-correct literal constraints. */
export interface StringValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'string';
    enum?: readonly string[];
    const?: string;
}
/** Finite JSON-number schema with type-correct literal constraints. */
export interface NumberValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'number';
    enum?: readonly number[];
    const?: number;
}
/** Integer schema with type-correct literal constraints. */
export interface IntegerValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'integer';
    enum?: readonly number[];
    const?: number;
}
/** Boolean value schema with type-correct literal constraints. */
export interface BooleanValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'boolean';
    enum?: readonly boolean[];
    const?: boolean;
}
/** Null value schema with type-correct literal constraints. */
export interface NullValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'null';
    enum?: readonly null[];
    const?: null;
}
/** Array value schema; omitted `items` accepts any lossless JSON item. */
export interface ArrayValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'array';
    items?: ValueSchemaSpec;
}
/**
 * Explicit object value schema. Openness is mandatory so a nested or output
 * object never acquires an accidental JSON Schema default.
 */
export interface ObjectValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'object';
    properties?: ParameterSchemaSpec;
    additionalProperties: boolean;
}
/** Author-only unconstrained lossless JSON node. */
export interface JsonValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'json';
}
/** Exact-one union schema; at least two branches are required. */
export interface OneOfValueSchemaSpec extends ValueSchemaAnnotations {
    oneOf: readonly [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]];
}
/** One author-facing schema for any lossless JSON value root. */
export type ValueSchemaSpec = StringValueSchemaSpec | NumberValueSchemaSpec | IntegerValueSchemaSpec | BooleanValueSchemaSpec | NullValueSchemaSpec | ArrayValueSchemaSpec | ObjectValueSchemaSpec | JsonValueSchemaSpec | OneOfValueSchemaSpec;
/** One implicit parameter-root property, optionally required. */
export type ParameterPropertySpec = ValueSchemaSpec & {
    required?: true;
};
/**
 * Tool parameter schema. The map itself is an implicit open object root;
 * requiredness remains a per-property `required: true` annotation.
 */
export type ParameterSchemaSpec = {
    [key: string]: ParameterPropertySpec;
    [key: symbol]: never;
};
// #mirror-end ValueSchemaAnnotations..ParameterSchemaSpec

// #mirror-begin DefineToolOptions
export interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
    /** Tool name (must be unique). */
    readonly name: string;
    /** Human-readable description sent to the model. */
    readonly description: string;
    /** Per-property parameter schema compiled to an implicit open object root. */
    readonly parameters: S;
    /** Canonical output schema plus pure Native and presentation projections. */
    readonly output: {
        /** Schema enforced against every successful body or policy-replaced value. */
        readonly schema: O;
        /** Pure Native/model rendering of one validated canonical value. */
        render(args: InferArgs<S>, value: InferValue<NoInfer<O>>): ContentBlock[];
        /** Pure replayable presentation metadata for direct top-level calls. */
        presentationMeta?(args: InferArgs<S>, value: InferValue<NoInfer<O>>): JsonValue;
    };
    /** Requests deferred loading of the tool definition; see {@link @deepseek-ai/dsh-llm#ToolSchema.deferLoading}. */
    readonly deferLoading?: true;
    /** Optional positive cooperative timeout budget in milliseconds. */
    readonly timeoutMs?: number;
    /**
     * Pure classifier for sibling overlap.
     * @param args - typed validated arguments.
     * @returns Whether the call may join a parallel group.
     */
    isConcurrencySafe?(args: InferArgs<S>): boolean;
    /**
     * Execute the tool after argument validation.
     * @param args - typed validated arguments.
     * @param exec - execution identity, caller, cancellation, and nesting data.
     * @returns The canonical value declared by `output.schema`.
     */
    execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<NoInfer<O>>>;
    /**
     * Install execution-prepared content before result policies.
     * @param exec - immutable execution identity and arguments.
     * @param result - normalized outcome entering post-execute.
     * @returns replacement content, or undefined to preserve it.
     */
    projectContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
    /**
     * Optional last-mile content transform for every normalized outcome. Unlike
     * `execute`, arguments remain `unknown` because invalid-input failures also
     * reach this callback. See {@link ToolDefinition.finalizeContent}.
     * @param exec - immutable execution identity and arguments.
     * @param result - complete normalized outcome before materialization.
     * @returns replacement content, or `undefined` to preserve it.
     */
    finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
    /**
     * Pure pending-state presenter.
     * @param args - typed validated arguments.
     * @returns Tool-owned render intent, or `undefined` for the generic card.
     */
    presentCall?(args: InferArgs<S>): ToolCallView | undefined;
    /**
     * Pure completed-state presenter.
     * @param args - typed validated arguments.
     * @param result - final model-facing tool result.
     * @returns Tool-owned render intent, or `undefined` for the generic card.
     */
    presentResult?(args: InferArgs<S>, result: ToolResult): ToolResultView | undefined;
}
// #mirror-end DefineToolOptions

// #mirror-begin defineTool-declaration
export declare function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(options: DefineToolOptions<S, O>): ToolDefinition;
// #mirror-end defineTool-declaration

