import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type CSSProperties,
} from "react";
import { ViewerEngine, type SelectedItem } from "../core/ViewerEngine.js";
import { ExtensionHost } from "../extensions/ExtensionHost.js";
import type { ViewerExtension } from "../extensions/types.js";

const EMPTY_EXTENSIONS: readonly ViewerExtension[] = [];

export interface ViewerCanvasHandle {
  readonly engine: ViewerEngine | null;
}

export interface ViewerCanvasProps {
  workerUrl?: string;
  showVendorLogo?: boolean;
  extensions?: readonly ViewerExtension[];
  className?: string;
  style?: CSSProperties;
  onReady?: (engine: ViewerEngine) => void;
  onSelectionChange?: (selection: SelectedItem | null) => void;
  onError?: (error: unknown) => void;
}

/**
 * Thin React lifecycle adapter. Toolbars, drawers and product state should
 * remain in the consuming application or an explicitly installed extension.
 */
export const ViewerCanvas = forwardRef<ViewerCanvasHandle, ViewerCanvasProps>(
  function ViewerCanvas(
    {
      workerUrl,
      showVendorLogo,
      extensions = EMPTY_EXTENSIONS,
      className,
      style,
      onReady,
      onSelectionChange,
      onError,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const engineRef = useRef<ViewerEngine | null>(null);
    const callbacksRef = useRef({ onReady, onSelectionChange, onError });
    callbacksRef.current = { onReady, onSelectionChange, onError };

    useImperativeHandle(ref, () => ({
      get engine() {
        return engineRef.current;
      },
    }));

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      let cancelled = false;
      let extensionHost: ExtensionHost | undefined;

      void ViewerEngine.create(container, { workerUrl, showVendorLogo })
        .then(async (engine) => {
          if (cancelled) {
            engine.dispose();
            return;
          }

          engineRef.current = engine;
          engine.onSelect = (selection) => {
            callbacksRef.current.onSelectionChange?.(selection);
          };

          extensionHost = new ExtensionHost({ engine, container });
          await extensionHost.activateAll(extensions);

          if (cancelled) {
            await extensionHost.dispose();
            engine.dispose();
            engineRef.current = null;
            return;
          }

          callbacksRef.current.onReady?.(engine);
        })
        .catch((error: unknown) => {
          callbacksRef.current.onError?.(error);
        });

      return () => {
        cancelled = true;
        const engine = engineRef.current;
        engineRef.current = null;
        void extensionHost?.dispose().catch((error: unknown) => {
          callbacksRef.current.onError?.(error);
        });
        engine?.dispose();
      };
    }, [extensions, showVendorLogo, workerUrl]);

    return (
      <div
        ref={containerRef}
        className={["seven-dimensions-viewer", className].filter(Boolean).join(" ")}
        style={{ position: "relative", width: "100%", height: "100%", ...style }}
      />
    );
  },
);
