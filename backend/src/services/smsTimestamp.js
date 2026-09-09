// SIM800: yy/MM/dd,hh:mm:ss±zz; zz is an offset in quarters of an hour.
function parseSmsTimestamp(value, now = new Date()) {
    if (value === undefined || value === null || value === '') return now;
    if (typeof value !== 'string') throw new Error('Invalid SMS timestamp');
    const modem = /^(\d{2})\/(\d{2})\/(\d{2}),(\d{2}):(\d{2}):(\d{2})([+-])(\d{2})$/.exec(value);
    if (modem) {
        const [, yy, mm, dd, hh, mi, ss, sign, tz] = modem;
        const [year, month, day, hour, minute, second] =
            [2000 + Number(yy), Number(mm), Number(dd), Number(hh), Number(mi), Number(ss)];
        const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
        if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 ||
            local.getUTCDate() !== day || local.getUTCHours() !== hour ||
            local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second ||
            Number(tz) > (sign === '-' ? 47 : 48)) throw new Error('Invalid SMS timestamp');
        const offset = (sign === '-' ? -1 : 1) * Number(tz) * 15 * 60000;
        return new Date(local.getTime() - offset);
    }
    // Preserve support for ISO timestamps, requiring an explicit time zone.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
        throw new Error('Invalid SMS timestamp');
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error('Invalid SMS timestamp');
    return date;
}

module.exports = { parseSmsTimestamp };
