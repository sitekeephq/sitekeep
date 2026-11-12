const PATHS = {
  inbox: "M4 13h4l2 3h4l2-3h4M4 13l2-8h12l2 8v6H4z",
  folder: "M3 7h6l2 2h10v10H3zM3 7V5h6l2 2",
  file: "M7 3h7l4 4v14H7zM14 3v5h4",
  check: "M9 12l2 2 4-4M5 4h14v16H5z",
  form: "M8 4h8v3H8zM6 6H5v15h14V6h-1M8 12h8M8 16h5",
  cube: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9",
  layers: "M12 4l9 5-9 5-9-5zM3 14l9 5 9-5",
  flag: "M5 21V4M5 4h11l-2 4 2 4H5",
  alert: "M12 4 2.5 20h19zM12 10v4M12 17h.01",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  pin: "M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  chart: "M4 20h16M7 16v-5M12 16V7M17 16v-8",
  doc: "M7 3h7l4 4v14H7zM14 3v5h4M10 13h5M10 17h5",
  mail: "M4 6h16v12H4zM4 7l8 6 8-6",
  pen: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  eye: "M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6zM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  eyeOff: "M3 3l18 18M10.6 6.1c.5-.1.9-.1 1.4-.1 6 0 9.5 6 9.5 6a17 17 0 0 1-2.1 2.8M6.2 6.3C3.8 8 2.5 12 2.5 12s3.5 6 9.5 6c1.4 0 2.7-.3 3.8-.8M9.9 9.9a3 3 0 0 0 4.2 4.2",
  camera: "M4 8h3l2-3h6l2 3h3v11H4zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6",
  tour: "M12 4a8 8 0 1 0 5.5 14M16 4.8l4 1.2-1.2 4M12 8v4l3 2",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z",
  logout: "M10 5H6.8A1.8 1.8 0 0 0 5 6.8v10.4A1.8 1.8 0 0 0 6.8 19H10M15 8l4 4-4 4M19 12H9",
  copy: "M9 9h10v11H9zM5 15V4h10",
  tick: "M5 12.5l4.5 4.5L19 7.5",
  trash: "M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  plus: "M12 5v14M5 12h14",
  upload: "M12 16V4M7 9l5-5 5 5M5 15v3.2A1.8 1.8 0 0 0 6.8 20h10.4a1.8 1.8 0 0 0 1.8-1.8V15",
  download: "M12 4v12M7 11l5 5 5-5M5 15v3.2A1.8 1.8 0 0 0 6.8 20h10.4a1.8 1.8 0 0 0 1.8-1.8V15",
  search: "M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM20 20l-4.2-4.2",
  filter: "M4 5h16l-6 7.5V19l-4-2v-4.5z",
  folderPlus: "M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5zM12 11v5M9.5 13.5h5",
  lock: "M6.5 11h11v9h-11zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  refresh: "M20 11a8 8 0 0 0-14.6-4.5M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5M20 20v-4h-4",
  sort: "M8 18V6M4.5 9.5 8 6l3.5 3.5M16 6v12M12.5 14.5 16 18l3.5-3.5",
  sortUp: "M12 19V5M6.5 10.5 12 5l5.5 5.5",
  sortDown: "M12 5v14M6.5 13.5 12 19l5.5-5.5",
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" style={size ? { width: size, height: size } : undefined}>
      <path d={PATHS[name]} />
    </svg>
  );
}

const FILE_TONES: [string[], string][] = [
  [["pdf"], "pdf"],
  [["ifc", "rvt", "nwd", "nwc"], "model"],
  [["dwg", "dxf"], "cad"],
  [["xlsx", "xls", "csv"], "sheet"],
  [["docx", "doc"], "text"],
  [["png", "jpg", "jpeg"], "image"],
];

/** Compact extension tag ("PDF", "IFC"…) colour-coded by file family. */
export function FileTypeIcon({ ext }: { ext: string }) {
  const e = ext.toLowerCase();
  const tone = FILE_TONES.find(([list]) => list.includes(e))?.[1] ?? "other";
  return <span className={`file-type ${tone}`}>{(e || "file").slice(0, 4).toUpperCase()}</span>;
}
