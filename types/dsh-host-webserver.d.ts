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

// #provenance package=@deepseek-ai/dsh-host-webserver version=0.1.7-rc.1 file=lib/types/index.d.ts tarball-sha256=44b9e2bfde659fb9c2fce0ed8d602767b0ab02262bbad78a1b69e6f2ee0d75a7 retrieved=2026-09-24

// #mirror-begin WebRouteKind
export type WebRouteKind = 'exact' | 'prefix';
// #mirror-end WebRouteKind

// #mirror-begin WebRoute
export interface WebRoute {
    kind: WebRouteKind;
    /** Absolute pathname, no trailing slash. */
    path: string;
    /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
// #mirror-end WebRoute

// #mirror-begin Config-bind
export interface Config {
    /** Listen host; the two supported values are loopback and all-interfaces. */
    host: '127.0.0.1' | '0.0.0.0';
    /** Listen port; zero requests an OS-assigned port. */
    port: number;
    /** Response compression for socket-backed HTTP requests. @default 'none' */
    compression?: 'none' | 'gzip';
    /** Gzip DEFLATE level from 0 through 9. @default 1 */
    compressionLevel?: number;
    /** Minimum known response length eligible for gzip; unknown-length streams are eligible. @default 1024 */
    compressionThresholdBytes?: number;
}
// #mirror-end Config-bind

// #mirror-begin WebServer-class-surface
export declare class WebServer extends Service {
    private config;
    static Config: z<Config>;
    private readonly exact;
    private readonly prefixes;
    private readonly upgrades;
    private readonly upgradedSockets;
    private readonly indexTaps;
    private fallback;
    private server;
    private listenedPort;
    private readonly gzip;
    constructor(ctx: Context, config: Config);
    /** The listening port (the OS-assigned value when config.port is 0). */
    get port(): number;
    /** The configured bind host (the loopback or all-interfaces literal). */
    get host(): Config['host'];
    /**
     * Register a named route. Duplicate (kind, path) throws — route patterns are
     * a composition-level contract, so a collision is a misconfiguration.
     * @param route - kind, path, and the owning handler.
     * @returns the disposer removing the route.
     */
    register(route: WebRoute): () => void;
    /**
     * Register an exact-path HTTP upgrade route. Duplicate paths throw because
     * one socket can have only one protocol owner.
     * @param route - pathname and handler owning negotiation plus socket use.
     * @returns the disposer removing the route.
     */
    registerUpgrade(route: WebUpgradeRoute): () => void;
    /**
     * Claim the fallback seat: the handler answering every request no named
     * route matches (the SPA dist server in the shipped Web composition). One
     * owner only — a second registration throws, because two fallbacks cannot
     * compose.
     * @param handler - owns the full response lifecycle of unmatched requests.
     * @returns the disposer releasing the seat.
     */
    registerFallback(handler: WebRoute['handler']): () => void;
    /**
     * Register a raw-HTML index transform, the escape hatch for markup no
     * {@link IndexInjection} row expresses: {@link renderIndex} applies taps in
     * registration order after rendering the structured rows.
     * @param transform - pure html-to-html function.
     * @returns the disposer removing the transform.
     */
    tapIndex(transform: (html: string) => string): () => void;
    /** Listen; resolves once the socket is bound (rejection = FAILED fiber). */
    [Service.init](): Promise<void>;
    /** Longest-prefix-wins over the prefix table after an exact-table miss. */
    private match;
    /**
     * Run an index.html body through the registered taps in registration order
     * — called by the fallback owner on every index response it renders.
     * @param html - the raw index.html body.
     * @returns the transformed body.
     */
    applyIndexTaps(html: string): string;
    /**
     * Gather the structured injection table: one `webserver/index-inject` emit,
     * every subscriber pushes its current rows. Fresh per call, so subscribers
     * read live state (module graph, theme preference) at emit time.
     * @returns rows in subscriber activation order.
     */
    collectIndexInjections(): IndexInjection[];
    /**
     * Render one index.html body: the structured injection table first, then
     * the raw `tapIndex` transforms over the result.
     * @param html - the raw index.html body.
     * @returns the transformed body.
     */
    renderIndex(html: string): string;
}
// #mirror-end WebServer-class-surface

// #mirror-begin Context-augmentation-webServer
declare module '@deepseek-ai/cordis' {
    interface Context {
        webServer: WebServer;
    }
// #mirror-end Context-augmentation-webServer

