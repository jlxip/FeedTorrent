# OpenBSD has no IPv4-mapped IPv6 sockets. Scope the single-socket ICE
# adaptation to libjuice, without changing pinned third-party sources.
function(feedtorrent_openbsd_webrtc)
  if(CMAKE_SYSTEM_NAME STREQUAL "OpenBSD")
    foreach(ice_target juice-static juice)
      if(TARGET ${ice_target})
        target_compile_options(${ice_target} PRIVATE
          "-include" "${CMAKE_CURRENT_FUNCTION_LIST_DIR}/openbsd-ice.h")
      endif()
    endforeach()
    foreach(rtc_target datachannel-static datachannel)
      if(TARGET ${rtc_target})
        get_target_property(rtc_source ${rtc_target} SOURCE_DIR)
        set_property(SOURCE "${rtc_source}/src/impl/dtlstransport.cpp"
          TARGET_DIRECTORY ${rtc_target} APPEND PROPERTY COMPILE_OPTIONS
          "-include" "${CMAKE_CURRENT_FUNCTION_LIST_DIR}/openbsd-dtls.h")
      endif()
    endforeach()
  endif()
endfunction()
