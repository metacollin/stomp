# stomp: the footprint language's engine as a C++20 library, its command-line tool,
# and the WebAssembly build the browser editor uses.
#
#   cmake --preset native-release && cmake --build --preset native-release
#   ctest --preset native-release
#   emcmake cmake --preset wasm-release && cmake --build --preset wasm-release
#
# The WebAssembly build writes demo/js/stomp-core.js (see wasm/embed.mjs).
cmake_minimum_required(VERSION 3.21)
project(stomp VERSION 0.1.0 DESCRIPTION "A language for PCB footprints" LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

set(STOMP_TOP_LEVEL OFF)
if(CMAKE_SOURCE_DIR STREQUAL PROJECT_SOURCE_DIR)
  set(STOMP_TOP_LEVEL ON)
endif()

if(EMSCRIPTEN)
  set(STOMP_NATIVE OFF)
else()
  set(STOMP_NATIVE ON)
endif()

option(STOMP_BUILD_CLI "Build the stomp command-line tool" ${STOMP_NATIVE})
option(STOMP_BUILD_TESTS "Build the C++ tests" ${STOMP_TOP_LEVEL})
option(STOMP_SANITIZE "Build with AddressSanitizer and UndefinedBehaviorSanitizer" OFF)
option(STOMP_DEPLOY_WASM "Build the editor's engine (a WebAssembly build only) into STOMP_WASM_OUT" ON)
set(STOMP_WASM_OUT "${PROJECT_SOURCE_DIR}/demo/js/stomp-core.js" CACHE FILEPATH "Where a WebAssembly build writes the editor's engine")

# Every target: the same arithmetic as the JavaScript engine (no fused multiply-add,
# no fast-math), and exceptions on (the parser and evaluator use them).
add_library(stomp_options INTERFACE)
if(MSVC)
  target_compile_options(stomp_options INTERFACE /fp:precise /EHsc /utf-8 /permissive-)
else()
  target_compile_options(stomp_options INTERFACE -ffp-contract=off -fno-fast-math)
  if(EMSCRIPTEN)
    target_compile_options(stomp_options INTERFACE -fwasm-exceptions)
    target_link_options(stomp_options INTERFACE -fwasm-exceptions)
  endif()
endif()
if(STOMP_SANITIZE AND NOT MSVC AND NOT EMSCRIPTEN)
  target_compile_options(stomp_options INTERFACE -fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer)
  target_link_options(stomp_options INTERFACE -fsanitize=address,undefined)
endif()

# Warnings for stomp's own code (not third_party)
add_library(stomp_warnings INTERFACE)
if(MSVC)
  target_compile_options(stomp_warnings INTERFACE /W4)
else()
  target_compile_options(stomp_warnings INTERFACE -Wall -Wextra -Wpedantic -Wshadow -Wnon-virtual-dtor -Wimplicit-fallthrough)
  if(CMAKE_CXX_COMPILER_ID STREQUAL "GNU")
    # GCC 13 reports std::variant copies as maybe-uninitialized at -O2 (a known false positive)
    target_compile_options(stomp_warnings INTERFACE -Wno-maybe-uninitialized)
  endif()
endif()

# Third party: PEGTL (header-only) and V8's trigonometry
add_library(stomp_pegtl INTERFACE)
target_include_directories(stomp_pegtl SYSTEM INTERFACE ${PROJECT_SOURCE_DIR}/third_party/PEGTL/include)

add_library(stomp_v8math OBJECT third_party/v8-ieee754/ieee754.cc)
target_include_directories(stomp_v8math PUBLIC ${PROJECT_SOURCE_DIR}/third_party/v8-ieee754)
target_link_libraries(stomp_v8math PRIVATE stomp_options)
set_target_properties(stomp_v8math PROPERTIES POSITION_INDEPENDENT_CODE ON)
if(NOT MSVC)
  target_compile_options(stomp_v8math PRIVATE -w)
endif()

# The standard library's .stomp files, built into the library (cmake/EmbedStdlib.cmake)
file(STRINGS ${PROJECT_SOURCE_DIR}/stdlib/ORDER STOMP_STDLIB_ORDER REGEX "^[^#].*")
set(STOMP_STDLIB_FILES "")
foreach(f IN LISTS STOMP_STDLIB_ORDER)
  list(APPEND STOMP_STDLIB_FILES ${PROJECT_SOURCE_DIR}/stdlib/${f})
endforeach()
set(STOMP_STDLIB_CPP ${PROJECT_BINARY_DIR}/generated/stdlib_data.cpp)
add_custom_command(
  OUTPUT ${STOMP_STDLIB_CPP}
  COMMAND ${CMAKE_COMMAND} -DORDER=${PROJECT_SOURCE_DIR}/stdlib/ORDER -DDIR=${PROJECT_SOURCE_DIR}/stdlib
          -DOUT=${STOMP_STDLIB_CPP} -P ${PROJECT_SOURCE_DIR}/cmake/EmbedStdlib.cmake
  DEPENDS ${PROJECT_SOURCE_DIR}/cmake/EmbedStdlib.cmake ${PROJECT_SOURCE_DIR}/stdlib/ORDER ${STOMP_STDLIB_FILES}
  COMMENT "Embedding the standard library"
  VERBATIM)

# The library
file(GLOB_RECURSE STOMP_SOURCES CONFIGURE_DEPENDS ${PROJECT_SOURCE_DIR}/src/*.cpp)
add_library(stomp STATIC ${STOMP_SOURCES} ${STOMP_STDLIB_CPP} $<TARGET_OBJECTS:stomp_v8math>)
add_library(stomp::stomp ALIAS stomp)
target_include_directories(stomp
  PUBLIC $<BUILD_INTERFACE:${PROJECT_SOURCE_DIR}/include> $<INSTALL_INTERFACE:include>
  PRIVATE ${PROJECT_SOURCE_DIR}/src ${PROJECT_SOURCE_DIR}/third_party/v8-ieee754)
target_link_libraries(stomp PRIVATE stomp_warnings stomp_pegtl PUBLIC stomp_options)
target_compile_definitions(stomp PRIVATE STOMP_VERSION="${PROJECT_VERSION}")
set_target_properties(stomp PROPERTIES POSITION_INDEPENDENT_CODE ON)

if(STOMP_BUILD_CLI)
  add_executable(stomp_cli cli/main.cpp)
  set_target_properties(stomp_cli PROPERTIES OUTPUT_NAME stomp)
  target_link_libraries(stomp_cli PRIVATE stomp stomp_warnings)
  target_include_directories(stomp_cli PRIVATE ${PROJECT_SOURCE_DIR}/src)
  if(EMSCRIPTEN)
    # stomp.js, run with Node on the real file system (tests/compare runs it against the native tool)
    target_link_options(stomp_cli PRIVATE -sNODERAWFS=1 -sENVIRONMENT=node -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=1048576 -sEXIT_RUNTIME=1)
  endif()
endif()

if(EMSCRIPTEN AND STOMP_DEPLOY_WASM)
  add_subdirectory(wasm)
endif()

if(STOMP_BUILD_TESTS)
  enable_testing()
  add_subdirectory(tests)   # under Emscripten they run in Node (the wasm-test preset)
endif()

include(GNUInstallDirs)
install(TARGETS stomp ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR})
install(DIRECTORY include/stomp DESTINATION ${CMAKE_INSTALL_INCLUDEDIR})
if(STOMP_BUILD_CLI)
  install(TARGETS stomp_cli RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
endif()
