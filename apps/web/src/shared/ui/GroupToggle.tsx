/** Plus / minus control for a grouped list header, and the open-all / close-all bar above it. */

export function GroupBar({
  expandLabel,
  collapseLabel,
  onExpand,
  onCollapse,
}: {
  expandLabel: string;
  collapseLabel: string;
  onExpand(): void;
  onCollapse(): void;
}) {
  return (
    <div className="work-group-bar">
      <button type="button" className="ghost small" onClick={onExpand}>
        <Sign open={false} />
        {expandLabel}
      </button>
      <button type="button" className="ghost small" onClick={onCollapse}>
        <Sign open />
        {collapseLabel}
      </button>
    </div>
  );
}

export function GroupButton({
  open,
  label,
  count,
  expandLabel,
  collapseLabel,
  onToggle,
}: {
  open: boolean;
  label: string;
  count: number;
  expandLabel: string;
  collapseLabel: string;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      className="work-group-btn"
      aria-expanded={open}
      aria-label={open ? collapseLabel : expandLabel}
      onClick={onToggle}
    >
      <span className="work-group-mark">
        <Sign open={open} />
      </span>
      <span className="work-group-name">{label}</span>
      <span className="work-group-count">{count}</span>
    </button>
  );
}

function Sign({ open }: { open: boolean }) {
  return (
    <svg className="work-group-sign" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 12h12" />
      {!open && <path d="M12 6v12" />}
    </svg>
  );
}
