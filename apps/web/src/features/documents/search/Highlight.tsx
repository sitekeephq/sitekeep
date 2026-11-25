import { highlightParts } from "@sitekeep/shared";

/** Text with the search terms marked (Turkish I aware, wildcard pieces each). */
export function Highlight({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlightParts(text, terms).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </>
  );
}
