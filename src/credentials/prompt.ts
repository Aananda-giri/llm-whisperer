import readline from "node:readline";
import { readFileSync } from "node:fs";
import { stdin as input, stdout as output } from "node:process";

let pipedLines: string[] | null = null;

/** Lazily read all of stdin once and return the next line (non-TTY only). */
function nextPipedLine(): string {
  if (pipedLines === null) {
    pipedLines = readFileSync(0, "utf8").split(/\r?\n/);
  }
  return pipedLines.shift() ?? "";
}

/**
 * Prompt for a line of input. When `hidden` is set the keystrokes are masked
 * with `*` (used for passwords). Hand-rolled so we don't pull in an echo-off
 * dependency.
 *
 * On a TTY it reads one line interactively. On a pipe (scripted `wspr creds
 * set`) it consumes sequential lines from stdin, so `printf "email\npass\n" |
 * wspr creds set …` works.
 */
export function prompt(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    if (!input.isTTY) {
      output.write(question);
      resolve(nextPipedLine().trim());
      return;
    }

    if (hidden) {
      readline.emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume();
      output.write(question);

      let value = "";
      const onKey = (_s: string, key: { sequence?: string; name?: string; ctrl?: boolean }) => {
        if (key.ctrl && key.name === "c") {
          done("");
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          done(value);
          return;
        }
        if (key.name === "backspace") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
          return;
        }
        if (key.sequence) {
          value += key.sequence;
          output.write("*");
        }
      };
      const done = (result: string) => {
        input.setRawMode(false);
        output.write("\n");
        input.removeListener("keypress", onKey);
        resolve(result);
      };
      input.on("keypress", onKey);
      return;
    }

    const rl = readline.createInterface({ input, output });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
