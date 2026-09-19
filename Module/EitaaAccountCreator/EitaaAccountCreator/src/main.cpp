#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <esp_system.h>
#include "config.h"
#include "sim_directory.h"

/* =========================================================================
 * TTGO T-Call (ESP32 + SIM800L) — Eitaa account creator
 *
 * Wait for SIM → wait for network → auth.sendCode → read SMS code →
 * auth.signIn → if new number, auth.signUp → POST Account Manager /accounts
 *
 * Gateway envelope (same as Account-Manager-Dashboard/lib/eitaa-auth.ts):
 *   POST {EITAA_GATEWAY_URL}
 *   {"method","param","token","imei"}   token is empty before login
 *
 * Account Manager (MCP create_account):
 *   POST {ACCOUNT_MANAGER_URL}/accounts
 *   {"account_id","label","token","imei"}
 * ========================================================================= */

#define MODEM_RST       5
#define MODEM_PWKEY     4
#define MODEM_POWER_ON  23
#define MODEM_TX        27
#define MODEM_RX        26
#define MODEM_DTR       32
#define I2C_SDA         21
#define I2C_SCL         22
#define LED_GPIO        13

#define IP5306_ADDR         0x75
#define IP5306_REG_SYS_CTL0 0x00

#define SerialMon Serial
HardwareSerial SerialAT(1);
WebServer httpServer(80);

enum RunState {
    ST_WAIT_SIM,
    ST_WAIT_NET,
    ST_WAIT_PHONE,
    ST_WAIT_WIFI,
    ST_SEND_CODE,
    ST_WAIT_SMS,
    ST_SIGN_IN,
    ST_SIGN_UP,
    ST_REGISTER_AM,
    ST_DONE,
    ST_ERROR
};

static const char* stateName(RunState s) {
    switch (s) {
        case ST_WAIT_SIM:     return "wait_sim";
        case ST_WAIT_NET:     return "wait_net";
        case ST_WAIT_PHONE:   return "wait_phone";
        case ST_WAIT_WIFI:    return "wait_wifi";
        case ST_SEND_CODE:    return "send_code";
        case ST_WAIT_SMS:     return "wait_sms";
        case ST_SIGN_IN:      return "sign_in";
        case ST_SIGN_UP:      return "sign_up";
        case ST_REGISTER_AM:  return "register_am";
        case ST_DONE:         return "done";
        case ST_ERROR:        return "error";
        default:              return "unknown";
    }
}

static RunState state = ST_WAIT_SIM;
static String lastError;
static String iccid;
static String phone;
static String sessionImei;
static String phoneCodeHash;
static String phoneCode;
static String sessionToken;
static String accountLabel;
static bool labelFromSerial = false;
static String firstName;
static String lastName;
static String uartLine;
static String serialCmd;
static String pendingSmsText;
static bool pendingSms = false;
static bool forceRetry = false;
static unsigned long stateEnteredAt = 0;
static unsigned long lastSimPoll = 0;
static unsigned long lastNetPoll = 0;
static unsigned long lastSmsPoll = 0;
static unsigned long lastLedToggle = 0;
static bool ledOn = false;
static int sendCodeAttempts = 0;
static int lastCsq = -1;
static int lastCreg = -1;

static const char* kFirstNames[] = {
    "علی", "محمد", "حسین", "رضا", "مهدی", "امیر", "حسن", "سعید", "جواد", "حامد"
};
static const char* kLastNames[] = {
    "محمدی", "حسینی", "رضایی", "کریمی", "موسوی", "جعفری", "احمدی", "نوری", "صادقی", "کاظمی"
};

void processModemLine(const String& line);
String sendAT(const String& cmd, unsigned long timeout = 2000, bool trimResponse = true);
String readIccid();

/* -------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

void enterState(RunState next) {
    state = next;
    stateEnteredAt = millis();
    if (next == ST_ERROR && lastError.length()) {
        SerialMon.printf("[STATE] error: %s\n", lastError.c_str());
    } else {
        SerialMon.printf("[STATE] %s\n", stateName(next));
    }
}

String digitsOnly(const String& in) {
    String out;
    out.reserve(in.length());
    for (size_t i = 0; i < in.length();) {
        uint8_t c = (uint8_t)in[i];
        if (c >= '0' && c <= '9') {
            out += (char)c;
            i += 1;
            continue;
        }
        if (c == 0xDB && i + 1 < in.length()) {
            uint8_t d = (uint8_t)in[i + 1];
            if (d >= 0xB0 && d <= 0xB9) {
                out += (char)('0' + (d - 0xB0));
                i += 2;
                continue;
            }
        }
        if (c == 0xD9 && i + 1 < in.length()) {
            uint8_t d = (uint8_t)in[i + 1];
            if (d >= 0xA0 && d <= 0xA9) {
                out += (char)('0' + (d - 0xA0));
                i += 2;
                continue;
            }
        }
        i += 1;
    }
    return out;
}

String normalizePhone(String raw) {
    raw.trim();
    String d = digitsOnly(raw);
    if (d.startsWith("00")) d.remove(0, 2);
    if (d.startsWith("0") && d.length() == 11) d = "98" + d.substring(1);
    if (d.length() == 10 && d.startsWith("9")) d = "98" + d;
    return d;
}

bool isIranMsisdn(const String& p) {
    return p.length() == 12 && p.startsWith("98");
}

String maskSecret(const String& s) {
    if (s.length() <= 8) return "****";
    return s.substring(0, 4) + "…" + s.substring(s.length() - 4);
}

String extractDigitsFromAt(const String& resp) {
    String d;
    for (size_t i = 0; i < resp.length(); ++i) {
        if (isDigit(resp.charAt(i))) d += resp.charAt(i);
    }
    return d;
}

String labelFromIccid(const String& id) {
    String digits = extractDigitsFromAt(id);
    String canonical = digits;
    int at = digits.indexOf(SIM_DIR_PREFIX);
    if (at >= 0) {
        String rest = digits.substring(at + strlen(SIM_DIR_PREFIX));
        if (rest.length() >= 4) {
            canonical = String(SIM_DIR_PREFIX) + rest.substring(0, 4);
        }
    } else if (digits.length() == 20) {
        canonical = digits.substring(0, 19);
    }
    String tail = canonical.length() <= 5 ? canonical : canonical.substring(canonical.length() - 5);
    return String("سیمکارت سری ۲ -  ") + tail;
}

bool isPureHexString(const String& str) {
    if (str.length() < 8 || str.length() % 4 != 0) return false;
    for (size_t i = 0; i < str.length(); ++i) {
        char c = str[i];
        bool ok = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'F') || (c >= 'a' && c <= 'f');
        if (!ok) return false;
    }
    return true;
}

String ucs2HexToUtf8(const String& hex) {
    String out;
    for (size_t i = 0; i + 3 < hex.length(); i += 4) {
        uint16_t cp = (uint16_t)strtoul(hex.substring(i, i + 4).c_str(), nullptr, 16);
        if (cp == 0) continue;
        if (cp < 0x80) {
            out += (char)cp;
        } else if (cp < 0x800) {
            out += (char)(0xC0 | (cp >> 6));
            out += (char)(0x80 | (cp & 0x3F));
        } else {
            out += (char)(0xE0 | (cp >> 12));
            out += (char)(0x80 | ((cp >> 6) & 0x3F));
            out += (char)(0x80 | (cp & 0x3F));
        }
    }
    return out;
}

String decodeSmsBody(String text) {
    text.trim();
    if (isPureHexString(text)) text = ucs2HexToUtf8(text);
    return text;
}

String extractOtp(const String& text) {
    String d = digitsOnly(text);
    if (d.length() < 4) return "";
    if (d.length() >= 5) {
        int idx = (int)d.length() - 5;
        if (idx < 0) idx = 0;
        for (int i = 0; i + 5 <= (int)d.length(); ++i) {
            String five = d.substring(i, i + 5);
            if (five[0] != '0' || five != "00000") return five;
        }
    }
    if (d.length() == 4 || d.length() == 6) return d;
    return d.substring(d.length() - 5);
}

String randomImei() {
    static const char alphabet[] = "abcdefghijklmnopqrstuvwxyz0123456789";
    String out;
    out.reserve(15);
    for (int i = 0; i < 15; ++i) {
        out += alphabet[esp_random() % (sizeof(alphabet) - 1)];
    }
    return out;
}

void pickSignupName() {
    String configuredFirst = SIGNUP_FIRST_NAME;
    String configuredLast = SIGNUP_LAST_NAME;
    configuredFirst.trim();
    configuredLast.trim();
    firstName = configuredFirst.length()
                    ? configuredFirst
                    : String(kFirstNames[esp_random() % (sizeof(kFirstNames) / sizeof(kFirstNames[0]))]);
    lastName = configuredLast.length()
                   ? configuredLast
                   : String(kLastNames[esp_random() % (sizeof(kLastNames) / sizeof(kLastNames[0]))]);
}

String quotedField(const String& line, int index) {
    int from = 0;
    for (int i = 0; i <= index; ++i) {
        int a = line.indexOf('"', from);
        if (a < 0) return "";
        int b = line.indexOf('"', a + 1);
        if (b < 0) return "";
        if (i == index) return line.substring(a + 1, b);
        from = b + 1;
    }
    return "";
}

bool cpinSaysReady(const String& cpin) {
    if (cpin.indexOf("READY") >= 0) return true;
    if (cpin.indexOf("SIM PIN") >= 0 || cpin.indexOf("SIM PUK") >= 0) return true;
    return false;
}

bool cpinSaysMissing(const String& cpin) {
    String u = cpin;
    u.toUpperCase();
    return u.indexOf("NOT INSERTED") >= 0
        || u.indexOf("SIM NOT INSERTED") >= 0
        || u.indexOf("NO SIM") >= 0
        || u.indexOf("SIM REMOVAL") >= 0
        || u.indexOf("SIM FAILURE") >= 0;
}

bool simReady() {
    String cpin = sendAT("AT+CPIN?", 3000, true);
    SerialMon.printf("[SIM] CPIN: %s\n", cpin.c_str());
    if (cpinSaysReady(cpin)) return true;
    if (cpinSaysMissing(cpin)) return false;
    String id = readIccid();
    if (id.length() >= 18) {
        iccid = id;
        SerialMon.printf("[SIM] ICCID بدون READY دیده شد: %s\n", iccid.c_str());
        return true;
    }
    return false;
}

bool simAbsent(const String& cpin) {
    return cpinSaysMissing(cpin);
}

int readCsq() {
    String resp = sendAT("AT+CSQ", 1500, true);
    int p = resp.indexOf("+CSQ:");
    if (p < 0) return -1;
    return resp.substring(p + 5).toInt();
}

int readCregStat() {
    String resp = sendAT("AT+CREG?", 1500, true);
    int comma = resp.lastIndexOf(',');
    if (comma < 0) return -1;
    return resp.substring(comma + 1).toInt();
}

String readIccid() {
    String resp = sendAT("AT+CCID", 2000, true);
    String d = extractDigitsFromAt(resp);
    if (d.length() >= 18) return d;
    resp = sendAT("AT+ICCID", 2000, true);
    return extractDigitsFromAt(resp);
}

String readCnum() {
    String resp = sendAT("AT+CNUM", 2500, true);
    int q1 = resp.indexOf('"');
    while (q1 >= 0) {
        int q2 = resp.indexOf('"', q1 + 1);
        if (q2 < 0) break;
        String field = resp.substring(q1 + 1, q2);
        String n = normalizePhone(field);
        if (isIranMsisdn(n)) return n;
        q1 = resp.indexOf('"', q2 + 1);
    }
    String n = normalizePhone(resp);
    return isIranMsisdn(n) ? n : "";
}

void setLed(bool on) {
    ledOn = on;
    digitalWrite(LED_GPIO, on ? HIGH : LOW);
}

void serviceLed() {
    unsigned long interval = 800;
    switch (state) {
        case ST_DONE: setLed(true); return;
        case ST_ERROR: interval = 120; break;
        case ST_WAIT_SMS:
        case ST_SIGN_IN:
        case ST_SIGN_UP:
        case ST_REGISTER_AM: interval = 180; break;
        case ST_WAIT_SIM: interval = 1400; break;
        default: interval = 500; break;
    }
    if (millis() - lastLedToggle < interval) return;
    lastLedToggle = millis();
    setLed(!ledOn);
}

/* -------------------------------------------------------------------------
 * Modem
 * ------------------------------------------------------------------------- */

bool configureIP5306() {
    Wire.begin(I2C_SDA, I2C_SCL);
    Wire.beginTransmission(IP5306_ADDR);
    Wire.write(IP5306_REG_SYS_CTL0);
    Wire.write(0x37);
    return Wire.endTransmission() == 0;
}

void pulseModemPowerKey() {
    digitalWrite(MODEM_PWKEY, HIGH);
    delay(100);
    digitalWrite(MODEM_PWKEY, LOW);
    delay(1200);
    digitalWrite(MODEM_PWKEY, HIGH);
}

bool waitForModem(unsigned long timeoutMs) {
    unsigned long start = millis();
    int tries = 0;
    while (millis() - start < timeoutMs) {
        String r = sendAT("AT", 1200, true);
        tries++;
        if (r.indexOf("OK") >= 0) {
            SerialMon.printf("[SIM] مودم پاسخ داد بعد از %d تلاش\n", tries);
            return true;
        }
        SerialMon.printf("[SIM] مودم هنوز خاموش/ساکت است (%d): %s\n", tries, r.c_str());
        delay(400);
    }
    return false;
}

void initModem() {
    SerialMon.println(configureIP5306() ? "[HW] IP5306 boost keep-on OK" : "[HW] IP5306 not found");

    pinMode(LED_GPIO, OUTPUT);
    setLed(false);

    pinMode(MODEM_DTR, OUTPUT);
    digitalWrite(MODEM_DTR, LOW);

    pinMode(MODEM_POWER_ON, OUTPUT);
    digitalWrite(MODEM_POWER_ON, HIGH);

    pinMode(MODEM_PWKEY, OUTPUT);
    pulseModemPowerKey();

    pinMode(MODEM_RST, OUTPUT);
    digitalWrite(MODEM_RST, HIGH);

    SerialAT.begin(115200, SERIAL_8N1, MODEM_RX, MODEM_TX);
    delay(2500);
    if (!waitForModem(12000)) {
        SerialMon.println("[SIM] پاسخی نبود؛ یک‌بار دیگر PWRKEY");
        pulseModemPowerKey();
        delay(2500);
        waitForModem(12000);
    }
    sendAT("ATE0", 1000, true);
    sendAT("AT+CMEE=2", 1000, true);
    sendAT("AT+CFUN=1", 3000, true);
}

void configureSms() {
    sendAT("AT+CMGF=1", 1000, true);
    sendAT("AT+CSCS=\"GSM\"", 1000, true);
    sendAT("AT+CNMI=2,2,0,0,0", 1000, true);
    sendAT("AT+CPMS=\"SM\",\"SM\",\"SM\"", 1500, true);
}

void drainModem() {
    while (SerialAT.available()) {
        char c = (char)SerialAT.read();
        if (c == '\n') {
            uartLine.trim();
            if (uartLine.length()) processModemLine(uartLine);
            uartLine = "";
        } else if (c != '\r') {
            uartLine += c;
        }
    }
}

String sendAT(const String& cmd, unsigned long timeout, bool trimResponse) {
    SerialAT.println(cmd);
    String response;
    String line;
    unsigned long start = millis();
    while (millis() - start < timeout) {
        while (SerialAT.available()) {
            char c = (char)SerialAT.read();
            response += c;
            if (c == '\n') {
                line.trim();
                if (line.length()) processModemLine(line);
                line = "";
            } else if (c != '\r') {
                line += c;
            }
        }
        if (response.indexOf("\r\nOK\r\n") >= 0 || response.indexOf("\nOK") >= 0
            || response.indexOf("\r\nERROR\r\n") >= 0 || response.indexOf("\nERROR") >= 0
            || response.indexOf("+CME ERROR") >= 0) {
            break;
        }
        delay(5);
    }
    line.trim();
    if (line.length()) processModemLine(line);
    if (trimResponse) response.trim();
    return response;
}

void processModemLine(const String& line) {
    static bool readingText = false;

    if (readingText) {
        readingText = false;
        pendingSmsText = decodeSmsBody(line);
        pendingSms = true;
        SerialMon.printf("[SMS] %s\n", pendingSmsText.c_str());
        return;
    }

    if (line.startsWith("+CMT:") || line.startsWith("+CMGL:")) {
        readingText = true;
        return;
    }
}

void pollStoredSms() {
    String resp = sendAT("AT+CMGL=\"ALL\"", 8000, false);
    int pos = 0;
    while (true) {
        int header = resp.indexOf("+CMGL:", pos);
        if (header < 0) break;
        int nl = resp.indexOf('\n', header);
        if (nl < 0) break;
        int next = resp.indexOf("+CMGL:", nl);
        int end = next < 0 ? resp.length() : next;
        String body = resp.substring(nl + 1, end);
        body.trim();
        if (body.endsWith("OK")) {
            int okAt = body.lastIndexOf("OK");
            body = body.substring(0, okAt);
            body.trim();
        }
        if (body.length()) {
            pendingSmsText = decodeSmsBody(body);
            pendingSms = true;
            SerialMon.printf("[SMS/SIM] %s\n", pendingSmsText.c_str());
        }
        pos = end;
    }
}

void clearSmsInbox() {
    sendAT("AT+CMGD=1,4", 3000, true);
}

/* -------------------------------------------------------------------------
 * HTTP
 * ------------------------------------------------------------------------- */

bool postJson(const String& url, const String& body, String& response, int& status) {
    response = "";
    status = -1;
    HTTPClient http;
    http.setConnectTimeout(12000);
    http.setTimeout(60000);
    http.setReuse(false);

    WiFiClientSecure secure;
    bool began = false;
    if (url.startsWith("https://")) {
        secure.setInsecure();
        began = http.begin(secure, url);
    } else {
        began = http.begin(url);
    }
    if (!began) {
        lastError = "http begin failed";
        return false;
    }

    http.addHeader("Content-Type", "application/json");
    http.addHeader("Accept", "application/json");
    String apiKey = ACCOUNT_MANAGER_API_KEY;
    apiKey.trim();
    if (apiKey.length() && url.indexOf("/accounts") >= 0) {
        http.addHeader("Authorization", String("Bearer ") + apiKey);
    }

    status = http.POST(body);
    response = http.getString();
    http.end();
    return status > 0;
}

bool parseObject(const String& json, DynamicJsonDocument& doc) {
    doc.clear();
    DeserializationError err = deserializeJson(doc, json);
    return !err && doc.is<JsonObject>();
}

void hoistGatewayData(DynamicJsonDocument& doc) {
    if (!doc.is<JsonObject>()) return;
    JsonObject root = doc.as<JsonObject>();
    JsonObject inner;
    bool haveInner = false;
    if (root["data"].is<JsonObject>()) {
        inner = root["data"].as<JsonObject>();
        haveInner = true;
    } else if (root["result"].is<JsonObject>()) {
        inner = root["result"].as<JsonObject>();
        haveInner = true;
    } else if (root["response"].is<JsonObject>()) {
        inner = root["response"].as<JsonObject>();
        haveInner = true;
    }
    if (!haveInner) return;
    if (!inner.containsKey("_") && !inner.containsKey("token") && !inner.containsKey("phone_code_hash")) {
        return;
    }
    DynamicJsonDocument tmp(doc.capacity());
    JsonObject dst = tmp.to<JsonObject>();
    for (JsonPair kv : inner) {
        dst[kv.key()] = kv.value();
    }
    doc.set(tmp);
}

String tlError(JsonObject obj) {
    String ctor = obj["_"] | "";
    ctor.toLowerCase();
    if (ctor == "error" || ctor == "rpc_error" || ctor == "rpcerror") {
        String text = obj["text"] | obj["error_message"] | "";
        text.trim();
        if (text.length()) return text;
    }
    if (obj.containsKey("error")) {
        if (obj["error"].is<const char*>() || obj["error"].is<String>()) {
            String e = obj["error"].as<String>();
            e.trim();
            if (e.length()) return e;
        } else if (obj["error"].is<JsonObject>()) {
            JsonObject inner = obj["error"].as<JsonObject>();
            String t = inner["text"] | inner["error_message"] | "";
            t.trim();
            if (t.length()) return t;
        }
    }
    String em = obj["error_message"] | "";
    em.trim();
    return em;
}

bool gatewayCall(const char* method, JsonObject param, DynamicJsonDocument& out, String& ctor) {
    DynamicJsonDocument req(2048);
    req["method"] = method;
    req["param"] = param;
    req["token"] = "";
    req["imei"] = sessionImei;

    String body;
    serializeJson(req, body);
    SerialMon.printf("[GW] %s\n", method);

    String response;
    int status = -1;
    if (!postJson(EITAA_GATEWAY_URL, body, response, status)) {
        lastError = String("gateway unreachable: ") + lastError;
        return false;
    }
    if (!parseObject(response, out)) {
        lastError = "gateway HTTP " + String(status) + " " + response.substring(0, 180);
        return false;
    }
    String wrapStatus = out["status"] | "";
    hoistGatewayData(out);
    ctor = out["_"] | "";
    String err = tlError(out.as<JsonObject>());
    if (err.length()) {
        lastError = err;
        return false;
    }
    wrapStatus.toLowerCase();
    if (wrapStatus.length() && wrapStatus != "ok" && wrapStatus != "success" && wrapStatus != "200") {
        lastError = "gateway status=" + wrapStatus + " " + response.substring(0, 180);
        return false;
    }
    if (status < 200 || status >= 300) {
        lastError = "gateway HTTP " + String(status) + " " + response.substring(0, 180);
        return false;
    }
    return true;
}

bool sendCode() {
    DynamicJsonDocument req(1024);
    JsonObject param = req.createNestedObject("p");
    param["phone_number"] = phone;
    param["api_id"] = EITAA_API_ID;
    param["api_hash"] = EITAA_API_HASH;
    JsonObject settings = param.createNestedObject("settings");
    settings["_"] = "codeSettings";

    DynamicJsonDocument out(4096);
    String ctor;
    JsonObject p = req["p"].as<JsonObject>();
    if (!gatewayCall("auth.sendCode", p, out, ctor)) return false;
    if (ctor != "auth.sentCode") {
        lastError = "unexpected sendCode constructor: " + ctor;
        return false;
    }
    phoneCodeHash = out["phone_code_hash"] | "";
    phoneCodeHash.trim();
    if (!phoneCodeHash.length()) {
        lastError = "phone_code_hash missing";
        return false;
    }
    String codeType;
    if (out["type"].is<JsonObject>()) codeType = out["type"]["_"] | "";
    SerialMon.printf("[EITAA] کد ارسال شد type=%s hash=%s\n",
                     codeType.c_str(), maskSecret(phoneCodeHash).c_str());
    if (codeType.length() && codeType.indexOf("Sms") < 0 && codeType.indexOf("sms") < 0) {
        SerialMon.printf("[EITAA] نوع %s است؛ resend برای SMS\n", codeType.c_str());
        delay(1200);
        DynamicJsonDocument req2(1024);
        JsonObject p2 = req2.createNestedObject("p");
        p2["phone_number"] = phone;
        p2["phone_code_hash"] = phoneCodeHash;
        DynamicJsonDocument out2(4096);
        String ctor2;
        JsonObject rp = req2["p"].as<JsonObject>();
        if (gatewayCall("auth.resendCode", rp, out2, ctor2) && ctor2 == "auth.sentCode") {
            String nextHash = out2["phone_code_hash"] | "";
            nextHash.trim();
            if (nextHash.length()) phoneCodeHash = nextHash;
            String nextType;
            if (out2["type"].is<JsonObject>()) nextType = out2["type"]["_"] | "";
            SerialMon.printf("[EITAA] resend type=%s hash=%s\n",
                             nextType.c_str(), maskSecret(phoneCodeHash).c_str());
        } else {
            SerialMon.printf("[EITAA] resend لازم نبود/ناموفق: %s\n", lastError.c_str());
            lastError = "";
        }
    }
    return true;
}

bool signIn(String& ctor, DynamicJsonDocument& out) {
    DynamicJsonDocument req(1024);
    JsonObject param = req.createNestedObject("p");
    param["phone_number"] = phone;
    param["phone_code_hash"] = phoneCodeHash;
    param["phone_code"] = phoneCode;
    JsonObject p = req["p"].as<JsonObject>();
    return gatewayCall("auth.signIn", p, out, ctor);
}

bool signUp(String& ctor, DynamicJsonDocument& out) {
    DynamicJsonDocument req(2048);
    JsonObject param = req.createNestedObject("p");
    param["phone_number"] = phone;
    param["phone_code_hash"] = phoneCodeHash;
    param["phone_code"] = phoneCode;
    param["first_name"] = firstName;
    param["last_name"] = lastName;
    JsonObject app = param.createNestedObject("app_info");
    app["_"] = "eitaaAppInfo";
    app["build_version"] = 1;
    app["device_model"] = "TTGO T-Call";
    app["system_version"] = "ESP32";
    app["app_version"] = "1.0.0";
    app["lang_code"] = "fa";
    app["sign"] = "";
    JsonObject p = req["p"].as<JsonObject>();
    return gatewayCall("auth.signUp", p, out, ctor);
}

bool takeToken(JsonObject obj) {
    sessionToken = obj["token"] | "";
    sessionToken.trim();
    if (!sessionToken.length()) {
        lastError = "token missing in authorization";
        return false;
    }
    SerialMon.printf("[EITAA] نشست گرفته شد token=%s\n", maskSecret(sessionToken).c_str());
    return true;
}

bool errorIs(const String& hay, const char* needle) {
    String h = hay;
    h.toUpperCase();
    return h.indexOf(needle) >= 0;
}

bool registerAccountManager() {
    if (!labelFromSerial) accountLabel = labelFromIccid(iccid);
    if (!accountLabel.length()) accountLabel = labelFromIccid(phone);

    DynamicJsonDocument req(2048);
    req["account_id"] = phone;
    req["label"] = accountLabel;
    req["token"] = sessionToken;
    req["imei"] = sessionImei;
    String body;
    serializeJson(req, body);

    String url = String(ACCOUNT_MANAGER_URL);
    while (url.endsWith("/")) url.remove(url.length() - 1);
    String createUrl = url + "/accounts";

    SerialMon.printf("[AM] POST %s account_id=%s label=%s\n",
                     createUrl.c_str(), phone.c_str(), accountLabel.c_str());

    String response;
    int status = -1;
    if (!postJson(createUrl, body, response, status)) {
        lastError = "account manager unreachable";
        return false;
    }
    if (status == 200 || status == 201 || status == 204) {
        SerialMon.println("[AM] حساب ساخته شد");
        return true;
    }

    if (status == 400 || status == 409 || status == 422) {
        DynamicJsonDocument reseedDoc(2048);
        reseedDoc["token"] = sessionToken;
        reseedDoc["imei"] = sessionImei;
        reseedDoc["label"] = accountLabel;
        String reseedBody;
        serializeJson(reseedDoc, reseedBody);
        String reseedUrl = url + "/accounts/" + phone + "/reseed";
        SerialMon.printf("[AM] حساب از قبل بود؛ reseed %s\n", reseedUrl.c_str());
        int reseedStatus = -1;
        String reseedResp;
        if (!postJson(reseedUrl, reseedBody, reseedResp, reseedStatus)) {
            lastError = "account manager reseed unreachable";
            return false;
        }
        if (reseedStatus >= 200 && reseedStatus < 300) {
            SerialMon.println("[AM] reseed شد");
            return true;
        }
        lastError = "reseed HTTP " + String(reseedStatus) + " " + reseedResp.substring(0, 180);
        return false;
    }

    lastError = "AM HTTP " + String(status) + " " + response.substring(0, 180);
    return false;
}

void rememberSuccess() {
    Preferences prefs;
    if (!prefs.begin("eitaa-ac", false)) return;
    prefs.putString("iccid", iccid);
    prefs.putString("phone", phone);
    prefs.end();
}

bool alreadyCreatedThisSim() {
    if (forceRetry || !iccid.length()) return false;
    Preferences prefs;
    if (!prefs.begin("eitaa-ac", true)) return false;
    String prev = prefs.getString("iccid", "");
    prefs.end();
    return prev.length() && prev == iccid;
}

void resetSessionFields() {
    phoneCodeHash = "";
    phoneCode = "";
    sessionToken = "";
    sessionImei = "";
    pendingSms = false;
    pendingSmsText = "";
    sendCodeAttempts = 0;
    lastError = "";
}

void handleSimRemoved() {
    SerialMon.println("[SIM] سیم‌کارت برداشته شد. منتظر سیم بعدی.");
    iccid = "";
    phone = "";
    if (!labelFromSerial) accountLabel = "";
    resetSessionFields();
    forceRetry = false;
    enterState(ST_WAIT_SIM);
}

bool pollSimStillPresent() {
    if (millis() - lastSimPoll < 4000) return true;
    lastSimPoll = millis();
    String cpin = sendAT("AT+CPIN?", 3000, true);
    if (simAbsent(cpin)) {
        handleSimRemoved();
        return false;
    }
    return true;
}

/* -------------------------------------------------------------------------
 * HTTP status + serial commands
 * ------------------------------------------------------------------------- */

void handleHealth() {
    DynamicJsonDocument doc(768);
    doc["state"] = stateName(state);
    doc["iccid"] = iccid;
    doc["label"] = accountLabel;
    doc["phone"] = phone;
    doc["csq"] = lastCsq;
    doc["creg"] = lastCreg;
    doc["wifi"] = WiFi.status() == WL_CONNECTED;
    doc["ip"] = WiFi.localIP().toString();
    doc["error"] = lastError;
    String body;
    serializeJson(doc, body);
    httpServer.send(200, "application/json", body);
}

void handleSerialLine(String line) {
    line.trim();
    if (!line.length()) return;
    String upper = line;
    upper.toUpperCase();
    if (upper.startsWith("PHONE ")) {
        phone = normalizePhone(line.substring(6));
        SerialMon.printf("[CFG] شماره تنظیم شد: %s\n", phone.c_str());
        if (state == ST_WAIT_PHONE && isIranMsisdn(phone)) enterState(ST_WAIT_WIFI);
        return;
    }
    if (upper.startsWith("LABEL ")) {
        accountLabel = line.substring(6);
        accountLabel.trim();
        labelFromSerial = accountLabel.length() > 0;
        SerialMon.printf("[CFG] label=%s\n", accountLabel.c_str());
        return;
    }
    if (upper == "RETRY") {
        forceRetry = true;
        resetSessionFields();
        SerialMon.println("[CFG] RETRY — فلو از نو");
        enterState(simReady() ? ST_WAIT_NET : ST_WAIT_SIM);
        return;
    }
    if (upper == "STATUS") {
        SerialMon.printf("[STATUS] state=%s phone=%s iccid=%s csq=%d wifi=%s err=%s\n",
                         stateName(state), phone.c_str(), iccid.c_str(), lastCsq,
                         WiFi.status() == WL_CONNECTED ? "yes" : "no", lastError.c_str());
        return;
    }
    SerialMon.println("[CFG] دستورها: PHONE 9891… | LABEL نام | RETRY | STATUS");
}

void serviceSerial() {
    while (SerialMon.available()) {
        char c = (char)SerialMon.read();
        if (c == '\n') {
            handleSerialLine(serialCmd);
            serialCmd = "";
        } else if (c != '\r') {
            serialCmd += c;
        }
    }
}

void connectWifi() {
    if (WiFi.status() == WL_CONNECTED) return;
#if USE_STATIC_IP
    IPAddress local(STATIC_IP_A, STATIC_IP_B, STATIC_IP_C, STATIC_IP_D);
    IPAddress gw(STATIC_IP_A, STATIC_IP_B, STATIC_IP_C, GATEWAY_IP_D);
    IPAddress mask(255, 255, 255, 0);
    IPAddress dns1(DNS_PRIMARY_A, DNS_PRIMARY_B, DNS_PRIMARY_C, DNS_PRIMARY_D);
    IPAddress dns2(8, 8, 8, 8);
    if (!WiFi.config(local, gw, mask, dns1, dns2)) {
        SerialMon.println("[WIFI] static IP failed; DHCP");
    }
#endif
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
}

/* -------------------------------------------------------------------------
 * Setup / loop
 * ------------------------------------------------------------------------- */

void setup() {
    SerialMon.begin(115200);
    delay(800);
    SerialMon.println("\n=======================================================");
    SerialMon.println(" TTGO T-Call  |  Eitaa Account Creator");
    SerialMon.println("=======================================================");
    SerialMon.printf("Gateway: %s\n", EITAA_GATEWAY_URL);
    SerialMon.printf("Account Manager: %s\n", ACCOUNT_MANAGER_URL);
    SerialMon.println("دستور سریال: PHONE 9891… | LABEL … | RETRY | STATUS");

    phone = normalizePhone(PHONE_NUMBER);

    initModem();
    connectWifi();

    httpServer.on("/health", HTTP_GET, handleHealth);
    httpServer.on("/", HTTP_GET, handleHealth);
    httpServer.begin();

    enterState(ST_WAIT_SIM);
}

void loop() {
    drainModem();
    serviceSerial();
    serviceLed();
    httpServer.handleClient();

    if (WiFi.status() != WL_CONNECTED && millis() % 15000 < 30) {
        connectWifi();
    }

    switch (state) {
        case ST_WAIT_SIM:
            if (millis() - lastSimPoll < 2500) break;
            lastSimPoll = millis();
            if (simReady()) {
                SerialMon.println("[SIM] سیم‌کارت پیدا شد. پیکربندی مودم…");
                sendAT("AT", 1000, true);
                sendAT("ATE0", 1000, true);
                configureSms();
                String id = readIccid();
                if (id.length() >= 18) iccid = id;
                if (!labelFromSerial) accountLabel = labelFromIccid(iccid);
                if (!isIranMsisdn(phone)) {
                    String found;
                    if (lookupPhoneByIccid(iccid, found)) {
                        phone = found;
                        SerialMon.printf("[SIM] شماره از جدول ICCID: %s\n", phone.c_str());
                    } else {
                        SerialMon.printf("[SIM] ICCID در جدول هزارتایی پیدا نشد: %s\n", iccid.c_str());
                    }
                }
                SerialMon.printf("[SIM] ICCID=%s label=%s\n", iccid.c_str(), accountLabel.c_str());
                if (alreadyCreatedThisSim()) {
                    SerialMon.println("[SIM] این سیم قبلاً ساخته شده. برای تکرار RETRY بزنید.");
                    enterState(ST_DONE);
                    break;
                }
                enterState(ST_WAIT_NET);
            } else {
                SerialMon.println("[SIM] منتظر گذاشتن سیم‌کارت…");
            }
            break;

        case ST_WAIT_NET: {
            if (!pollSimStillPresent()) break;
            if (millis() - lastNetPoll < 3000) break;
            lastNetPoll = millis();
            lastCsq = readCsq();
            lastCreg = readCregStat();
            bool registered = (lastCreg == 1 || lastCreg == 5);
            bool signalOk = (lastCsq >= MIN_CSQ_RSSI && lastCsq != 99);
            SerialMon.printf("[NET] CREG=%d CSQ=%d\n", lastCreg, lastCsq);
            if (registered && signalOk) {
                SerialMon.println("[NET] آنتن و شبکه آماده است.");
                enterState(ST_WAIT_PHONE);
            } else if (millis() - stateEnteredAt > NETWORK_WAIT_MS) {
                lastError = "timeout waiting for GSM network";
                enterState(ST_ERROR);
            }
            break;
        }

        case ST_WAIT_PHONE:
            if (!pollSimStillPresent()) break;
            if (isIranMsisdn(phone)) {
                SerialMon.printf("[SIM] شماره=%s\n", phone.c_str());
                enterState(ST_WAIT_WIFI);
                break;
            }
            if (millis() - lastNetPoll < 2500) break;
            lastNetPoll = millis();
            phone = readCnum();
            if (isIranMsisdn(phone)) {
                SerialMon.printf("[SIM] شماره از CNUM=%s\n", phone.c_str());
                enterState(ST_WAIT_WIFI);
            } else {
                SerialMon.println("[SIM] شماره در جدول ICCID نیست. در سریال بزنید: PHONE 98912xxxxxxx");
            }
            break;

        case ST_WAIT_WIFI:
            if (WiFi.status() == WL_CONNECTED) {
                SerialMon.printf("[WIFI] %s\n", WiFi.localIP().toString().c_str());
                enterState(sessionToken.length() ? ST_REGISTER_AM : ST_SEND_CODE);
            } else if (millis() - stateEnteredAt > 45000) {
                lastError = "wifi timeout";
                enterState(ST_ERROR);
            }
            break;

        case ST_SEND_CODE:
            if (WiFi.status() != WL_CONNECTED) {
                enterState(ST_WAIT_WIFI);
                break;
            }
            sessionImei = randomImei();
            pickSignupName();
            pendingSms = false;
            pendingSmsText = "";
            phoneCode = "";
            sendCodeAttempts++;
            SerialMon.printf("[EITAA] sendCode تلاش %d  imei=%s  name=%s %s\n",
                             sendCodeAttempts, sessionImei.c_str(),
                             firstName.c_str(), lastName.c_str());
            if (!sendCode()) {
                SerialMon.printf("[EITAA] sendCode failed: %s\n", lastError.c_str());
                if (errorIs(lastError, "FLOOD") && sendCodeAttempts < SEND_CODE_RETRIES) {
                    SerialMon.println("[EITAA] flood — ۳۰ ثانیه صبر");
                    delay(30000);
                    break;
                }
                enterState(ST_ERROR);
                break;
            }
            lastSmsPoll = millis();
            enterState(ST_WAIT_SMS);
            break;

        case ST_WAIT_SMS: {
            if (!pollSimStillPresent()) break;
            if (pendingSms) {
                pendingSms = false;
                String code = extractOtp(pendingSmsText);
                if (code.length() >= 4) {
                    phoneCode = code;
                    SerialMon.printf("[EITAA] کد SMS: %s\n", phoneCode.c_str());
                    clearSmsInbox();
                    enterState(ST_SIGN_IN);
                    break;
                }
                SerialMon.println("[SMS] پیام بدون کد OTP نادیده گرفته شد");
            }
            if (millis() - lastSmsPoll > 6000) {
                lastSmsPoll = millis();
                pollStoredSms();
            }
            if (millis() - stateEnteredAt > SMS_WAIT_MS) {
                lastError = "SMS code timeout";
                enterState(ST_ERROR);
            }
            break;
        }

        case ST_SIGN_IN: {
            DynamicJsonDocument out(4096);
            String ctor;
            SerialMon.println("[EITAA] auth.signIn");
            if (!signIn(ctor, out)) {
                if (errorIs(lastError, "PHONE_NUMBER_UNOCCUPIED")) {
                    SerialMon.println("[EITAA] شماره جدید است — auth.signUp");
                    enterState(ST_SIGN_UP);
                    break;
                }
                SerialMon.printf("[EITAA] signIn failed: %s\n", lastError.c_str());
                enterState(ST_ERROR);
                break;
            }
            if (ctor == "auth.authorizationSignUpRequired") {
                SerialMon.println("[EITAA] authorizationSignUpRequired — auth.signUp");
                enterState(ST_SIGN_UP);
                break;
            }
            if (ctor == "auth.authorization") {
                if (!takeToken(out.as<JsonObject>())) {
                    enterState(ST_ERROR);
                    break;
                }
                enterState(ST_REGISTER_AM);
                break;
            }
            lastError = "unexpected signIn constructor: " + ctor;
            enterState(ST_ERROR);
            break;
        }

        case ST_SIGN_UP: {
            DynamicJsonDocument out(4096);
            String ctor;
            SerialMon.printf("[EITAA] auth.signUp  %s %s\n", firstName.c_str(), lastName.c_str());
            if (!signUp(ctor, out)) {
                SerialMon.printf("[EITAA] signUp failed: %s\n", lastError.c_str());
                enterState(ST_ERROR);
                break;
            }
            if (ctor != "auth.authorization") {
                lastError = "unexpected signUp constructor: " + ctor;
                enterState(ST_ERROR);
                break;
            }
            if (!takeToken(out.as<JsonObject>())) {
                enterState(ST_ERROR);
                break;
            }
            enterState(ST_REGISTER_AM);
            break;
        }

        case ST_REGISTER_AM:
            if (WiFi.status() != WL_CONNECTED) {
                enterState(ST_WAIT_WIFI);
                break;
            }
            if (!registerAccountManager()) {
                SerialMon.printf("[AM] failed: %s\n", lastError.c_str());
                enterState(ST_ERROR);
                break;
            }
            rememberSuccess();
            SerialMon.printf("[DONE] %s در Account Manager ثبت شد. سیم را بردارید.\n", phone.c_str());
            enterState(ST_DONE);
            break;

        case ST_DONE:
            pollSimStillPresent();
            break;

        case ST_ERROR:
            if (!pollSimStillPresent()) break;
            if (millis() - stateEnteredAt > 15000 && sendCodeAttempts < SEND_CODE_RETRIES
                && phoneCodeHash.length() == 0) {
                SerialMon.println("[ERROR] تلاش دوباره sendCode");
                enterState(ST_SEND_CODE);
            }
            break;
    }
}
