import { useState } from "react";

/**
 * Which labeled groups are open. A new set of groups starts closed, so a long list stays a
 * short stack of headers. The group that holds the selected row opens with it.
 */
export function useGroupOpen(keys: readonly string[], selectedKey: string | null): {
  isOpen(key: string): boolean;
  toggle(key: string): void;
  expandAll(): void;
  collapseAll(): void;
} {
  const signature = keys.join("\0");
  const [tracked, setTracked] = useState(signature);
  const [followed, setFollowed] = useState<string | null>(selectedKey);
  const [open, setOpen] = useState<ReadonlySet<string>>(() =>
    selectedKey && keys.includes(selectedKey) ? new Set([selectedKey]) : new Set(),
  );

  let current = open;
  if (tracked !== signature) {
    const next = new Set<string>();
    if (selectedKey && keys.includes(selectedKey)) next.add(selectedKey);
    current = next;
    setTracked(signature);
    setFollowed(selectedKey);
    setOpen(current);
  } else if (selectedKey !== followed) {
    setFollowed(selectedKey);
    if (selectedKey && keys.includes(selectedKey) && !current.has(selectedKey)) {
      const next = new Set(current);
      next.add(selectedKey);
      current = next;
      setOpen(current);
    }
  }

  return {
    isOpen: (key) => current.has(key),
    toggle: (key) =>
      setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    expandAll: () => setOpen(new Set(keys)),
    collapseAll: () => setOpen(new Set()),
  };
}
