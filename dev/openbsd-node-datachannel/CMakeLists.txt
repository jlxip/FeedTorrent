cmake_minimum_required(VERSION 3.20)
project(feedtorrent_test_webrtc LANGUAGES C CXX)
# Keep the npm dependency's sources untouched. Its UNIX linker flags assume GCC;
# OpenBSD's native compiler and C++ runtime are Clang/libc++.
set(CMAKE_JS_INC "${NODE_INCLUDE_DIR}")
add_subdirectory("${NODE_DATACHANNEL_SOURCE}" upstream)
target_include_directories(node_datachannel PRIVATE "${NODE_ADDON_API}")
get_target_property(binding_libraries node_datachannel LINK_LIBRARIES)
list(REMOVE_ITEM binding_libraries -static-libgcc -static-libstdc++)
set_property(TARGET node_datachannel PROPERTY LINK_LIBRARIES "${binding_libraries}")
