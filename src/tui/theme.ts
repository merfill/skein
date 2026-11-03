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
  blockBg: string;
  activeBg: string;
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
  text: "#eeeeee",
  strong: "#eeeeee",
  muted: "#808080",
  heading: "#9d7cd8",
  headingStrong: "#9d7cd8",
  code: "#7fd88f",
  link: "#fab283",
  border: "#484848",
  borderFocus: "#606060",
  selectedBg: "#282828",
  panelBg: "#141414",
  blockBg: "#1e1e1e",
  activeBg: "#141414",
  success: "#7fd88f",
  warning: "#f5a742",
  error: "#e06c75",
  user: "#fab283",
  state: "#9d7cd8",
  report: "#7fd88f",
  syntax: {
    keyword: "#9d7cd8",
    builtin: "#fab283",
    type: "#e5c07b",
    literal: "#f5a742",
    number: "#f5a742",
    string: "#7fd88f",
    comment: "#808080",
    function: "#fab283",
    variable: "#e06c75",
    attr: "#fab283",
    property: "#fab283",
    tag: "#9d7cd8",
    operator: "#56b6c2",
    punctuation: "#eeeeee",
    addition: "#4fd6be",
    deletion: "#c53b53",
  },
};

const light: Theme = {
  text: "#1a1a1a",
  strong: "#1a1a1a",
  muted: "#8a8a8a",
  heading: "#d68c27",
  headingStrong: "#d68c27",
  code: "#3d9a57",
  link: "#3b7dd8",
  border: "#b8b8b8",
  borderFocus: "#a0a0a0",
  selectedBg: "#ebebeb",
  panelBg: "#fafafa",
  blockBg: "#f5f5f5",
  activeBg: "#ffffff",
  success: "#3d9a57",
  warning: "#d68c27",
  error: "#d1383d",
  user: "#3b7dd8",
  state: "#d68c27",
  report: "#3d9a57",
  syntax: {
    keyword: "#d68c27",
    builtin: "#3b7dd8",
    type: "#b0851f",
    literal: "#d68c27",
    number: "#d68c27",
    string: "#3d9a57",
    comment: "#8a8a8a",
    function: "#3b7dd8",
    variable: "#d1383d",
    attr: "#3b7dd8",
    property: "#3b7dd8",
    tag: "#d68c27",
    operator: "#318795",
    punctuation: "#1a1a1a",
    addition: "#1e725c",
    deletion: "#c53b53",
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
