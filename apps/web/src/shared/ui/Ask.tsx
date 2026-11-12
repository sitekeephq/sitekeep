import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { ConfirmDialog, PromptDialog } from "./Dialog";

export type ConfirmOpts = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

export type PromptOpts = {
  title: string;
  message?: string;
  defaultValue?: string;
  confirmLabel?: string;
  password?: boolean;
};

type AskApi = {
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  prompt: (opts: PromptOpts) => Promise<string | null>;
};

const AskContext = createContext<AskApi | null>(null);

export function AskProvider({ children }: { children: ReactNode }) {
  const [confirmAsk, setConfirmAsk] = useState<(ConfirmOpts & { resolve: (ok: boolean) => void }) | null>(null);
  const [promptAsk, setPromptAsk] = useState<(PromptOpts & { resolve: (value: string | null) => void }) | null>(null);

  const api = useMemo<AskApi>(
    () => ({
      confirm: (opts) => new Promise((resolve) => setConfirmAsk({ ...opts, resolve })),
      prompt: (opts) => new Promise((resolve) => setPromptAsk({ ...opts, resolve })),
    }),
    [],
  );

  return (
    <AskContext.Provider value={api}>
      {children}
      {confirmAsk && (
        <ConfirmDialog
          title={confirmAsk.title}
          message={confirmAsk.message}
          confirmLabel={confirmAsk.confirmLabel}
          cancelLabel={confirmAsk.cancelLabel}
          danger={confirmAsk.danger}
          onClose={() => {
            confirmAsk.resolve(false);
            setConfirmAsk(null);
          }}
          onConfirm={() => {
            confirmAsk.resolve(true);
            setConfirmAsk(null);
          }}
        />
      )}
      {promptAsk && (
        <PromptDialog
          title={promptAsk.title}
          message={promptAsk.message}
          defaultValue={promptAsk.defaultValue}
          confirmLabel={promptAsk.confirmLabel}
          password={promptAsk.password}
          onClose={() => {
            promptAsk.resolve(null);
            setPromptAsk(null);
          }}
          onConfirm={(value) => {
            promptAsk.resolve(value);
            setPromptAsk(null);
          }}
        />
      )}
    </AskContext.Provider>
  );
}

export function useAsk(): AskApi {
  const ctx = useContext(AskContext);
  if (!ctx) throw new Error("useAsk outside AskProvider");
  return ctx;
}
