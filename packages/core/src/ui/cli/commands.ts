// Slash commands of the plain CLI. Anything else starting with "/" is
// unknown, and never sent to the model.
export type Command =
	| {
			name:
				| "help"
				| "exit"
				| "clear"
				| "doctor"
				| "resume"
				| "rewind"
				| "tasks";
	  }
	| { name: "model" | "effort" | "mode"; arg?: string }
	| { name: "unknown"; text: string };

const SIMPLE = new Set([
	"help",
	"exit",
	"clear",
	"doctor",
	"resume",
	"rewind",
	"tasks",
]);

// undefined: the line is a prompt, not a command.
export function parseCommand(line: string): Command | undefined {
	const text = line.trim();
	if (!/^\/\S/.test(text)) return undefined;
	const [word, arg] = text.slice(1).split(/\s+/);
	if (SIMPLE.has(word)) return { name: word as "help" };
	if (word === "model" || word === "effort" || word === "mode")
		return { name: word, arg };
	return { name: "unknown", text: `/${word}` };
}

export const HELP = `Keys
  Enter          send
  \\ then Enter   new line
  Up / Down      earlier prompts (this run)
  Esc            stop the current reply (work so far is kept)
  Esc Esc        rewind (on an empty input)
  Ctrl+C         clear the input, or stop the reply; twice to quit
  Ctrl+D         quit (on an empty input)
  Shift+Tab      switch mode: vibe-check (asks before edits) / lowkey
  Ctrl+B         move the running command to the background

Commands
  /model [name]     show or switch the model
  /effort [level]   show or switch the reasoning effort ("default" resets it)
  /mode [name]      show or switch the mode (vibe-check, lowkey)
  /clear            start a new conversation
  /resume           pick a saved conversation to continue
  /rewind           go back to an earlier prompt: code, conversation or both
  /tasks            list background commands, and stop one
  /doctor           check the setup
  /help             this help
  /exit             quit`;
