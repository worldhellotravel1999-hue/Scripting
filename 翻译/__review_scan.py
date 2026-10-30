import os, re, collections

ROOT = os.getcwd()
SKIP_DIRS = {'node_modules', '.git', 'memory', 'tests', 'assets'}
files = []
for base, dirs, names in os.walk(ROOT):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
    for n in names:
        if n.endswith(('.ts', '.tsx')) and not n.startswith('__'):
            files.append(os.path.join(base, n))
files.sort()

src = {f: open(f, encoding='utf-8', errors='replace').read() for f in files}

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

refs = collections.defaultdict(list)
for name, defs in exports.items():
    pat = re.compile(r'(?<![A-Za-z0-9_$.])' + re.escape(name) + r'(?![A-Za-z0-9_$])')
    for f, s in src.items():
        if f in defs:
            continue
        c = len(pat.findall(s))
        if c:
            refs[name].extend([f] * c)

dead = []
for name, defs in sorted(exports.items()):
    if not refs.get(name):
        dead.append((name, os.path.relpath(defs[0], ROOT)))

print('=== 无任何外部引用的导出 (%d) ===' % len(dead))
for n, f in dead:
    print('%s\t%s' % (f, n))