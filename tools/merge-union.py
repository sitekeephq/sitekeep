# Resolves merge conflicts by keeping BOTH sides (ours, then theirs) in the given files.
# Meant only for "registration line" conflicts where two branches each added lines to the same
# list (app.ts route registrations, schema.ts exports, packages/shared/src/index.ts, api.ts,
# styles.css). Always review the result: a missing "}," or ";" between the two sides has to be
# fixed by hand, then build and test.
#
# Usage: python tools/merge-union.py apps/server/src/app.ts packages/shared/src/index.ts
import re, sys
for p in sys.argv[1:]:
    s = open(p, encoding="utf-8", newline="").read()
    pat = re.compile(r"<<<<<<< [^\n]*\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n", re.S)
    s2 = pat.sub(lambda m: m.group(1) + m.group(2), s)
    open(p, "w", encoding="utf-8", newline="").write(s2)
    print(p, "resolved" if "<<<<<<<" not in s2 else "STILL CONFLICTED")
