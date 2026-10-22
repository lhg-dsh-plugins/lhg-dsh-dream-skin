/**
 * Browser-half type declarations for `dsh-dream-skin`.
 *
 * These describe the surface the bundle exports (`SKINS`, `apply`, `inject`)
 * and the cordis service shape it relies on (`ctx.theme`, `ctx.slots`,
 * `ctx.locale`). They are advisory — the shipped bundle is plain JS executed
 * through the shell's lazy-CJS module table, so no runtime import of these
 * types happens.
 */

import type { Context } from "@deepseek-ai/cordis";
import type { DreamSkin, SkinTokens } from "../index.js";

/** Registry definition accepted by ThemeRuntime.register. */
export interface ThemeRegistration {
  id: string;
  colorScheme: "light" | "dark";
  tokens: SkinTokens;
}

/** One color scheme for a token override (must be `{ light, dark }`). */
export interface TokenOverridePair {
  light: string;
  dark: string;
}

/** The immutable theme snapshot published on `theme/change`. */
export interface ThemeSnapshot {
  preference: "light" | "dark" | "system" | string;
  active: ThemeRegistration;
  themes: ReadonlyArray<ThemeRegistration>;
  revision: number;
}

/** The cordis services a browser bundle relies on. */
export interface DreamSkinCtx extends Context {
  theme: {
    getTheme(): ThemeSnapshot;
    setTheme(id: string): void;
    register(def: ThemeRegistration): () => void;
    overrideTokens(source: string, tokens: Record<string, TokenOverridePair>): () => void;
  };
  slots: {
    inject(name: string, register: () => unknown): void;
    register(desc: Record<string, unknown>, Component: unknown): unknown;
  };
  locale: {
    register(namespace: string, dict: Record<string, Record<string, string>>): () => void;
  };
  on(event: "theme/change", handler: (snapshot: ThemeSnapshot) => void): void;
}

/** Browser-half entry: register skins and settings rows. */
export function apply(ctx: DreamSkinCtx): void;

/** Services injected before this plugin's `apply`. */
export const inject: string[];

/** The curated skin catalog (also exported for previews/tests). */
export const SKINS: DreamSkin[];

/** Sentinel id meaning "follow the built-in appearance". */
export const DEFAULT_SKIN: "system";

/** The settings-row locale namespace. */
export const SETTINGS_NS: string;
