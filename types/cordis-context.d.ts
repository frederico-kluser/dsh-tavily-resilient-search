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

// #provenance package=@deepseek-ai/cordis version=4.0.4 file=lib/types/context.d.ts tarball-sha256=99a5cdb344de37cb033cb4e3a1dcfd29585d46f7d3a9c64bca9991554927185c retrieved=2026-09-24

// #mirror-begin Context-interface
export interface Context {
    /** Isolation map: service name → scope label. Lookups for a name resolve within its label. */
    [symbols.isolate]: Dict<symbol>;
    /** Intercept map: service name → config merged into that service's per-plugin config. */
    [symbols.intercept]: Dict;
    /** The root context of the application (every child context shares it). @experimental */
    root: this;
    /** Base URL used to resolve relative plugin/module specifiers, if the runtime sets one. */
    baseUrl?: string;
    /** The event bus. Its methods are also mixed onto `ctx` (`ctx.on`, `ctx.emit`, ...). */
    events: EventsService;
    /** The logging service. Call `ctx.logger(name)` for a named logger. */
    logger: LoggerService;
    /** The reflection layer backing the context proxy (`ctx.get`, `ctx.provide`, ...). */
    reflect: ReflectService;
    /** The plugin registry. Its methods are mixed onto `ctx` (`ctx.plugin`, `ctx.inject`). */
    registry: RegistryService;
}
// #mirror-end Context-interface

