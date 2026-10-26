// Slash commands of the plain CLI. Anything else starting with "/" is
// unknown, and never sent to the model.
export type Command =
	| { name: "help" | "exit" | "clear" | "doctor" }
	| { name: "model" | "effort"; arg?: string }
	| { name: "unknown"; text: string };

const SIMPLE = new Set(["help", "exit", "clear", "doctor"]);

// undefined: the line is a prompt, not a command.
export function parseCommand(line: string): Command | undefined {
	const text = line.trim();
	if (!/^\/\S/.test(text)) return undefined;
	const [word, arg] = text.slice(1).split(/\s+/);
	if (SIMPLE.has(word)) return { name: word as "help" };
	if (word === "model" || word === "effort") return { name: word, arg };
	return { name: "unknown", text: `/${word}` };
}

export const HELP = `Keys
  Enter          send
  \\ then Enter   new line
  Up / Down      earlier prompts (this run)
  Esc            stop the current reply (work so far is kept)
  Ctrl+C         clear the input, or stop the reply; twice to quit
  Ctrl+D         quit (on an empty input)

Commands
  /model [name]     show or switch the model
  /effort [level]   show or switch the reasoning effort ("default" resets it)
  /clear            start a new conversation
  /doctor           check the setup
  /help             this help
  /exit             quit`;
