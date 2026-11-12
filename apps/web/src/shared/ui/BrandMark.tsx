/**
 * SiteKeep mark (docs/brand/README.md): the four ISO 19650 states stacked, bottom to top WIP (grey),
 * Shared (amber), Published (green), Archive (navy) with a keyhole. Below 48 px the simpler favicon
 * drawing is used (three layers, no keyhole), as the brand guide asks. Same shapes as
 * public/brand/sitekeep-mark.svg and sitekeep-favicon.svg.
 */
export function BrandMark({ size = 28 }: { size?: number }) {
  if (size < 48) {
    return (
      <svg className="brand-mark" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
        <polygon points="10,64 50,84 50,100 10,80" fill="#F2A33A" />
        <polygon points="50,84 90,64 90,80 50,100" fill="#D9861C" />
        <polygon points="10,44 50,64 50,80 10,60" fill="#3B9A6B" />
        <polygon points="50,64 90,44 90,60 50,80" fill="#2E7D55" />
        <polygon points="50,4 90,24 50,44 10,24" fill="#2E5A8A" />
        <polygon points="10,24 50,44 50,60 10,40" fill="#1F3A5F" />
        <polygon points="50,44 90,24 90,40 50,60" fill="#162B47" />
      </svg>
    );
  }
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <polygon points="10,70 50,90 50,100 10,80" fill="#9AA5B1" />
      <polygon points="50,90 90,70 90,80 50,100" fill="#7D8995" />
      <polygon points="10,56 50,76 50,86 10,66" fill="#F2A33A" />
      <polygon points="50,76 90,56 90,66 50,86" fill="#D9861C" />
      <polygon points="10,42 50,62 50,72 10,52" fill="#3B9A6B" />
      <polygon points="50,62 90,42 90,52 50,72" fill="#2E7D55" />
      <polygon points="50,2 90,22 50,42 10,22" fill="#2E5A8A" />
      <polygon points="10,22 50,42 50,52 10,32" fill="#1F3A5F" />
      <polygon points="50,42 90,22 90,32 50,52" fill="#162B47" />
      <circle cx="50" cy="19" r="5" fill="#FFFFFF" />
      <polygon points="47,21 53,21 55,30 45,30" fill="#FFFFFF" />
    </svg>
  );
}

// The product name is not translated (docs/brand/README.md).
const SITE = "Site";
const KEEP = "Keep";

/** "SiteKeep" wordmark: "Site" in the text colour (navy on light, white on dark), "Keep" in amber. */
export function BrandName({ edition }: { edition?: string }) {
  return (
    <span className="brand-name">
      <span className="brand-name-site">{SITE}</span>
      <span className="brand-name-keep">{KEEP}</span>
      {edition && <span className="brand-edition">{edition}</span>}
    </span>
  );
}
