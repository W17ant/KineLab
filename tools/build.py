"""build.py - build advanced.html from index.html plus every adv/*.js module, still a single file.

Usage:
  python3 tools/build.py                      # write advanced.html (index.html + every adv/*.js)
  python3 tools/build.py --only a,b --out X   # inline only adv/a.js and adv/b.js, write to X (for testing)

Why two files: index.html is the basic app and is what GitHub Pages serves, so students on the
public site never get the Advanced code. advanced.html is excluded from the site (_config.yml)
and run locally. index.html is never modified here; its module block stays empty.

Why markers: the block between them is regenerated each run, so the build is repeatable.
"""
import argparse, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
START, END = "<!-- @@ADVANCED_MODULES@@ -->", "<!-- @@END_ADVANCED_MODULES@@ -->"
GENERATED_NOTE = "<!-- Built by tools/build.py from index.html and adv/*.js. Edit those, not this file. -->"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="comma-separated module names (file stems in adv/)")
    ap.add_argument("--out", help="output path (default: index.html in place)")
    args = ap.parse_args()
    src = (ROOT / "index.html").read_text()
    if START not in src:
        sys.exit("index.html has no module marker")
    names = sorted(p.stem for p in (ROOT / "adv").glob("*.js"))
    if args.only:
        wanted = [n.strip() for n in args.only.split(",") if n.strip()]
        missing = [n for n in wanted if n not in names]
        if missing:
            sys.exit(f"no such module(s): {missing}")
        names = [n for n in names if n in wanted]
    blocks = []
    for n in names:
        code = (ROOT / "adv" / f"{n}.js").read_text().rstrip()
        if "</script" in code.lower():
            sys.exit(f"adv/{n}.js contains '</script', which would end the inline block")
        blocks.append(f'  <script data-module="{n}">\n{code}\n  </script>')
    generated = START + "\n" + "\n".join(blocks) + ("\n  " if blocks else "") + END
    if END in src:
        src = re.sub(re.escape(START) + r".*?" + re.escape(END), lambda m: generated, src, flags=re.S)
    else:
        src = src.replace(START, generated)
    src = src.replace("<!DOCTYPE html>", "<!DOCTYPE html>\n" + GENERATED_NOTE, 1)
    out = pathlib.Path(args.out) if args.out else ROOT / "advanced.html"
    out.write_text(src)
    print(f"inlined {len(names)} module(s) into {out}: {', '.join(names) or '-'}")

if __name__ == "__main__":
    main()
