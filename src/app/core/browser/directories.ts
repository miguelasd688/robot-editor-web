export type BrowserDirectoryId = "floors" | "robots" | "links" | "joints" | "workspace";

export type BrowserDirectory = {
  id: BrowserDirectoryId;
  title: string;
  icon: string;
  description: string;
};

export const BROWSER_DIRECTORIES: BrowserDirectory[] = [
  {
    id: "floors",
    title: "Floors",
    icon: "▦",
    description: "Grounding surfaces",
  },
  {
    id: "robots",
    title: "Robots",
    icon: "🤖",
    description: "Robot containers and presets",
  },
  {
    id: "links",
    title: "Links",
    icon: "🔗",
    description: "Bodies and primitive geometry",
  },
  {
    id: "joints",
    title: "Joints",
    icon: "⚙️",
    description: "Passive and actuated joints",
  },
  {
    id: "workspace",
    title: "Workspace",
    icon: "📁",
    description: "Directories panel mirror",
  },
];
