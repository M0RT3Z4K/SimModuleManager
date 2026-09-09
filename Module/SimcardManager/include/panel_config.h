#pragma once

// Local secrets/configuration are deliberately excluded from version control.
#if __has_include("panel_config.local.h")
#include "panel_config.local.h"
#endif

#ifndef PANEL_BASE_URL
#define PANEL_BASE_URL "http://10.10.30.1:3000"
#endif
#ifndef DEVICE_REGISTRATION_TOKEN
#define DEVICE_REGISTRATION_TOKEN ""
#endif
#ifndef AUDIO_OUTPUT_SAMPLE_RATE
#define AUDIO_OUTPUT_SAMPLE_RATE 8000
#endif
static_assert(AUDIO_OUTPUT_SAMPLE_RATE == 8000 || AUDIO_OUTPUT_SAMPLE_RATE == 16000,
              "Audio output must use a supported telephony rate");
