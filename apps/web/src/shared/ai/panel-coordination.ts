export const MODEL_ASK_VISIBILITY_EVENT = "cde:model-ask-visibility";
let modelAskVisible = false;

/** Lets the project shell keep the project-wide assistant mutually exclusive with Modele Sor. */
export function publishModelAskVisibility(open: boolean): void {
  modelAskVisible = open;
  window.dispatchEvent(new CustomEvent<boolean>(MODEL_ASK_VISIBILITY_EVENT, { detail: open }));
}

export function isModelAskVisible(): boolean {
  return modelAskVisible;
}
