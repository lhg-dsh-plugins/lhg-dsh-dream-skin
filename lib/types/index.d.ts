/**
 * Host-side type declarations for `dsh-dream-skin`.
 *
 * The host half mounts a fenced persistence API (`/dream-skin/api`) that
 * stores the browser half's preferences in `$DSH_HOME/dream-skin.json` —
 * durable and origin-independent, so the saved skin / wallpaper / settings
 * survive the desktop app's per-launch random port (which changes the GUI
 * origin and would otherwise orphan the localStorage copy).
 */

/** Token-name → concrete CSS color for a registered theme (scalar per scheme). */
export interface SkinTokens {
  [name: string]: string;
}

/** A curated skin: an immutable third-party theme definition. */
export interface DreamSkin {
  /** Unique theme id (registered into ThemeRuntime; `"system"` is reserved). */
  id: string;
  /** Base palette this skin builds on; drives `body[data-ds-dark-theme]`. */
  colorScheme: "light" | "dark";
  /** `--dsw-alias-*` token overrides (and component-specific tokens). */
  tokens: SkinTokens;
}

/** Host cordis context surface the plugin requires. */
export interface DreamSkinHostContext {
  /** The web-server route registry (used to mount `/dream-skin/api`). */
  webServer: {
    register(route: {
      kind: "prefix";
      path: string;
      handler(req: unknown, res: unknown): Promise<void> | void;
    }): () => void;
  };
  /** Bind-derived trust list sampled at boot (LAN literals + --trusted-host). */
  webRuntime: {
    trustedHosts: readonly string[];
  };
  /** Register a disposer on the calling fiber. */
  effect(fn: () => (() => void) | void, label?: string): void;
}

/**
 * Host loader entry: mount the fenced persistence API. The patch layer
 * (cordis.patch.yml) inserts the `dream-skin` row; the browser half is picked
 * up by dsh-client-modules through the package's `dsh.client` declaration,
 * exactly like the shipped ui-* packages.
 */
export function apply(ctx: DreamSkinHostContext): void;

/** Plugin identity for cordis.yml rows. */
export const name: string;
/** Services required before mounting. */
export const inject: readonly string[];
