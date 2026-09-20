#pragma once

// Optional local overrides (WiFi, IP mode, URLs). Copy from config.local.h.example.
#if __has_include("config.local.h")
#include "config.local.h"
#endif

// --- WiFi (same LAN as the other TTGO T-Call in SimcardManager) ---
#ifndef WIFI_SSID
#define WIFI_SSID "Otaq"
#endif
#ifndef WIFI_PASS
#define WIFI_PASS "Pour1412#"
#endif

#ifndef USE_STATIC_IP
#define USE_STATIC_IP 0
#endif
#ifndef STATIC_IP_A
#define STATIC_IP_A 10
#define STATIC_IP_B 10
#define STATIC_IP_C 30
#define STATIC_IP_D 204
#endif
#ifndef GATEWAY_IP_D
#define GATEWAY_IP_D 1
#endif

#ifndef DNS_PRIMARY_A
#define DNS_PRIMARY_A 10
#define DNS_PRIMARY_B 10
#define DNS_PRIMARY_C 30
#define DNS_PRIMARY_D 1
#endif

// --- Eitaa Gateway (MCP: http://gateway.irm/send) ---
#ifndef EITAA_GATEWAY_URL
#define EITAA_GATEWAY_URL "http://10.10.20.51:3000/send"
#endif
#ifndef EITAA_API_ID
#define EITAA_API_ID 1782360
#endif
#ifndef EITAA_API_HASH
#define EITAA_API_HASH "0d870902a3e09e7cdc57e5d7bd68da6b"
#endif

// --- Account Manager (MCP: POST /accounts on http://10.10.20.51:8085) ---
#ifndef ACCOUNT_MANAGER_URL
#define ACCOUNT_MANAGER_URL "http://10.10.20.51:8085"
#endif
#ifndef ACCOUNT_MANAGER_API_KEY
#define ACCOUNT_MANAGER_API_KEY ""
#endif

// Empty = read from SIM (AT+CNUM). Serial:  PHONE 98912xxxxxxx
#ifndef PHONE_NUMBER
#define PHONE_NUMBER ""
#endif

#ifndef SIGNUP_FIRST_NAME
#define SIGNUP_FIRST_NAME ""
#endif
#ifndef SIGNUP_LAST_NAME
#define SIGNUP_LAST_NAME ""
#endif

#ifndef SMS_WAIT_MS
#define SMS_WAIT_MS 120000
#endif
#ifndef NETWORK_WAIT_MS
#define NETWORK_WAIT_MS 90000
#endif
#ifndef MIN_CSQ_RSSI
#define MIN_CSQ_RSSI 5
#endif
#ifndef SEND_CODE_RETRIES
#define SEND_CODE_RETRIES 1
#endif
