export interface Theme {
  text: string;
  strong: string;
  muted: string;
  heading: string;
  headingStrong: string;
  code: string;
  link: string;
  border: string;
  borderFocus: string;
  selectedBg: string;
  panelBg: string;
  success: string;
  warning: string;
  error: string;
  user: string;
  state: string;
  report: string;
  syntax: {
    keyword: string;
    builtin: string;
    type: string;
    literal: string;
    number: string;
    string: string;
    comment: string;
    function: string;
    variable: string;
    attr: string;
    property: string;
    tag: string;
    operator: string;
    punctuation: string;
    addition: string;
    deletion: string;
  };
}

const dark: Theme = {
  text: "#c9d1d9",
  strong: "#e6edf3",
  muted: "#7d8590",
  heading: "#9fb3c8",
  headingStrong: "#c3d1de",
  code: "#d6bd8a",
  link: "#8fb0c9",
  border: "#4b5563",
  borderFocus: "#7d94a8",
  selectedBg: "#2b3138",
  panelBg: "#1b1f24",
  success: "#8fbf9f",
  warning: "#d4b36a",
  error: "#cf8b8b",
  user: "#9cb6c9",
  state: "#b8a6c9",
  report: "#9fbfa8",
  syntax: {
    keyword: "#b48ead",
    builtin: "#8fb8c9",
    type: "#8fb8c9",
    literal: "#d6bd8a",
    number: "#d6bd8a",
    string: "#9fbf8f",
    comment: "#6b7785",
    function: "#8fb0c9",
    variable: "#c9d1d9",
    attr: "#d6bd8a",
    property: "#8fb8c9",
    tag: "#8fb0c9",
    operator: "#aab4be",
    punctuation: "#8b949e",
    addition: "#9fbf8f",
    deletion: "#cf8b8b",
  },
};

const light: Theme = {
  text: "#343b45",
  strong: "#20262e",
  muted: "#6b7280",
  heading: "#45627d",
  headingStrong: "#2f4a63",
  code: "#7a5a2e",
  link: "#3f6f9f",
  border: "#b8c0cc",
  borderFocus: "#6f879c",
  selectedBg: "#e5e9f0",
  panelBg: "#f4f6f8",
  success: "#3f7f5f",
  warning: "#8a6a2a",
  error: "#a84a4a",
  user: "#45627d",
  state: "#6f5a8a",
  report: "#3f7f5f",
  syntax: {
    keyword: "#8a5a8a",
    builtin: "#3f6f8f",
    type: "#3f6f8f",
    literal: "#7a5a2e",
    number: "#7a5a2e",
    string: "#3f7f4f",
    comment: "#7a828c",
    function: "#3f6f9f",
    variable: "#343b45",
    attr: "#7a5a2e",
    property: "#3f6f8f",
    tag: "#3f6f8f",
    operator: "#4a525c",
    punctuation: "#6b7280",
    addition: "#3f7f4f",
    deletion: "#a84a4a",
  },
};

function pick(): Theme {
  const explicit = process.env.SKEIN_THEME?.toLowerCase();
  if (explicit === "light") return light;
  if (explicit === "dark") return dark;
  const fgbg = process.env.COLORFGBG;
  if (fgbg !== undefined) {
    const bg = Number(fgbg.split(";").at(-1));
    if (bg === 7 || bg === 15) return light;
  }
  return dark;
}

export const theme: Theme = pick();
