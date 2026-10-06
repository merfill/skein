// Renders bench/harbor/*.template.yaml into concrete configs.
//
// - __SKEIN_PROJECT__ / __SKEIN_JOBS__ become the absolute project and jobs
//   paths. Jobs live outside the repository: the langgraph agent stages the
//   whole project before upload, so a jobs_dir inside it would recurse.
// - __ROUTERAI_API_KEY__ (used by the opencode agent, which needs the key in its
//   own config) is injected from the environment or the user's global opencode
//   config. The rendered files are gitignored, so the key is never committed.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const jobs = join(homedir(), ".skein-bench", "harbor");

function routeraiKey() {
  const fromEnv = process.env.ROUTERAI_API_KEY || process.env.OPENAI_API_KEY || process.env.SKEIN_API_KEY;
  if (fromEnv) return fromEnv;
  try {
    const globalConfig = JSON.parse(
      readFileSync(join(homedir(), ".config", "opencode", "opencode.json"), "utf8"),
    );
    return globalConfig?.provider?.routerai?.options?.apiKey ?? "";
  } catch {
    return "";
  }
}

const templates = ["skein.template.yaml", "compare.template.yaml"];
const key = routeraiKey();

for (const name of templates) {
  const template = readFileSync(resolve(here, name), "utf8");
  const rendered = template
    .replaceAll("__SKEIN_PROJECT__", repo)
    .replaceAll("__SKEIN_JOBS__", jobs)
    .replaceAll("__ROUTERAI_API_KEY__", key);
  const out = resolve(here, name.replace(/\.template\.yaml$/, ".yaml"));
  writeFileSync(out, rendered);
  console.log(`wrote ${out}`);
}

if (key === "") {
  console.error("warning: no RouterAI key found; the opencode agent will fail to authenticate");
}
