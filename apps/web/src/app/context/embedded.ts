import { createContext, useContext } from "react";

/**
 * Set by the İşler hub and the Model tabs for the pages they render inside: the page leaves out
 * its own <h1> (the hub or the tab bar already names it) and keeps its toolbar.
 */
export interface Embedded {
  /** "hub" (İşler) or "model" (Model tabs). */
  in: "hub" | "model";
  /** Changes after "+ Yeni" created a record: lists reload. */
  refreshKey?: number;
}

export const EmbeddedContext = createContext<Embedded | null>(null);

export function useEmbedded(): Embedded | null {
  return useContext(EmbeddedContext);
}
