#!/usr/bin/env python3
"""Write src/compile/keys.hpp: every K_ name used in src/compile, src/dev and src/kicad that value.hpp doesn't define."""
import glob, os, re

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
vh = open(os.path.join(root, 'src/value.hpp')).read()
existing = set(re.findall(r'X\((\w+)\)', re.search(r'#define STOMP_KEYS\(X\)(.*?)\n\n', vh, re.S).group(1)))
used = set()
for f in glob.glob(os.path.join(root, 'src/compile/*.[ch]pp')) + glob.glob(os.path.join(root, 'src/dev/*.[ch]pp')) + glob.glob(os.path.join(root, 'src/kicad*.[ch]pp')) + glob.glob(os.path.join(root, 'src/model3d*.[ch]pp')):
    used |= set(re.findall(r'\bK_(\w+)\b', open(f).read()))
new = sorted(used - existing)
lines, cur = [], '  '
for k in new:
    item = f'X({k}) '
    if len(cur) + len(item) > 110:
        lines.append(cur.rstrip() + ' \\')
        cur = '  '
    cur += item
lines.append(cur.rstrip())
body = '\n'.join(lines)
open(os.path.join(root, 'src/compile/keys.hpp'), 'w').write(f'''// Field names of the compiler's records beyond the AST's (value.hpp STOMP_KEYS). Generated
// from the K_ names used in src/compile, src/dev and src/kicad by tools/gen-keys.py; run it after adding one.
#ifndef STOMP_COMPILE_KEYS_HPP
#define STOMP_COMPILE_KEYS_HPP

#include "../value.hpp"

#define STOMP_CKEYS(X) \\
{body}

namespace stomp {{
#define STOMP_CKEY_DECL(n) extern const Key K_##n;
STOMP_CKEYS(STOMP_CKEY_DECL)
#undef STOMP_CKEY_DECL
}}  // namespace stomp

#endif  // STOMP_COMPILE_KEYS_HPP
''')
print(len(new), 'keys')
