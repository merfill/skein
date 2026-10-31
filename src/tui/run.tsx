import { render } from "ink";
import React from "react";

import { TuiApp, type TuiAppProps } from "./app";

export async function runTui(props: TuiAppProps): Promise<void> {
  const alternate = process.stdout.isTTY === true;
  if (alternate) process.stdout.write("\u001b[?1049h\u001b[H");
  try {
    const instance = render(<TuiApp {...props} />, {
      exitOnCtrlC: false,
    });
    await instance.waitUntilExit();
  } finally {
    if (alternate) process.stdout.write("\u001b[?1049l");
  }
}
