import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app/App";
import { AuthProvider } from "./app/context/auth";
import { QueryProvider } from "./app/providers/QueryProvider";
import { AskProvider } from "./shared/ui/Ask";
import { initI18n } from "./i18n";
import { loadEnabledModules } from "./app/modules";
import "@fontsource-variable/inter";
import "./styles.css";
import "./theme.css";
// 4D / 5D panels (Planning, Cost modules) style with these classes.
import "./sim.css";

// The modules the server runs, then the texts (with theirs): the remembered language is loaded before the
// first paint, so nothing flashes in English.
await loadEnabledModules();
await initI18n();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryProvider>
      <BrowserRouter>
        <AuthProvider>
          <AskProvider>
            <App />
          </AskProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryProvider>
  </React.StrictMode>,
);
