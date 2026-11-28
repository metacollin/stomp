# The WebAssembly module: Emscripten's loader as a classic script (file:// pages can't
# load modules), with the wasm embedded by embed.mjs into STOMP_WASM_OUT (by default
# demo/js/stomp-core.js; tools/check-wasm.sh builds one elsewhere to compare).
add_executable(stomp_wasm exports.cpp)
target_link_libraries(stomp_wasm PRIVATE stomp stomp_warnings)
target_include_directories(stomp_wasm PRIVATE ${PROJECT_SOURCE_DIR}/src)

set(STOMP_WASM_EXPORTS _malloc _free _stomp_version _stomp_out_ptr _stomp_out_len _stomp_out32_ptr _stomp_out32_len
    _stomp_outF_ptr _stomp_outF_len _stomp_library_names _stomp_lex _stomp_compile _stomp_recompile _stomp_last_id
    _stomp_result _stomp_clear_cache _stomp_set_library _stomp_layers _stomp_contours _stomp_model _stomp_board _stomp_vrml _stomp_stl
    _stomp_kicad _stomp_locate _stomp_constants _stomp_outline _stomp_syntax _stomp_encode _stomp_memory)
list(JOIN STOMP_WASM_EXPORTS "," exports)
target_link_options(stomp_wasm PRIVATE
  -sMODULARIZE=1
  -sEXPORT_NAME=StompCore
  -sENVIRONMENT=web,node
  -sALLOW_MEMORY_GROWTH=1
  -sSTACK_SIZE=1048576
  -sFILESYSTEM=0
  -sDYNAMIC_EXECUTION=0
  -sEXIT_RUNTIME=0
  "-sEXPORTED_FUNCTIONS=[${exports}]"
  "-sEXPORTED_RUNTIME_METHODS=[UTF8ToString,HEAPU8,HEAPU16,HEAP32,HEAPU32,HEAPF32,HEAPF64]"
  "-sINCOMING_MODULE_JS_API=[wasmBinary,print,printErr]")

find_program(NODE_EXECUTABLE NAMES node REQUIRED)
add_custom_command(TARGET stomp_wasm POST_BUILD
  COMMAND ${NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/embed.mjs
          $<TARGET_FILE_DIR:stomp_wasm>/stomp_wasm.js $<TARGET_FILE_DIR:stomp_wasm>/stomp_wasm.wasm ${STOMP_WASM_OUT}
  COMMENT "Writing ${STOMP_WASM_OUT}"
  VERBATIM)
