# libtorrent 2.1.2 declares an unused RLIMIT_AS constant in this file.
# OpenBSD has RLIMIT_DATA instead. Keep the workaround local to that source;
# retain real resource-limit handling and leave the pinned submodule untouched.
if(CMAKE_SYSTEM_NAME STREQUAL "OpenBSD")
  set_property(SOURCE "${CMAKE_CURRENT_SOURCE_DIR}/src/platform_util.cpp"
    APPEND PROPERTY COMPILE_DEFINITIONS RLIMIT_AS=RLIMIT_DATA)
endif()
