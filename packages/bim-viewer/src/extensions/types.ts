import type { ViewerEngine } from "../core/ViewerEngine.js";

export interface ViewerExtensionContext {
  engine: ViewerEngine;
  container: HTMLElement;
}

export type ViewerExtensionCleanup = () => void | Promise<void>;

/**
 * Product-specific viewer behavior belongs in extensions. Extensions may add
 * overlays, event listeners or domain workflows without coupling the engine
 * to a host application's API or state management.
 */
export interface ViewerExtension {
  readonly id: string;
  activate(
    context: ViewerExtensionContext,
  ): void | ViewerExtensionCleanup | Promise<void | ViewerExtensionCleanup>;
}
