# Third-party code

| folder | what | from | license |
|---|---|---|---|
| `PEGTL/` | PEGTL 3.2.7, the header-only C++ parser library stomp's parser is built on | the 3.2.7 release (Ubuntu's `tao-pegtl_3.2.7.orig.tar.gz`), `include/` unchanged | MIT, `PEGTL/LICENSE` |
| `v8-ieee754/` | the sine, cosine, tangent and arcus functions JavaScript's `Math` uses in V8 12.4 (Node 22), so the C++ engine gives exactly the numbers the JavaScript one did, on every platform | V8 `branch-heads/12.4`, `src/base/ieee754.cc`, cut down by `v8-ieee754/trim.py` with the function bodies unchanged | fdlibm's notice (`LICENSE.fdlibm`) and V8's BSD license (`LICENSE.v8`) |

V8's `Math.hypot` (`src/builtins/math.tq`) and `Math.round` algorithms are ported in
`src/jsrt.cpp`, with the same notices.
