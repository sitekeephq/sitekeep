import type { NavIconName } from "../../app/navigation/nav";

const ICON_PATHS: Record<NavIconName, string> = {
  today: "M4 7h16v13H4zM4 11h16M8 3v4M16 3v4M8 15h3",
  works: "M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v6H3v-6z",
  files: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  reviews: "M9 12l2 2 4-4M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  spec: "M14 3H6v18h12V7zM14 3v4h4M9 12h6M9 16h4",
  model: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5",
  coordination: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  issues: "M12 8v5M12 16.5v.5M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  forms: "M9 4h6v3H9zM7 5H5v16h14V5h-2M8 12h8M8 16h5",
  locations: "M12 21s7-6.2 7-11.5a7 7 0 0 0-14 0C5 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  schedule: "M4 6h9M7 11h10M10 16h10M4 3v18",
  reports: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  ask: "M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
  fold: "M11 17l-5-5 5-5M18 17l-5-5 5-5",
  chevron: "M9 6l6 6-6 6",
  menu: "M4 6h16M4 12h16M4 18h16",
  letters: "M4 6h16v12H4zM4 7l8 6 8-6",
  meetings: "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20c0-3 3-5 6-5s6 2 6 5M14 15.5c.6-.3 1.3-.5 2-.5 3 0 6 2 6 5",
  rfi: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17v.5",
  submittals: "M5 4h10l4 4v12H5zM9 13l2 2 4-4",
  transmittals: "M4 12l16-8-6 16-2-6zM12 14l8-10",
  plus: "M12 5v14M5 12h14",
  filter: "M4 5h16l-6 8v5l-4 2v-7z",
  star: "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z",
  upload: "M12 16V4M7 9l5-5 5 5M4 20h16",
};

export function NavIcon({ name, size = 18 }: { name: NavIconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="nav-icon"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
