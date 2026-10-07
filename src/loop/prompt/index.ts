import { PROMPT_BLOCKS } from "./blocks";

export { PROMPT_BLOCKS, type PromptBlock } from "./blocks";

// The assembled system prompt: the behavior blocks in order, separated by a blank line.
// tests/prompt.test.ts checks that this is exactly the concatenation of PROMPT_BLOCKS.
export const SYSTEM_PROMPT = PROMPT_BLOCKS.map((block) => block.text).join("\n\n");
