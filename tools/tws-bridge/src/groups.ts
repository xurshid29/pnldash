/**
 * TWS's display groups, read back: which numbered group shows which ticker. The operator links
 * the TWS windows to a colour; the API knows the groups only by number, so this is how the
 * number for `displayGroup` is found without guessing.
 */

/** What TWS says a display group shows. */
export type GroupContent =
  | { kind: "none" }
  | { kind: "combo" }
  | { kind: "contract"; conid: number; exchange: string }
  /** Something TWS said that is none of the three documented forms. */
  | { kind: "other"; text: string };

/** Reads `"<conid>@<exchange>"`, `"none"` or `"combo"`. */
export function parseContractInfo(info: string): GroupContent {
  const text = info.trim();
  if (text === "" || text.toLowerCase() === "none") return { kind: "none" };
  if (text.toLowerCase() === "combo") return { kind: "combo" };
  const match = /^(\d{1,12})(?:@(.*))?$/.exec(text);
  if (match !== null) {
    const conid = Number(match[1]);
    if (Number.isSafeInteger(conid) && conid > 0) return { kind: "contract", conid, exchange: match[2] ?? "" };
  }
  return { kind: "other", text };
}

/** One group as the bridge knows it at a given moment. */
export interface GroupReading {
  id: number;
  /** A ticker, `"<conid>@<exchange>"` while the ticker is not known, `"combo"`, or null for nothing. */
  shows: string | null;
  /** False when TWS has not said what the group shows. */
  answered: boolean;
}

function inUse(group: GroupReading): boolean {
  return group.answered && group.shows !== null;
}

/**
 * The console's lines about the groups: one line with every group, and a second one when the
 * configured group looks like the wrong one.
 *
 * The guess rests on one observation: a group no window is linked to shows nothing. So when
 * exactly one group shows something, that is where the linked windows are.
 */
export function describeDisplayGroups(configured: number, groups: GroupReading[]): string[] {
  const sorted = [...groups].sort((a, b) => a.id - b.id);
  if (sorted.length === 0) {
    return [`display groups: TWS lists none (displayGroup is ${configured}: /focus may change no window)`];
  }

  const used = sorted.filter(inUse);
  const only = used.length === 1 ? used[0] : undefined;
  const parts = sorted.map((group) => {
    const what = !group.answered ? "no answer" : group.shows === null ? "nothing" : group.shows === "combo" ? "a combo" : group.shows;
    return `${group.id} ${what}${group === only ? " ← windows are linked here" : ""}`;
  });
  const lines = [`display groups: ${parts.join(" · ")}`];

  const mine = sorted.find((group) => group.id === configured);
  const advice = (id: number): string => `set "displayGroup": ${id} in config.json and restart`;
  if (mine === undefined) {
    lines.push(
      only !== undefined
        ? `displayGroup is ${configured} but TWS lists no such group, and the linked windows look like group ${only.id}: ${advice(only.id)}`
        : `displayGroup is ${configured} but TWS lists no such group: set "displayGroup" to one of the groups above in config.json and restart`,
    );
  } else if (mine.answered && mine.shows === null) {
    if (only !== undefined) {
      lines.push(`displayGroup is ${configured} but the linked windows look like group ${only.id}: ${advice(only.id)}`);
    } else if (used.length > 1) {
      lines.push(
        `displayGroup is ${configured}, which shows nothing: the linked windows are in one of the groups that show a ticker ` +
          `(${used.map((group) => group.id).join(", ")})`,
      );
    }
  }
  return lines;
}
