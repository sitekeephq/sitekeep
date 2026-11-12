import type {
  ViewerExtension,
  ViewerExtensionCleanup,
  ViewerExtensionContext,
} from "./types.js";

interface ActiveExtension {
  extension: ViewerExtension;
  cleanup?: ViewerExtensionCleanup;
}

export class ExtensionHost {
  private readonly active: ActiveExtension[] = [];

  constructor(private readonly context: ViewerExtensionContext) {}

  async activateAll(extensions: readonly ViewerExtension[]): Promise<void> {
    const ids = new Set<string>();

    try {
      for (const extension of extensions) {
        if (ids.has(extension.id)) {
          throw new Error(`Duplicate viewer extension id: ${extension.id}`);
        }
        ids.add(extension.id);

        const cleanup = await extension.activate(this.context);
        this.active.push({
          extension,
          cleanup: typeof cleanup === "function" ? cleanup : undefined,
        });
      }
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  async dispose(): Promise<void> {
    const errors: unknown[] = [];

    for (const entry of this.active.splice(0).reverse()) {
      try {
        await entry.cleanup?.();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to dispose viewer extensions");
    }
  }
}
