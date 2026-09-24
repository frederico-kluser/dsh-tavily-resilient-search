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

// #provenance package=@deepseek-ai/dsh-client-ui-settings version=0.1.7-rc.1 file=lib/types/client/contract/slots.d.ts tarball-sha256=780f0b34f6c63c0ceee414dfb3ff9f2f9ab9eccf1e289401144ee8df7e676699 retrieved=2026-09-24

// #mirror-begin settings.section-slot
        /**
         * One settings page per list entry. Registrant options carry the nav
         * identity: `id` (section key, drives `only` filtering), `order` (nav
         * position), `label` (registrant-localized display text — the registrant
         * re-registers with fresh text on locale change, so the shell never
         * subscribes locale state; the ledger bump doubles as the shell's
         * re-render trigger). Sections render inside the panel content column.
         * (`settings.general.item`, declared by ui-settings-general's General
         * entry, is typed in the locale package — the common dependency of every
         * item registrant; the shell neither declares nor renders it.)
         */
        'settings.section': {
            kind: 'list';
            scope: 'root';
            owner: SettingsSectionOwnerProps;
        };
// #mirror-end settings.section-slot

