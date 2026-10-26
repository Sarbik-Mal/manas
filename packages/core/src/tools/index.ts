import { edit } from "./edit";
import { glob, grep, read } from "./files";
import { powershell } from "./powershell";
import type { Tool } from "./registry";
import { write } from "./write";

// Every tool the core has, in a fixed order (the `tools` list never changes
// within a session, for the prompt cache).
export const coreTools = (): Tool[] =>
	[read, edit, write, grep, glob, powershell] as Tool[];
