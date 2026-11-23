/**
 * Cuts every finished <think>…</think> block out of `text` (an unfinished one stays). One forward pass with
 * literal searches: the lazy `<think>[\s\S]*?<\/think>` regex is quadratic on many openers without a closer.
 */
export function removeThinkBlocks(text: string, ignoreCase: boolean, eatTrailingSpace: boolean): string {
  const flags = ignoreCase ? "gi" : "g";
  const open = new RegExp("<think>", flags);
  const close = new RegExp("</think>", flags);
  let out = "";
  let pos = 0;
  for (;;) {
    open.lastIndex = pos;
    const o = open.exec(text);
    if (!o) break;
    close.lastIndex = o.index + o[0].length;
    const c = close.exec(text);
    if (!c) break;
    out += text.slice(pos, o.index);
    pos = c.index + c[0].length;
    if (eatTrailingSpace) while (pos < text.length && /\s/.test(text[pos]!)) pos++;
  }
  return out + text.slice(pos);
}
