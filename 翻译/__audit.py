import os, re, sys, collections

ROOT = "/var/mobile/Library/Mobile Documents/iCloud~com~thomfang~Scripting/Documents/scripts/翻译"
SKIP = {"node_modules", ".git", "memory", "tests", "assets"}
files = []
for base, dirs, names in os.walk(ROOT):
    dirs[:] = [d for d in dirs if d not in SKIP]
    for n in names:
        if n.endswith((".ts", ".tsx")) and not n.startswith("__"):
            files.append(os.path.join(base, n))
files.sort()
src = {f: open(f, encoding="utf-8", errors="replace").read() for f in files}

print("=== import statements among core modules ===")
for f, s in src.items():
    for line in s.splitlines():
        if re.search(r'from\s+["\']\./(?:core/)?(appraven|price-history|screen-translation|github-profile|github-readme|translation-snapshot)', line):
            print(os.path.relpath(f, ROOT), "|", line.strip())

print("\n=== local top-level decls with 0 other refs in own file (non-export) ===")
decl_re = re.compile(r'^(?:export\s+)?(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+([A-Za-z0-9_$]+)', re.M)
for f, s in src.items():
    for m in decl_re.finditer(s):
        name = m.group(1)
        line_start = s.rfind('\n', 0, m.start()) + 1
        if 'export' in s[line_start:m.start()]:
            continue
        c = len(re.findall(r'(?<![A-Za-z0-9_$.])' + re.escape(name) + r'(?![A-Za-z0-9_$])', s))
        if c <= 1:
            print(os.path.relpath(f, ROOT), name)

print("\n=== export references by file ===")
export_re = re.compile(r'^export\s+(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+([A-Za-z0-9_$]+)', re.M)
exports = collections.defaultdict(list)
for f, s in src.items():
    for m in export_re.finditer(s):
        exports[m.group(1)].append(f)
    for m in re.finditer(r'^export\s*\{([^}]*)\}', s, re.M):
        for part in m.group(1).split(','):
            name = part.strip().split(' as ')[-1].strip()
            if name:
                exports[name].append(f)
for name, defs in sorted(exports.items()):
    refs = []
    pat = re.compile(r'(?<![A-Za-z0-9_$.])' + re.escape(name) + r'(?![A-Za-z0-9_$])')
    for f, s in src.items():
        if f in defs:
            continue
        c = len(pat.findall(s))
        if c:
            refs.append(f"{os.path.relpath(f, ROOT)}x{c}")
    print(f"{name}\t{os.path.relpath(defs[0], ROOT)}\t{', '.join(refs) if refs else '-- NONE --'}")
