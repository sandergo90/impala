import { StreamLanguage, type StreamParser } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

// Bicep / .bicepparam keywords (declaration + contextual). There is no
// CodeMirror lang package for Bicep, so it's tokenized with a StreamLanguage
// like the `dotenv` case below.
const BICEP_KEYWORDS = new Set([
  "resource", "module", "param", "var", "output", "targetScope", "metadata",
  "type", "func", "import", "using", "provider", "existing", "if", "for",
  "in", "assert", "extends", "with", "as",
]);

async function loadLegacyLanguage(
  loader: () => Promise<Record<string, unknown>>,
  key: string,
): Promise<Extension> {
  const mod = await loader();
  return StreamLanguage.define(mod[key] as StreamParser<unknown>);
}

export async function loadLanguageSupport(
  language: string,
): Promise<Extension | null> {
  switch (language) {
    case "typescript":
    case "javascript": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript({ typescript: language === "typescript", jsx: true });
    }
    case "json": {
      const { json } = await import("@codemirror/lang-json");
      return json();
    }
    case "html": {
      const { html } = await import("@codemirror/lang-html");
      return html();
    }
    case "css": {
      const { css } = await import("@codemirror/lang-css");
      return css();
    }
    case "markdown": {
      const { markdown } = await import("@codemirror/lang-markdown");
      return markdown();
    }
    case "yaml": {
      const { yaml } = await import("@codemirror/lang-yaml");
      return yaml();
    }
    case "xml": {
      const { xml } = await import("@codemirror/lang-xml");
      return xml();
    }
    case "python": {
      const { python } = await import("@codemirror/lang-python");
      return python();
    }
    case "rust": {
      const { rust } = await import("@codemirror/lang-rust");
      return rust();
    }
    case "sql": {
      const { sql } = await import("@codemirror/lang-sql");
      return sql();
    }
    case "php": {
      const { php } = await import("@codemirror/lang-php");
      return php();
    }
    case "java": {
      const { java } = await import("@codemirror/lang-java");
      return java();
    }
    case "c":
    case "cpp": {
      const { cpp } = await import("@codemirror/lang-cpp");
      return cpp();
    }
    case "go": {
      const { go } = await import("@codemirror/lang-go");
      return go();
    }
    case "shell":
      return loadLegacyLanguage(() => import("@codemirror/legacy-modes/mode/shell"), "shell");
    case "dockerfile":
      return loadLegacyLanguage(() => import("@codemirror/legacy-modes/mode/dockerfile"), "dockerFile");
    case "toml":
      return loadLegacyLanguage(() => import("@codemirror/legacy-modes/mode/toml"), "toml");
    case "ruby":
      return loadLegacyLanguage(() => import("@codemirror/legacy-modes/mode/ruby"), "ruby");
    case "swift":
      return loadLegacyLanguage(() => import("@codemirror/legacy-modes/mode/swift"), "swift");
    case "csharp":
      return loadLegacyLanguage(() => import("@codemirror/legacy-modes/mode/clike"), "csharp");
    case "kotlin":
      return loadLegacyLanguage(() => import("@codemirror/legacy-modes/mode/clike"), "kotlin");
    case "dotenv":
      return StreamLanguage.define({
        name: "dotenv",
        startState: () => ({ afterEquals: false }),
        token(stream, state) {
          if (stream.sol()) {
            state.afterEquals = false;
            stream.eatSpace();
            if (stream.peek() === "#") {
              stream.skipToEnd();
              return "comment";
            }
          }
          if (state.afterEquals) {
            stream.skipToEnd();
            return "string";
          }
          if (stream.eat("=")) {
            state.afterEquals = true;
            return "operator";
          }
          if (stream.eatWhile(/[^=\s]/)) return "property";
          stream.next();
          return null;
        },
      });
    case "bicep":
      return StreamLanguage.define({
        name: "bicep",
        startState: () => ({ inComment: false, inString: false }),
        token(stream, state) {
          // Continue a block comment opened on a previous line.
          if (state.inComment) {
            if (stream.skipTo("*/")) {
              stream.match("*/");
              state.inComment = false;
            } else {
              stream.skipToEnd();
            }
            return "comment";
          }
          // Continue a multi-line string ('''...''') opened earlier.
          if (state.inString) {
            if (stream.skipTo("'''")) {
              stream.match("'''");
              state.inString = false;
            } else {
              stream.skipToEnd();
            }
            return "string";
          }
          if (stream.eatSpace()) return null;

          if (stream.match("//")) {
            stream.skipToEnd();
            return "comment";
          }
          if (stream.match("/*")) {
            if (stream.skipTo("*/")) stream.match("*/");
            else {
              stream.skipToEnd();
              state.inComment = true;
            }
            return "comment";
          }

          if (stream.match("'''")) {
            if (stream.skipTo("'''")) stream.match("'''");
            else {
              stream.skipToEnd();
              state.inString = true;
            }
            return "string";
          }
          if (stream.eat("'")) {
            let escaped = false;
            while (!stream.eol()) {
              const ch = stream.next();
              if (ch === "'" && !escaped) break;
              escaped = ch === "\\" && !escaped;
            }
            return "string";
          }

          // Decorators: @secure(), @description('...'), ...
          if (stream.match(/^@[A-Za-z_]\w*/)) return "variableName.function";

          if (stream.match(/^\d+/)) return "number";

          const first = stream.peek();
          if (first && /[A-Za-z_]/.test(first)) {
            const start = stream.pos;
            stream.eatWhile(/[A-Za-z0-9_]/);
            const word = stream.string.slice(start, stream.pos);
            if (BICEP_KEYWORDS.has(word)) return "keyword";
            if (word === "true" || word === "false") return "bool";
            if (word === "null") return "null";
            return null;
          }

          stream.next();
          return null;
        },
      });
    case "plaintext":
    default:
      return null;
  }
}
