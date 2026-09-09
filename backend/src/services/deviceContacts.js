const axios = require('axios');

const CONTACTS_TIMEOUT_MS = 15000;
const MAX_CONTACTS_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CONTACTS = 5000;

function contactsError(message, code, cause) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.code = code;
    return error;
}

function normalizeContacts(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.contacts)) {
        throw contactsError('Device response must be a JSON object with a contacts array', 'INVALID_CONTACTS_JSON');
    }
    if (payload.contacts.length > MAX_CONTACTS) throw contactsError(`Device returned more than ${MAX_CONTACTS} contacts`, 'CONTACTS_LIMIT');
    return payload.contacts.map((contact, index) => {
        if (!contact || typeof contact !== 'object' || Array.isArray(contact) || typeof contact.name !== 'string' || typeof contact.phone !== 'string') {
            throw contactsError(`Invalid contact at index ${index}: name and phone must be strings`, 'INVALID_CONTACTS_JSON');
        }
        const name = contact.name.trim();
        const phone = contact.phone.trim();
        if (!phone || name.length > 256 || phone.length > 64) throw contactsError(`Invalid contact at index ${index}`, 'INVALID_CONTACTS_JSON');
        return { name, phone };
    });
}

async function fetchDeviceContacts(ipAddress, timeoutMs = CONTACTS_TIMEOUT_MS) {
    let response;
    try {
        response = await axios.get(`http://${ipAddress}/contacts`, {
            timeout: timeoutMs,
            responseType: 'json',
            maxContentLength: MAX_CONTACTS_RESPONSE_BYTES,
            transitional: { silentJSONParsing: false, forcedJSONParsing: true },
            validateStatus: status => status >= 200 && status < 300,
        });
    } catch (cause) {
        if (cause.code === 'ECONNABORTED' || cause.code === 'ETIMEDOUT') throw contactsError(`Device contacts request timed out after ${timeoutMs} ms`, 'CONTACTS_TIMEOUT', cause);
        if (cause.response && (cause.response.status < 200 || cause.response.status >= 300)) throw contactsError(`Device contacts endpoint returned HTTP ${cause.response.status}`, 'CONTACTS_HTTP_ERROR', cause);
        if (cause instanceof SyntaxError || cause.cause instanceof SyntaxError || /JSON|Unexpected token|Expected property/i.test(cause.message || '')) throw contactsError('Device returned invalid JSON for contacts', 'INVALID_CONTACTS_JSON', cause);
        if (/maxContentLength|larger than/i.test(cause.message || '')) throw contactsError('Device contacts response is too large', 'CONTACTS_LIMIT', cause);
        if (cause.response) throw contactsError('Device returned an unreadable contacts response', 'INVALID_CONTACTS_JSON', cause);
        throw contactsError(`Could not connect to device contacts endpoint: ${cause.message}`, 'CONTACTS_CONNECTION_ERROR', cause);
    }
    return normalizeContacts(response.data);
}

module.exports = { CONTACTS_TIMEOUT_MS, MAX_CONTACTS, normalizeContacts, fetchDeviceContacts };
