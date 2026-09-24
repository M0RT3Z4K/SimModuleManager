#include "eitaa_tl.h"
#include "config.h"

#if defined(ARDUINO_ARCH_ESP32)
#include "rom/miniz.h"
#endif

static const uint32_t ID_SEND_CODE     = (uint32_t)(int32_t)-1502141361;
static const uint32_t ID_SIGN_UP       = (uint32_t)(int32_t)-2131827673;
static const uint32_t ID_SIGN_IN       = (uint32_t)(int32_t)-1126886015;
static const uint32_t ID_RESEND_CODE   = (uint32_t)(int32_t)1056025023;
static const uint32_t ID_EITAA_OBJECT  = (uint32_t)(int32_t)2059302893;
static const uint32_t ID_CODE_SETTINGS = (uint32_t)(int32_t)-557924733;
static const uint32_t ID_APP_INFO      = (uint32_t)(int32_t)1635347945;
static const uint32_t ID_SENT_CODE     = (uint32_t)(int32_t)1577067778;
static const uint32_t ID_AUTH          = (uint32_t)(int32_t)-855308010;
static const uint32_t ID_SIGNUP_REQ    = (uint32_t)(int32_t)1148485274;
static const uint32_t ID_ERROR         = (uint32_t)(int32_t)-994444869;
static const uint32_t ID_GZIP          = (uint32_t)(int32_t)812830625;
static const uint32_t ID_TYPE_APP      = (uint32_t)(int32_t)1035688326;
static const uint32_t ID_TYPE_SMS      = (uint32_t)(int32_t)-1073693790;
static const uint32_t ID_TYPE_CALL     = (uint32_t)(int32_t)1398007207;
static const uint32_t ID_TYPE_FLASH    = (uint32_t)(int32_t)-1425815847;
static const uint32_t ID_CTYPE_SMS     = (uint32_t)(int32_t)1923290508;
static const uint32_t ID_CTYPE_CALL    = (uint32_t)(int32_t)1948046307;
static const uint32_t ID_CTYPE_FLASH   = (uint32_t)(int32_t)577556219;

static const char* kHosts[] = {
    "hasan.eitaa.ir",
    "sajad.eitaa.ir",
    "bagher.eitaa.ir",
    "sadegh.eitaa.ir",
    "kazem.eitaa.ir",
    "hosna.eitaa.com",
    "armita.eitaa.com",
    "majid.eitaa.com",
    "alireza.eitaa.com",
    "mostafa.eitaa.com",
};
static uint8_t hostIndex = 0;

const char* eitaaPickHost() {
    return kHosts[hostIndex % (sizeof(kHosts) / sizeof(kHosts[0]))];
}

void eitaaRotateHost() {
    hostIndex = (uint8_t)((hostIndex + 1) % (sizeof(kHosts) / sizeof(kHosts[0])));
}

String eitaaHostUrl(const char* host) {
    String u = "https://";
    u += host;
    u += "/eitaa/";
    return u;
}

class TlWriter {
public:
    String buf;
    TlWriter() { buf.reserve(512); }

    void u32(uint32_t v) {
        buf += (char)(v & 0xff);
        buf += (char)((v >> 8) & 0xff);
        buf += (char)((v >> 16) & 0xff);
        buf += (char)((v >> 24) & 0xff);
    }
    void i32(int32_t v) { u32((uint32_t)v); }

    void bytes(const uint8_t* p, size_t len) {
        if (len <= 253) {
            buf += (char)len;
        } else {
            buf += (char)254;
            buf += (char)(len & 0xff);
            buf += (char)((len >> 8) & 0xff);
            buf += (char)((len >> 16) & 0xff);
        }
        for (size_t i = 0; i < len; ++i) buf += (char)p[i];
        while (buf.length() % 4) buf += (char)0;
    }
    void str(const String& s) {
        bytes(reinterpret_cast<const uint8_t*>(s.c_str()), s.length());
    }
};

class TlReader {
public:
    const uint8_t* data;
    size_t len;
    size_t off;
    TlReader(const uint8_t* d, size_t n) : data(d), len(n), off(0) {}

    bool need(size_t n) const { return off + n <= len; }

    bool u32(uint32_t& v) {
        if (!need(4)) return false;
        v = (uint32_t)data[off]
            | ((uint32_t)data[off + 1] << 8)
            | ((uint32_t)data[off + 2] << 16)
            | ((uint32_t)data[off + 3] << 24);
        off += 4;
        return true;
    }
    bool i32(int32_t& v) {
        uint32_t u;
        if (!u32(u)) return false;
        v = (int32_t)u;
        return true;
    }
    bool str(String& s) {
        if (off >= len) return false;
        size_t n = data[off++];
        if (n == 254) {
            if (!need(3)) return false;
            n = data[off] | ((size_t)data[off + 1] << 8) | ((size_t)data[off + 2] << 16);
            off += 3;
        }
        if (!need(n)) return false;
        s = "";
        s.concat(reinterpret_cast<const char*>(data + off), n);
        off += n;
        while (off % 4 && off < len) off++;
        return true;
    }
    bool rawBytes(String& s) {
        return str(s);
    }
};

static bool encodeInner(const char* method, JsonObject param, String& inner) {
    TlWriter w;
    String m = method;
    if (m == "auth.sendCode") {
        w.u32(ID_SEND_CODE);
        w.str(param["phone_number"] | "");
        w.i32(param["api_id"] | EITAA_API_ID);
        w.str(param["api_hash"] | EITAA_API_HASH);
        w.u32(ID_CODE_SETTINGS);
        int flags = 0;
        if (param["settings"].is<JsonObject>()) {
            flags = param["settings"]["flags"] | 0;
        }
        w.i32(flags);
        inner = w.buf;
        return true;
    }
    if (m == "auth.signIn") {
        w.u32(ID_SIGN_IN);
        w.str(param["phone_number"] | "");
        w.str(param["phone_code_hash"] | "");
        w.str(param["phone_code"] | "");
        inner = w.buf;
        return true;
    }
    if (m == "auth.resendCode") {
        w.u32(ID_RESEND_CODE);
        w.str(param["phone_number"] | "");
        w.str(param["phone_code_hash"] | "");
        inner = w.buf;
        return true;
    }
    if (m == "auth.signUp") {
        w.u32(ID_SIGN_UP);
        w.str(param["phone_number"] | "");
        w.str(param["phone_code_hash"] | "");
        w.str(param["phone_code"] | "");
        w.str(param["first_name"] | "");
        w.str(param["last_name"] | "");
        w.u32(ID_APP_INFO);
        JsonObject app = param["app_info"].is<JsonObject>() ? param["app_info"].as<JsonObject>() : JsonObject();
        w.i32(app["build_version"] | 1);
        w.str(app["device_model"] | "TTGO T-Call");
        w.str(app["system_version"] | "ESP32");
        w.str(app["app_version"] | "1.0.0");
        w.str(app["lang_code"] | "fa");
        w.str(app["sign"] | "");
        inner = w.buf;
        return true;
    }
    return false;
}

bool eitaaTlEncodeCall(const char* method, JsonObject param,
                       const String& token, const String& imei,
                       String& outBin) {
    String inner;
    if (!encodeInner(method, param, inner)) return false;
    TlWriter w;
    w.u32(ID_EITAA_OBJECT);
    w.str(token);
    w.str(imei);
    w.bytes(reinterpret_cast<const uint8_t*>(inner.c_str()), inner.length());
    w.i32(133);
    outBin = w.buf;
    return true;
}

static const char* typeName(uint32_t id) {
    if (id == ID_TYPE_APP) return "auth.sentCodeTypeApp";
    if (id == ID_TYPE_SMS) return "auth.sentCodeTypeSms";
    if (id == ID_TYPE_CALL) return "auth.sentCodeTypeCall";
    if (id == ID_TYPE_FLASH) return "auth.sentCodeTypeFlashCall";
    if (id == ID_CTYPE_SMS) return "auth.codeTypeSms";
    if (id == ID_CTYPE_CALL) return "auth.codeTypeCall";
    if (id == ID_CTYPE_FLASH) return "auth.codeTypeFlashCall";
    return nullptr;
}

static bool decodeType(TlReader& r, JsonObject obj) {
    uint32_t id = 0;
    if (!r.u32(id)) return false;
    const char* name = typeName(id);
    obj["_"] = name ? name : "unknown";
    if (id == ID_TYPE_APP || id == ID_TYPE_SMS || id == ID_TYPE_CALL) {
        int32_t length = 0;
        if (!r.i32(length)) return false;
        obj["length"] = length;
        return true;
    }
    if (id == ID_TYPE_FLASH) {
        String pattern;
        if (!r.str(pattern)) return false;
        obj["pattern"] = pattern;
        return true;
    }
    return true;
}

static bool gunzipTo(const String& gz, String& plain) {
#if defined(ARDUINO_ARCH_ESP32)
    const uint8_t* src = reinterpret_cast<const uint8_t*>(gz.c_str());
    size_t slen = gz.length();
    if (slen < 18 || src[0] != 0x1f || src[1] != 0x8b) return false;
    size_t off = 10;
    uint8_t flags = src[3];
    if (flags & 4) {
        if (off + 2 > slen) return false;
        uint16_t xlen = (uint16_t)(src[off] | (src[off + 1] << 8));
        off += 2 + xlen;
    }
    if (flags & 8) {
        while (off < slen && src[off]) off++;
        off++;
    }
    if (flags & 16) {
        while (off < slen && src[off]) off++;
        off++;
    }
    if (flags & 2) off += 2;
    if (off + 8 > slen) return false;
    size_t deflateLen = slen - off - 8;
    size_t outLen = (size_t)src[slen - 4]
        | ((size_t)src[slen - 3] << 8)
        | ((size_t)src[slen - 2] << 16)
        | ((size_t)src[slen - 1] << 24);
    if (outLen == 0 || outLen > 32768) outLen = 8192;
    char* dest = static_cast<char*>(malloc(outLen));
    if (!dest) return false;
    size_t n = tinfl_decompress_mem_to_mem(
        dest, outLen, src + off, deflateLen,
        TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF);
    if (n == TINFL_DECOMPRESS_MEM_TO_MEM_FAILED) {
        free(dest);
        return false;
    }
    plain = "";
    plain.concat(dest, n);
    free(dest);
    return true;
#else
    (void)gz;
    (void)plain;
    return false;
#endif
}

static bool decodeObject(TlReader& r, DynamicJsonDocument& out) {
    uint32_t id = 0;
    if (!r.u32(id)) return false;

    if (id == ID_GZIP) {
        String packed;
        if (!r.rawBytes(packed)) return false;
        String plain;
        if (!gunzipTo(packed, plain)) return false;
        TlReader inner(reinterpret_cast<const uint8_t*>(plain.c_str()), plain.length());
        return decodeObject(inner, out);
    }

    JsonObject obj = out.to<JsonObject>();
    if (id == ID_ERROR) {
        obj["_"] = "error";
        int32_t code = 0;
        String text;
        if (!r.i32(code) || !r.str(text)) return false;
        obj["code"] = code;
        obj["text"] = text;
        obj["error_message"] = text;
        return true;
    }
    if (id == ID_SENT_CODE) {
        obj["_"] = "auth.sentCode";
        int32_t flags = 0;
        if (!r.i32(flags)) return false;
        obj["flags"] = flags;
        JsonObject typ = obj.createNestedObject("type");
        if (!decodeType(r, typ)) return false;
        String hash;
        if (!r.str(hash)) return false;
        obj["phone_code_hash"] = hash;
        if (flags & (1 << 1)) {
            JsonObject next = obj.createNestedObject("next_type");
            if (!decodeType(r, next)) return false;
        }
        if (flags & (1 << 2)) {
            int32_t timeout = 0;
            if (!r.i32(timeout)) return false;
            obj["timeout"] = timeout;
        }
        return true;
    }
    if (id == ID_AUTH) {
        obj["_"] = "auth.authorization";
        int32_t flags = 0;
        if (!r.i32(flags)) return false;
        obj["flags"] = flags;
        String token;
        if (!r.str(token)) return false;
        obj["token"] = token;
        return true;
    }
    if (id == ID_SIGNUP_REQ) {
        obj["_"] = "auth.authorizationSignUpRequired";
        int32_t flags = 0;
        if (!r.i32(flags)) return false;
        obj["flags"] = flags;
        return true;
    }
    if (id == ID_EITAA_OBJECT) {
        String token, imei, packed;
        int32_t layer = 0;
        if (!r.str(token) || !r.str(imei) || !r.rawBytes(packed) || !r.i32(layer)) return false;
        (void)token;
        (void)imei;
        (void)layer;
        TlReader inner(reinterpret_cast<const uint8_t*>(packed.c_str()), packed.length());
        return decodeObject(inner, out);
    }

    obj["_"] = "unknown";
    obj["id"] = (int32_t)id;
    return true;
}

bool eitaaTlDecode(const uint8_t* data, size_t len, DynamicJsonDocument& out) {
    out.clear();
    TlReader r(data, len);
    return decodeObject(r, out);
}
