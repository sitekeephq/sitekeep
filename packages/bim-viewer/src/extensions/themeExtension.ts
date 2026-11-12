import * as THREE from "three";
import type { ViewerExtension } from "./types.js";

export interface ThemeExtensionOptions {
  /** Current theme id (e.g. light / dark). */
  readTheme: () => string;
  /** Scene background color for the active theme. */
  sceneBackgroundHex: (theme?: string) => number;
  /** DOM event name fired when the theme changes (optional). */
  themeChangeEvent?: string;
}

/**
 * Host-owned light/dark scene background. Products pass their own theme readers so
 * the package stays free of app-specific storage keys.
 */
export function createThemeExtension(options: ThemeExtensionOptions): ViewerExtension {
  const eventName = options.themeChangeEvent ?? "ob-theme-change";
  return {
    id: "seven-d-theme",
    activate({ engine }) {
      const apply = (theme?: string) => {
        engine.world.scene.three.background = new THREE.Color(
          options.sceneBackgroundHex(theme ?? options.readTheme()),
        );
        engine.fragments.core.update(true);
      };

      apply();
      const onTheme = (event: Event) => {
        const detail = (event as CustomEvent<string>).detail;
        apply(detail);
      };
      window.addEventListener(eventName, onTheme);

      return () => {
        window.removeEventListener(eventName, onTheme);
      };
    },
  };
}
