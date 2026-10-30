import { askUser } from "./ask";
import { bashTool } from "./bash";
import { edit } from "./edit";
import { glob, grep, read } from "./files";
import { gitBash } from "./gitbash";
import { powershell } from "./powershell";
import type { Tool } from "./registry";
import { taskStop } from "./tasks";
import { write } from "./write";

// Every tool the core has, in a fixed order (the `tools` list never changes
// within a session, for the prompt cache). bash only with Git Bash (3.5).
export const coreTools = (bash = gitBash().path): Tool[] =>
	[
		read,
		edit,
		write,
		grep,
		glob,
		powershell,
		...(bash ? [bashTool(bash)] : []),
		taskStop,
		askUser,
	] as Tool[];
