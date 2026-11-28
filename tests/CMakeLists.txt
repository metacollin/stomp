file(GLOB STOMP_TEST_SOURCES CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/unit/*.cpp)
add_executable(stomp_tests ${STOMP_TEST_SOURCES})
target_link_libraries(stomp_tests PRIVATE stomp stomp_warnings stomp_pegtl)
target_include_directories(stomp_tests PRIVATE ${PROJECT_SOURCE_DIR}/src ${PROJECT_SOURCE_DIR}/third_party/v8-ieee754)
target_compile_definitions(stomp_tests PRIVATE STOMP_TEST_VECTORS="${CMAKE_CURRENT_SOURCE_DIR}/unit/vectors/js.json")
if(EMSCRIPTEN)
  # in Node, reading the vectors from the real file system
  target_link_options(stomp_tests PRIVATE -sNODERAWFS=1 -sENVIRONMENT=node -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=1048576 -sEXIT_RUNTIME=1)
endif()
add_test(NAME unit COMMAND stomp_tests)

if(STOMP_BUILD_CLI)
  set(examples ${PROJECT_SOURCE_DIR}/examples)
  add_test(NAME cli-version COMMAND stomp_cli --version)
  set_tests_properties(cli-version PROPERTIES PASS_REGULAR_EXPRESSION "^stomp ${PROJECT_VERSION}")
  add_test(NAME cli-library COMMAND stomp_cli dev library)
  set_tests_properties(cli-library PROPERTIES PASS_REGULAR_EXPRESSION "colors.stomp [0-9]+")
  add_test(NAME cli-check-clean COMMAND stomp_cli check ${examples}/soic8.stomp ${examples}/qfn_library.stomp)
  add_test(NAME cli-check-problems COMMAND stomp_cli check ${CMAKE_CURRENT_SOURCE_DIR}/cli/problems.stomp)
  set_tests_properties(cli-check-problems PROPERTIES PASS_REGULAR_EXPRESSION
    "problems.stomp:4:14: error: unknown name `widtth` .* did you mean `width`\\? \\(footprint A\\)")
  add_test(NAME cli-build COMMAND stomp_cli build ${examples}/soic8.stomp ${CMAKE_CURRENT_SOURCE_DIR}/cli/problems.stomp
                                  -o ${CMAKE_CURRENT_BINARY_DIR}/cli/Parts.pretty)
  set_tests_properties(cli-build PROPERTIES PASS_REGULAR_EXPRESSION "Parts.pretty: 1 footprint, 1 with a 3D model; left out 1 with errors")
  add_test(NAME cli-model COMMAND stomp_cli model ${examples}/soic8.stomp --vrml ${CMAKE_CURRENT_BINARY_DIR}/soic8.wrl
                                  --stl ${CMAKE_CURRENT_BINARY_DIR}/soic8.stl)
endif()
