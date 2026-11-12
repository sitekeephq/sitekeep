import { createRoot } from "react-dom/client";
import { ScanViewer } from "../src/react";
import { configureScanAssets } from "../src/scan";
import "../styles.css";
import "../tools.css";
import "./playground.css";

configureScanAssets("/scans");

createRoot(document.getElementById("root")!).render(
  <div data-testid="scan-shell" className="pg-shell">
    <ScanViewer fragmentRoutes={["/models/sample-wall.frag"]} />
  </div>,
);
