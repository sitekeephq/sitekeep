import { Fragment, type ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * Small markdown renderer for assistant answers. It builds React elements only — raw HTML in the
 * text is shown as text, never interpreted — and allows links to app paths ("/projects/…") and http(s) URLs.
 * Supports headings, paragraphs, bullet and numbered lists, pipe tables, code blocks and inline
 * **bold**, *italic*, `code` and [links](…).
 */
export function Markdown({ text, onNavigate }: { text: string; onNavigate?: () => void }) {
  return <div className="md">{blocks(text.replace(/\r\n?/g, "\n"), onNavigate)}</div>;
}

function blocks(text: string, onNavigate?: () => void): ReactNode[] {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  const inl = (s: string) => inline(s, onNavigate);
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.trim().startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) code.push(lines[i++]!);
      i++;
      out.push(<pre key={out.length}>{code.join("\n")}</pre>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(h[1]!.length + 2, 6);
      const Tag = `h${level}` as "h3";
      out.push(<Tag key={out.length}>{inl(h[2]!)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      const cells = (l: string) =>
        l
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!));
      out.push(
        <div key={out.length} className="md-table">
          <table>
            <thead>
              <tr>
                {head.map((c, k) => (
                  <th key={k}>{inl(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, k) => (
                <tr key={k}>
                  {r.map((c, n) => (
                    <td key={n}>{inl(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/;
    const numbered = /^\s*\d+[.)]\s+(.*)$/;
    if (bullet.test(line) || numbered.test(line)) {
      const re = bullet.test(line) ? bullet : numbered;
      const items: string[] = [];
      while (i < lines.length && (re.test(lines[i]!) || (/^\s{2,}\S/.test(lines[i]!) && items.length))) {
        const m = re.exec(lines[i]!);
        if (m) items.push(m[1]!);
        else items[items.length - 1] += ` ${lines[i]!.trim()}`;
        i++;
      }
      const List = re === bullet ? "ul" : "ol";
      out.push(
        <List key={out.length}>
          {items.map((it, k) => (
            <li key={k}>{inl(it)}</li>
          ))}
        </List>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|```|\s*[-*•]\s|\s*\d+[.)]\s|\s*\|)/.test(lines[i]!)) para.push(lines[i++]!);
    if (!para.length) para.push(lines[i++]!);
    out.push(
      <p key={out.length}>
        {para.map((p, k) => (
          <Fragment key={k}>
            {k > 0 && <br />}
            {inl(p)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return out;
}

const INLINE = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_)/g;

function inline(text: string, onNavigate?: () => void): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const k = out.length;
    if (m[2] !== undefined) out.push(<strong key={k}>{inline(m[2], onNavigate)}</strong>);
    else if (m[3] !== undefined) out.push(<code key={k}>{m[3]}</code>);
    else if (m[4] !== undefined) out.push(link(m[4], m[5]!, k, onNavigate));
    else out.push(<em key={k}>{m[6] ?? m[7]}</em>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function link(label: string, url: string, key: number, onNavigate?: () => void): ReactNode {
  if (url.startsWith("/") && !url.startsWith("//"))
    return (
      <Link key={key} to={url} onClick={onNavigate}>
        {label}
      </Link>
    );
  if (/^https?:\/\//i.test(url))
    return (
      <a key={key} href={url} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    );
  return <Fragment key={key}>{label}</Fragment>;
}
