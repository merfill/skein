// Renders bench/harbor/skein.template.yaml into bench/harbor/skein.yaml,
// substituting the absolute Skein project path. The generated file is
// gitignored; the RouterAI key is never written here — it is passed to Harbor
// through OPENAI_API_KEY (forwarded into the container by the langgraph agent).
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
// Keep job results outside the repository: the langgraph agent stages the whole
// project before upload, so a jobs_dir inside it would recursively include itself.
const jobs = join(homedir(), ".skein-bench", "harbor");
const template = readFileSync(resolve(here, "skein.template.yaml"), "utf8");
const rendered = template
  .replaceAll("__SKEIN_PROJECT__", repo)
  .replaceAll("__SKEIN_JOBS__", jobs);
writeFileSync(resolve(here, "skein.yaml"), rendered);
console.log(`wrote ${resolve(here, "skein.yaml")}`);
