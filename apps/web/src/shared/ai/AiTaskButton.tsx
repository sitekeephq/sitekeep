/**
 * "Yapay Zekâya Gönder" (AI task queue) where the core and modules offer it. The button is the AI
 * module's (`ai.ui`); without it nothing shows and the mode is "hidden" (docs/modules/ai.md).
 */
import { webCapability } from "../../sdk/capabilities";
import type { AiTaskButtonMode, AiTaskDto, AiTaskKind } from "./ai-tasks";

export interface AiTaskButtonProps {
  projectId: string;
  kind: AiTaskKind;
  /** The request; null when the form is not ready (the button is disabled). */
  input: Record<string, unknown> | null;
  onResult(result: unknown, task: AiTaskDto): void;
  /** Button text; default "Run with My AI". */
  label?: string;
  disabled?: boolean;
  disabledReason?: string;
  small?: boolean;
}

export function AiTaskButton(p: AiTaskButtonProps) {
  const Button = webCapability("ai.ui")?.AiTaskButton;
  return Button ? <Button {...p} /> : null;
}

/** Whether (and how) the "Yapay Zekâya Gönder" option shows in this project. */
export function useAiTaskMode(projectId: string): AiTaskButtonMode {
  // The installed modules never change while the app runs, so the hook order is stable.
  const use = webCapability("ai.ui")?.useAiTaskMode;
  return use ? use(projectId) : "hidden";
}
