import fs from "node:fs";
import path from "node:path";

/**
 * state.json: what the bridge was told at run time and must remember across a restart (the
 * automatic mode, and where the alert feed is). Settings the owner edits by hand stay in
 * config.json; this file is written by the bridge alone.
 */

export type AutoMode = "off" | "watch" | "on";

export interface BridgeState {
  auto: { mode: AutoMode };
  /** Where the alert feed is and the token for it; null until the dashboard has paired the bridge. */
  feed: { server: string; token: string } | null;
}

const AUTO_MODES: readonly AutoMode[] = ["off", "watch", "on"];

/** Far longer than any token the server hands out; a longer value is not a token but a mistake. */
const MAX_TOKEN_LENGTH = 2048;

export function defaultState(): BridgeState {
  return { auto: { mode: "off" }, feed: null };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An http(s) origin exactly as written: scheme://host[:port], no path, no trailing slash. */
export function isFeedServer(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

export function isFeedToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TOKEN_LENGTH;
}

/**
 * Checks the parsed file part by part: a part that is wrong takes its default (the automatic
 * mode "off", no feed) and the others are kept. Missing parts take their default quietly, so a
 * file written before a part existed still loads. The problems never quote a value: the token
 * may sit in the wrong place.
 */
function readState(raw: unknown, problems: string[]): BridgeState {
  const state = defaultState();
  if (!isPlainObject(raw)) {
    problems.push("it does not hold a JSON object");
    return state;
  }

  if ("auto" in raw) {
    const auto = raw["auto"];
    if (!isPlainObject(auto)) problems.push("auto must be an object");
    else if (!AUTO_MODES.includes(auto["mode"] as AutoMode)) problems.push(`auto.mode must be "off", "watch" or "on"`);
    else state.auto.mode = auto["mode"] as AutoMode;
  }

  if ("feed" in raw && raw["feed"] !== null) {
    const feed = raw["feed"];
    if (!isPlainObject(feed)) {
      problems.push("feed must be an object or null");
    } else {
      const wrong: string[] = [];
      if (!isFeedServer(feed["server"])) wrong.push("feed.server is not an http(s) origin (scheme://host[:port], no path)");
      if (!isFeedToken(feed["token"])) wrong.push(`feed.token is not a string of 1 to ${MAX_TOKEN_LENGTH} characters`);
      if (wrong.length > 0) problems.push(...wrong);
      else state.feed = { server: feed["server"] as string, token: feed["token"] as string };
    }
  }
  return state;
}

/**
 * Reads state.json. A missing file is the defaults. A file that cannot be read, is not JSON or
 * has a wrong part gives the defaults for what is wrong and says so in `problem`; the file is
 * left as it is (the next save replaces it). Unknown keys are ignored.
 */
export function loadState(file: string): { state: BridgeState; problem: string | null } {
  const name = path.basename(file);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: defaultState(), problem: null };
    const code = (err as NodeJS.ErrnoException).code;
    return { state: defaultState(), problem: `${name} cannot be read (${code ?? (err instanceof Error ? err.message : String(err))})` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Not the parser's message: it quotes the text around the mistake, which may be the token.
    return { state: defaultState(), problem: `${name} is not valid JSON` };
  }
  const problems: string[] = [];
  const state = readState(raw, problems);
  return { state, problem: problems.length === 0 ? null : `${name}: ${problems.join("; ")}` };
}

/**
 * Writes state.json through `<file>.tmp` and a rename, owner-only, so a crash mid-write leaves
 * the old file whole. A state that loadState would not take back is refused here instead of
 * being saved and then dropped at the next start. Throws on failure.
 */
export function saveState(file: string, state: BridgeState): void {
  const problems: string[] = [];
  const checked = readState(state, problems);
  if (problems.length > 0) throw new Error(`the bridge state was not saved: ${problems.join("; ")}`);
  const tmp = `${file}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, `${JSON.stringify(checked, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
