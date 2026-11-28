# Make ieee754.cc from V8's src/base/ieee754.cc (branch-heads/12.4, the V8 in Node 22):
# the functions stomp's engine uses, bodies unchanged, V8's macros replaced with C++20.
#   python3 -I trim.py PATH/TO/v8/src/base/ieee754.cc ieee754.cc
import re, sys

src = open(sys.argv[1]).read().split('\n')
WANT = ['__ieee754_rem_pio2', '__kernel_cos', '__kernel_rem_pio2', '__kernel_sin', '__kernel_tan',
        'acos', 'asin', 'atan', 'atan2', 'cos', 'sin', 'tan']

def find_def(name):
    pat = re.compile(r'^(V8_INLINE )?(double|int32_t|int) ' + re.escape(name) + r'\(')
    hits = [i for i, l in enumerate(src) if pat.match(l) and not l.rstrip().endswith(';')]
    # a definition: the signature runs on until a line ending in '{'
    for i in hits:
        j = i
        while not src[j].rstrip().endswith('{'):
            if src[j].rstrip().endswith(';'): break
            j += 1
        if src[j].rstrip().endswith('{'): return i
    sys.exit(f'no definition of {name}')

def body_end(i):
    depth = 0
    for j in range(i, len(src)):
        depth += src[j].count('{') - src[j].count('}')
        if depth == 0 and '}' in src[j]: return j
    sys.exit('unbalanced')

def doc_start(i):
    # the comment block right above a definition (fdlibm's notes on the method)
    j = i - 1
    while j >= 0 and src[j].strip() == '': j -= 1
    if j >= 0 and src[j].strip().endswith('*/'):
        while j >= 0 and '/*' not in src[j]: j -= 1
        return j
    return i

parts = []
for name in WANT:
    i = find_def(name)
    parts.append((doc_start(i), i, body_end(i), name))
parts.sort()

# the licence header and the word-access macros, up to the first declaration
head_end = next(i for i, l in enumerate(src) if l.startswith('int32_t __ieee754_rem_pio2(double x, double* y) V8_WARN'))
header = src[:head_end]

out = []
for l in header:
    if l.startswith('#include "src/base/'): continue
    out.append(l)
text = '\n'.join(out)
text = text.replace('#include <cmath>\n#include <limits>',
    '#include "ieee754.h"\n\n#include <bit>\n#include <cmath>\n#include <cstdint>\n#include <limits>')
text = text.replace('namespace v8 {\nnamespace base {\nnamespace ieee754 {', 'namespace stomp::v8math {')
text = text.replace('base::bit_cast', 'std::bit_cast')
text = text.replace('#if V8_CC_MSVC', '#if defined(_MSC_VER)')
text = text.replace('// Copyright 2016 the V8 project authors. All rights reserved.',
    '// Copyright 2016 the V8 project authors. All rights reserved.\n'
    '// Use of this source code is governed by a BSD-style license that can be\n'
    '// found in the LICENSE file.\n'
    '//\n'
    '// Cut down for stomp from V8 branch-heads/12.4 src/base/ieee754.cc (the V8 in\n'
    '// Node 22) to the functions its engine calls. The bodies are unchanged; only\n'
    '// V8\'s macros are replaced with standard C++.')
HELPERS = """
// From V8's src/base/overflowing-math.h: signed arithmetic that wraps instead of
// overflowing (which would be undefined behaviour).
template <typename T>
inline T SubWithWraparound(T a, T b) {
  static_assert(std::is_integral_v<T> && std::is_signed_v<T>);
  using U = std::make_unsigned_t<T>;
  return static_cast<T>(static_cast<U>(a) - static_cast<U>(b));
}
template <typename T>
inline T NegateWithWraparound(T a) {
  static_assert(std::is_integral_v<T> && std::is_signed_v<T>);
  if (a == std::numeric_limits<T>::min()) return a;
  return -a;
}
"""
text = text.replace('#include <limits>', '#include <limits>\n#include <type_traits>', 1)
out = [text, HELPERS, '// Forward declarations, as in V8.']
out += ['int32_t __ieee754_rem_pio2(double x, double* y);',
        'int __kernel_rem_pio2(double* x, double* y, int e0, int nx, int prec, const int32_t* ipio2);',
        'double __kernel_cos(double x, double y);',
        'double __kernel_sin(double x, double y, int iy);', '']

inner = True   # inside the anonymous namespace until the kernels are done
public = {'acos', 'asin', 'atan', 'atan2', 'cos', 'sin', 'tan'}
for s, i, e, name in parts:
    if name in public and inner:
        out.append('}  // namespace')
        out.append('')
        inner = False
    block = src[s:e + 1]
    out.extend(block)
    out.append('')
out.append('}  // namespace stomp::v8math')
text = '\n'.join(out) + '\n'
text = text.replace('V8_INLINE ', 'inline ').replace(' V8_WARN_UNUSED_RESULT', '')
# V8 picks fdlibm's or glibc's sin/cos with #if around the signature; keep fdlibm's
text = text.replace('double cos(double x) {\n#endif\n', 'double cos(double x) {\n').replace('double sin(double x) {\n#endif\n', 'double sin(double x) {\n')
# V8 wraps a few things in macros of its own; fail loudly if any remain
left = sorted(set(re.findall(r'\bV8_[A-Z_]+|\bbase::\w+', text)))
if left: sys.exit(f'unhandled V8 macros: {left}')
open(sys.argv[2], 'w').write(text)
print('kept', [p[3] for p in parts], len(text.split('\n')), 'lines')
