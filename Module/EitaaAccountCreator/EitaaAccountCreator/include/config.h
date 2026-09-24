#pragma once

// Optional local overrides (WiFi, IP mode, URLs). Copy from config.local.h.example.
#if __has_include("config.local.h")
#include "config.local.h"
#endif

// Transport (pick one):
//   USE_PHONE_HOTSPOT     — WiFi to the phone, onboard TL gateway (direct Eitaa)
//   USE_INTERNAL_NETWORK  — office LAN (Otaq + 10.10.20.51)
//   both 0                — SIM GPRS
#ifndef USE_PHONE_HOTSPOT
#define USE_PHONE_HOTSPOT 1
#endif
#ifndef USE_INTERNAL_NETWORK
#define USE_INTERNAL_NETWORK 0
#endif

#if USE_PHONE_HOTSPOT
#define USE_WIFI_TRANSPORT 1
#elif USE_INTERNAL_NETWORK
#define USE_WIFI_TRANSPORT 1
#else
#define USE_WIFI_TRANSPORT 0
#endif

#ifndef HOTSPOT_SSID
#define HOTSPOT_SSID "reza"
#endif
#ifndef HOTSPOT_PASS
#define HOTSPOT_PASS "12345678"
#endif

// --- Office WiFi (only when USE_INTERNAL_NETWORK) ---
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

#ifndef GPRS_APN
#define GPRS_APN ""
#endif
#ifndef GPRS_USER
#define GPRS_USER ""
#endif
#ifndef GPRS_PASS
#define GPRS_PASS ""
#endif
#ifndef GPRS_WAIT_MS
#define GPRS_WAIT_MS 90000
#endif

// --- Eitaa Gateway ---
#ifndef EITAA_GATEWAY_URL
#if USE_INTERNAL_NETWORK
#define EITAA_GATEWAY_URL "http://10.10.20.51:3000/send"
#else
#define EITAA_GATEWAY_URL "https://gateway.ir-ma.ir/send"
#endif
#endif
#ifndef EITAA_API_ID
#define EITAA_API_ID 1782360
#endif
#ifndef EITAA_API_HASH
#define EITAA_API_HASH "0d870902a3e09e7cdc57e5d7bd68da6b"
#endif

#ifndef ACCOUNT_MANAGER_URL
#if USE_INTERNAL_NETWORK
#define ACCOUNT_MANAGER_URL "http://10.10.20.51:8085"
#else
#define ACCOUNT_MANAGER_URL "https://account-manager.ir-ma.ir"
#endif
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
#define SMS_WAIT_MS 600000
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

// 1 = talk to Eitaa hosts directly (hasan.eitaa.ir …) with the Rust TL wrapper.
// 0 = JSON through EITAA_GATEWAY_URL (your server IP — Eitaa rate-limits that).
#ifndef USE_DIRECT_EITAA
#define USE_DIRECT_EITAA 1
#endif
