// Copyright 2016 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE.v8 file. The functions are fdlibm's; see LICENSE.fdlibm.
//
// The trigonometric functions V8 gives JavaScript's Math (V8 12.4, the version in
// Node 22), so the C++ engine computes exactly what the JavaScript one did, and the
// native and WebAssembly builds agree on every platform.

#ifndef STOMP_V8_IEEE754_H_
#define STOMP_V8_IEEE754_H_

namespace stomp::v8math {

double acos(double x);
double asin(double x);
double atan(double x);
double atan2(double y, double x);
double cos(double x);
double sin(double x);
double tan(double x);

}  // namespace stomp::v8math

#endif  // STOMP_V8_IEEE754_H_
