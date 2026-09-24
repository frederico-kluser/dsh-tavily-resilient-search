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

// #provenance package=@deepseek-ai/dsh-llm version=0.1.7-rc.1 file=lib/types/types.d.ts tarball-sha256=00ed0fd4bf4fc31b5656de7d53cb638b2b7128f6426a2fe321d34f618d6870ec retrieved=2026-09-24

// #mirror-begin ContentBlock-surface
export interface TextBlock {
    type: 'text';
    text: string;
}
/** Reasoning / thinking content, distinct from visible text. */
export interface ReasoningBlock {
    type: 'reasoning';
    text: string;
}
/**
 * A durable raster image reference, valid in user or assistant content. The
 * block is deliberately role-neutral; assistant-side rendering is forward
 * compatibility — the current production adapters declare text-only output,
 * so only user messages may carry images.
 */
export interface ImageBlock {
    type: 'image';
    /** Immutable bytes and intrinsic display metadata owned by the attachment service. */
    attachment: ImageAttachmentRef;
    /**
     * Derived from a durable image-offload decision or preserved by a message
     * rewrite. Every route sends placeholder text naming the image and its
     * available read-only path instead of image bytes.
     */
    offloaded?: true;
}
/**
 * A durable verbatim file reference, valid in user content. Files never reach
 * a provider natively: request assembly projects every occurrence to
 * deterministic handle text (name, byte size, and the read-only saved path),
 * so adapters and providers see text in its place while the durable log keeps
 * the structured reference for presentation and authorization.
 */
export interface FileBlock {
    type: 'file';
    /** Immutable verbatim bytes and display metadata owned by the attachment service. */
    attachment: FileAttachmentRef;
}
/** A tool invocation requested by the model. */
export interface ToolCallBlock {
    type: 'tool-call';
    /** Provider-issued call id; correlates with the matching tool result. */
    id: ToolCallId;
    name: string;
    /** Raw JSON string as produced by the model. */
    arguments: string;
}
/** Activates a tool definition from the developer event's referenced request header. */
export interface ToolAdditionBlock {
    type: 'tool-addition';
    /** Name of exactly one tool in the referenced historical header. */
    toolName: string;
    /**
     * Reserved against inline definitions; the historical request header owns the schema.
     * @persistenceReserved
     */
    tool?: never;
}
/** Records the dynamic removal of a tool identified by its session-local name. */
export interface ToolRemovalBlock {
    type: 'tool-removal';
    toolName: string;
}
/**
 * Merge-extensible content blocks keyed by `type`. New core blocks must land
 * with adapter, UI, and compaction support. Developer tool-change blocks are
 * reserved for Session V4 persistence; providers and UI reject them until
 * their producers and consumers are implemented together.
 */
export interface ContentBlockMap {
    'text': TextBlock;
    'reasoning': ReasoningBlock;
    'image': ImageBlock;
    'file': FileBlock;
    'tool-call': ToolCallBlock;
    'tool-addition': ToolAdditionBlock;
    'tool-removal': ToolRemovalBlock;
}
/** The block `type` tag vocabulary; widens as plugins add entries to {@link ContentBlockMap}. */
export type ContentBlockType = keyof ContentBlockMap;
/** Any known content block, derived from {@link ContentBlockMap}; switch on `type` and fall through unknowns (merge-extensible). */
export type ContentBlock = ContentBlockMap[ContentBlockType];
// #mirror-end ContentBlock-surface

