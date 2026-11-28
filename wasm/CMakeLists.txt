# The WebAssembly module: Emscripten's loader as a classic script (file:// pages can't
# load modules), with the wasm embedded by embed.mjs into demo/js/stomp-core.js.
add_executable(stomp_wasm exports.cpp)
target_link_libraries(stomp_wasm PRIVATE stomp stomp_warnings)
target_include_directories(stomp_wasm PRIVATE ${PROJECT_SOURCE_DIR}/src)

set(STOMP_WASM_EXPORTS _malloc _free _stomp_version _stomp_out_ptr _stomp_out_len _stomp_out32_ptr _stomp_out32_len
    _stomp_library_names _stomp_lex)
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

if(STOMP_DEPLOY_WASM)
  find_program(NODE_EXECUTABLE NAMES node REQUIRED)
  set(core_js ${PROJECT_SOURCE_DIR}/demo/js/stomp-core.js)
  add_custom_command(TARGET stomp_wasm POST_BUILD
    COMMAND ${NODE_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/embed.mjs
            $<TARGET_FILE_DIR:stomp_wasm>/stomp_wasm.js $<TARGET_FILE_DIR:stomp_wasm>/stomp_wasm.wasm ${core_js}
    COMMENT "Writing demo/js/stomp-core.js"
    VERBATIM)
endif()
