/**
 * Read a line with history (Up/Down) and Ctrl-R reverse search.
 * Uses raw mode; use only when stdin is TTY.
 */

export function readLineWithHistory(
  prompt: string,
  history: string[],
  options: { output?: NodeJS.WritableStream } = {}
): Promise<string> {
  const out = options.output ?? process.stdout;
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return import("readline").then((rl) => {
      const iface = rl.createInterface({ input: stdin, output: out });
      return new Promise<string>((resolve) => {
        iface.question(prompt, (line: string) => {
          iface.close();
          resolve((line ?? "").trim());
        });
      });
    });
  }

  return new Promise((resolve) => {
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let line = "";
    let historyIndex = -1;
    let searchMode = false;
    let searchQuery = "";
    let searchMatchIndex = -1;
    const matches: string[] = [];

    function draw(): void {
      const cursorSave = "\x1b[s";
      const cursorRestore = "\x1b[u";
      const clearToEnd = "\x1b[K";
      if (searchMode) {
        const match = matches[searchMatchIndex] ?? "";
        out.write(cursorSave + "\r" + clearToEnd + "(reverse-i-search)'" + searchQuery + "': " + match + cursorRestore);
      } else {
        out.write(cursorSave + "\r" + clearToEnd + prompt + line + cursorRestore);
      }
    }

    function exitRawMode(): void {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    }

    function accept(result: string): void {
      exitRawMode();
      out.write("\n");
      resolve(result);
    }

    function searchUpdate(): void {
      if (!searchQuery) {
        matches.length = 0;
        searchMatchIndex = -1;
        return;
      }
      const q = searchQuery.toLowerCase();
      matches.length = 0;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].toLowerCase().includes(q)) matches.push(history[i]);
      }
      searchMatchIndex = matches.length > 0 ? 0 : -1;
    }

    const onData = (chunk: string | Buffer): void => {
      const s = (typeof chunk === "string" ? chunk : chunk.toString("utf8")) as string;
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        const code = s.charCodeAt(i);
        if (searchMode) {
          if (c === "\r" || c === "\n") {
            const match = matches[searchMatchIndex];
            if (match !== undefined) {
              searchMode = false;
              accept(match);
            } else {
              searchMode = false;
              line = searchQuery;
              searchQuery = "";
              draw();
            }
            return;
          }
          if (code === 3) {
            searchMode = false;
            searchQuery = "";
            draw();
            return;
          }
          if (code === 8 || code === 127) {
            searchQuery = searchQuery.slice(0, -1);
            searchUpdate();
            draw();
            return;
          }
          if (code >= 32) {
            searchQuery += c;
            searchUpdate();
            draw();
            return;
          }
          if (c === "\x12") {
            searchMatchIndex = (searchMatchIndex + 1) % Math.max(1, matches.length);
            draw();
            return;
          }
          continue;
        }
        if (code === 3) {
          exitRawMode();
          out.write("^C\n");
          resolve("");
          return;
        }
        if (c === "\r" || c === "\n") {
          accept(line);
          return;
        }
        if (c === "\x12") {
          searchMode = true;
          searchQuery = line;
          searchUpdate();
          draw();
          return;
        }
        if (code === 8 || code === 127) {
          line = line.slice(0, -1);
          historyIndex = -1;
          draw();
          return;
        }
        if (c === "\x1b") {
          const seq = s.slice(i, i + 3);
          if (seq === "\x1b[A") {
            if (history.length === 0) { i += 2; continue; }
            if (historyIndex < history.length - 1) {
              historyIndex++;
              line = history[history.length - 1 - historyIndex] ?? "";
            }
            i += 2;
            draw();
            return;
          }
          if (seq === "\x1b[B") {
            if (historyIndex > 0) {
              historyIndex--;
              line = history[history.length - 1 - historyIndex] ?? "";
            } else if (historyIndex === 0) {
              historyIndex = -1;
              line = "";
            }
            i += 2;
            draw();
            return;
          }
          i += 2;
          continue;
        }
        if (code >= 32) {
          line += c;
          historyIndex = -1;
          draw();
        }
      }
    };

    stdin.on("data", onData);
    out.write(prompt);
  });
}
