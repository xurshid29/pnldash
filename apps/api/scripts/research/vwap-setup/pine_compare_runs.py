"""Compare two runs of the Pine script on TradingView, plot by plot (docs/vwap-setup.md §20.3).

Each input is the JSON result of the MCP's run_pine_indicator with format="columns" (the client
saves a result this large to a file under the session's tool-results folder). Run the old and
the new version on the same symbol, timeframe and bars, with the inputs set alike, then:

  python3 -I -B pine_compare_runs.py <old.json> <new.json>

Plots are matched by title, bars by time. Marks must be equal; lines equal to 1e-9 relative.
Prints the plots only one side has, and the first differences of any shared plot.
"""
import json
import sys


def load(path):
    d = json.load(open(path))
    v = d["values"]
    by_title = {}
    for p in d["metainfo"]["plots"]:
        by_title[p["title"]] = (p["type"], v["plots"].get(p["id"], []))
    return d, v["t"], by_title


def same(a, b):
    if a is None or b is None:
        return a is None and b is None
    if a == b:
        return True
    return abs(a - b) <= 1e-9 * max(1.0, abs(a), abs(b))


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    old_d, old_t, old_p = load(sys.argv[1])
    new_d, new_t, new_p = load(sys.argv[2])
    print("old: version", old_d.get("version"), "success", old_d.get("success"), "bars", len(old_t),
          "| new: version", new_d.get("version"), "success", new_d.get("success"), "bars", len(new_t))
    idx_old = {t: i for i, t in enumerate(old_t)}
    common = [(idx_old[t], j) for j, t in enumerate(new_t) if t in idx_old]
    print("bars in both runs:", len(common), "| only old:", len(old_t) - len(common), "| only new:", len(new_t) - len(common))
    bad = 0
    for title in [t for t in old_p if t in new_p]:
        typ, a = old_p[title]
        _, b = new_p[title]
        diffs = [(old_t[i], a[i], b[j]) for i, j in common if not same(a[i], b[j])]
        note = f"{sum(1 for i, _ in common if a[i])} marks" if typ == "shapes" else "line"
        if diffs:
            bad += 1
            print(f"  DIFF  {title} ({note}): {len(diffs)} bars differ; first {diffs[:3]}")
        else:
            print(f"  same  {title} ({note})")
    print("only in old:", [t for t in old_p if t not in new_p])
    print("only in new:", [t for t in new_p if t not in old_p])
    print("RESULT:", "all shared plots equal on every common bar" if bad == 0 else f"{bad} shared plots differ")
    sys.exit(0 if bad == 0 else 1)


if __name__ == "__main__":
    main()
