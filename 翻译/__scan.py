import os, re, subprocess

root = "."
files = []
for base in ("core", "views", "tests"):
    for dirpath, _, names in os.walk(base):
        for n in names:
            if n.endswith((".ts", ".tsx")):
                files.append(os.path.join(dirpath, n))
for n in ("index.tsx", "intent.tsx", "translation_ui_provider.tsx", "__preview-screen-result.tsx", "__preview-screen-result-b.tsx"):
    if os.path.exists(n): files.append(n)

content = {}
for f in files:
    with open(f, encoding="utf-8") as fh:
        content[f] = fh.read()

core_files = [f for f in files if f.startswith("core/")]
pat = re.compile(r"^export\s+(?:async\s+|default\s+)?(?:function|class|const|type|interface|enum)\s+([A-Za-z0-9_]+)", re.M)

for f in sorted(core_files):
    for m in pat.finditer(content[f]):
        name = m.group(1)
        line = content[f][:m.start()].count("\n") + 1
        # word-boundary usage in other files
        pat2 = re.compile(r"\b" + re.escape(name) + r"\b")
        ext, tests = [], []
        for other, txt in content.items():
            if other == f: continue
            hits = len(pat2.findall(txt))
            if hits:
                (tests if other.startswith("tests/") else ext).append(f"{other}({hits})")
        print(f"{f}:{line}\t{name}\text={','.join(ext) or '-'}\ttests={','.join(tests) or '-'}")
