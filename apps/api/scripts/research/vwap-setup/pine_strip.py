"""A comment-free copy of the Pine script, for TradingView's MCP (docs/vwap-setup.md §19).

The MCP's Pine tools take the code as a tool argument, so the whole script has to be sent
with every compile check. The script is about 120 KB, 40% of it comments; this writes a
copy that compiles to the same thing at about 71 KB.

  python3 -I -B pine_strip.py <in.pine> <out.pine> [<compact.pine>]

<out.pine>      comments removed, line numbers kept (a comment line becomes an empty line),
                so the compiler's messages point at the original's lines.
<compact.pine>  the same without the empty lines, plus <compact.pine>.map.json: a list where
                item i is the original line number of compact line i + 1. Send this one and
                map a message's line back with the list.

Strings are left as they are (a `//` inside a string is not a comment). Line 1,
`//@version=6`, is a compiler directive and is kept.
"""
import json
import sys


def strip_line(line: str) -> str:
    out = []
    quote = None
    i = 0
    while i < len(line):
        ch = line[i]
        if quote:
            out.append(ch)
            if ch == "\\" and i + 1 < len(line):
                out.append(line[i + 1])
                i += 2
                continue
            if ch == quote:
                quote = None
        else:
            if ch in ('"', "'"):
                quote = ch
                out.append(ch)
            elif ch == "/" and line[i + 1:i + 2] == "/":
                break
            else:
                out.append(ch)
        i += 1
    return "".join(out).rstrip()


def main() -> None:
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    src, dst = sys.argv[1], sys.argv[2]
    lines = open(src, encoding="utf-8").read().split("\n")
    kept = [line if n == 0 else strip_line(line) for n, line in enumerate(lines)]
    while kept and kept[-1] == "":
        kept.pop()
    text = "\n".join(kept) + "\n"
    open(dst, "w", encoding="utf-8").write(text)
    empty = sum(1 for k in kept if k == "")
    print(f"{src}: {len(lines)} lines, {len(chr(10).join(lines).encode())} bytes"
          f" -> {len(kept)} lines ({empty} empty), {len(text.encode())} bytes")
    if len(sys.argv) > 3:
        pairs = [(n + 1, k) for n, k in enumerate(kept) if k != ""]
        compact = "\n".join(k for _, k in pairs) + "\n"
        open(sys.argv[3], "w", encoding="utf-8").write(compact)
        json.dump([n for n, _ in pairs], open(sys.argv[3] + ".map.json", "w"))
        print(f"compact: {len(pairs)} lines, {len(compact.encode())} bytes; line map in {sys.argv[3]}.map.json")


if __name__ == "__main__":
    main()
