#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>

// Minimal port of simple_rust_gateway TL wrap: method → eitaaObject → binary.
// Only the auth methods this board needs.

bool eitaaTlEncodeCall(const char* method, JsonObject param,
                       const String& token, const String& imei,
                       String& outBin);

bool eitaaTlDecode(const uint8_t* data, size_t len, DynamicJsonDocument& out);

const char* eitaaPickHost();
void eitaaRotateHost();
String eitaaHostUrl(const char* host);
