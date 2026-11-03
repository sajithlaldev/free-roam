/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Token server URL for multiplayer when the site is hosted statically (e.g. GitHub Pages). */
  readonly VITE_TOKEN_URL?: string;
  /** '1' for a static build (no same-origin token server). */
  readonly VITE_STATIC?: string;
}
