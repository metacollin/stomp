#include "keys.hpp"

namespace stomp {
#define STOMP_CKEY_DEF(n) const Key K_##n = key(u"" #n);
STOMP_CKEYS(STOMP_CKEY_DEF)
#undef STOMP_CKEY_DEF
}  // namespace stomp
