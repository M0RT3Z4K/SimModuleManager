const VALID_TYPES = new Set(['ringing', 'answered', 'active', 'ended', 'state']);

function eventError(message, status = 400) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function validateEvent(body) {
    const required = ['boot_id', 'event_id', 'sequence', 'type'];
    for (const field of required) if (body[field] === undefined || body[field] === null || body[field] === '') throw eventError(`${field} is required`);
    if (!VALID_TYPES.has(body.type)) throw eventError(`Unsupported event type: ${body.type}`);
    if (!(body.type === 'state' && body.state === 'idle') && !body.call_id) throw eventError('call_id is required');
    if (!Number.isSafeInteger(body.sequence) || body.sequence < 0) throw eventError('sequence must be a non-negative integer');
    for (const field of ['boot_id', 'event_id', 'call_id']) if (body[field] !== undefined && String(body[field]).length > 128) throw eventError(`${field} is too long`);
}

async function applyCallEvent(prisma, device, body) {
    validateEvent(body);
    const key = {
        deviceId_boot_id_event_id: { deviceId: device.id, boot_id: String(body.boot_id), event_id: String(body.event_id) }
    };
    const duplicate = await prisma.callEvent.findUnique({ where: key, include: { call: true } });
    if (duplicate) return { duplicate: true, call: duplicate.call };

    const sequenceCollision = await prisma.callEvent.findUnique({
        where: { deviceId_boot_id_sequence: { deviceId: device.id, boot_id: String(body.boot_id), sequence: body.sequence } }
    });
    if (sequenceCollision) throw eventError('Sequence already used by a different event', 409);

    if (body.type === 'state' && body.state === 'idle') {
        await prisma.callEvent.create({
            data: {
                deviceId: device.id,
                boot_id: String(body.boot_id),
                event_id: String(body.event_id),
                external_call_id: body.call_id ? String(body.call_id) : '__idle__',
                sequence: body.sequence,
                type: body.type,
                sample_counter: body.sample_counter === undefined ? null : String(body.sample_counter),
                device_monotonic_ms: body.monotonic_ms === undefined ? null : String(body.monotonic_ms),
                payload_json: JSON.stringify(body),
            }
        });
        return { duplicate: false, call: null };
    }

    const sim = await prisma.simcard.findFirst({ where: { deviceId: device.id } });
    const now = new Date();
    const callKey = {
        deviceId_boot_id_external_call_id: {
            deviceId: device.id,
            boot_id: String(body.boot_id),
            external_call_id: String(body.call_id),
        }
    };
    let call = await prisma.call.findUnique({ where: callKey });

    if (!call) {
        call = await prisma.call.create({
            data: {
                deviceId: device.id,
                boot_id: String(body.boot_id),
                external_call_id: String(body.call_id),
                caller_number: body.caller_number || null,
                sim_iccid_snapshot: sim?.iccid || null,
                sim_phone_snapshot: sim?.phone_number || null,
                ringing_at: body.type === 'ringing' ? now : null,
                state: body.type === 'ended' || (body.type === 'state' && body.state === 'ended') ? 'ended' : body.type === 'ringing' || (body.type === 'state' && body.state === 'ringing') ? 'ringing' : 'active',
                recording_status: body.type === 'ended' ? 'none' : 'waiting',
                input_sample_rate: device.input_sample_rate,
                output_sample_rate: device.output_sample_rate,
                audio_format: device.audio_format,
                audio_profile: device.audio_profile,
                boundary_mode: body.sample_counter ? 'counter_pending_stream_mapping' : 'event_received',
            }
        });
    }

    const update = {};
    if (body.caller_number && !call.caller_number) update.caller_number = body.caller_number;
    if (body.type === 'ringing' || (body.type === 'state' && body.state === 'ringing')) {
        if (!call.ringing_at) update.ringing_at = now;
        if (call.state !== 'active' && call.state !== 'ended') update.state = 'ringing';
    } else if (body.type === 'answered' || body.type === 'active' || (body.type === 'state' && body.state === 'active')) {
        if (call.state === 'ended' || call.state === 'missed') {
            update.state = 'ended';
            update.recording_status = call.recording_status === 'none' ? 'unavailable' : call.recording_status;
            update.recording_incomplete = true;
            update.recording_error = 'Answered event arrived after the end event; complete audio was not available';
            if (!call.answered_at && call.ended_at && body.sample_counter && call.ended_sample_counter && device.input_sample_rate) {
                const samples = BigInt(call.ended_sample_counter) - BigInt(body.sample_counter);
                if (samples >= 0n && samples <= BigInt(Number.MAX_SAFE_INTEGER)) {
                    update.duration_ms = Math.round(Number(samples) / device.input_sample_rate * 1000);
                    update.answered_at = new Date(call.ended_at.getTime() - update.duration_ms);
                }
            }
        } else {
            update.state = 'active';
            if (!call.answered_at) update.answered_at = now;
        }
        if (body.sample_counter !== undefined) update.answered_sample_counter = String(body.sample_counter);
    } else if (body.type === 'ended' || (body.type === 'state' && body.state === 'ended')) {
        update.state = call.answered_at ? 'ended' : 'missed';
        update.ended_at = now;
        update.end_reason = body.reason || 'unknown';
        if (body.sample_counter !== undefined) update.ended_sample_counter = String(body.sample_counter);
        const start = call.answered_at || update.answered_at;
        if (call.answered_sample_counter && body.sample_counter && device.input_sample_rate) {
            const samples = BigInt(body.sample_counter) - BigInt(call.answered_sample_counter);
            if (samples >= 0n && samples <= BigInt(Number.MAX_SAFE_INTEGER)) update.duration_ms = Math.round(Number(samples) / device.input_sample_rate * 1000);
        } else if (start) update.duration_ms = Math.max(0, now.getTime() - new Date(start).getTime());
        if (!call.answered_at && call.recording_status === 'waiting') update.recording_status = 'none';
    }

    call = await prisma.call.update({ where: { id: call.id }, data: update });
    await prisma.callEvent.create({
        data: {
            deviceId: device.id,
            callId: call.id,
            boot_id: String(body.boot_id),
            event_id: String(body.event_id),
            external_call_id: String(body.call_id),
            sequence: body.sequence,
            type: body.type,
            reason: body.reason || null,
            caller_number: body.caller_number || null,
            sample_counter: body.sample_counter === undefined ? null : String(body.sample_counter),
            device_monotonic_ms: body.monotonic_ms === undefined ? null : String(body.monotonic_ms),
            payload_json: JSON.stringify(body),
        }
    });
    return { duplicate: false, call };
}

module.exports = { applyCallEvent, validateEvent, VALID_TYPES };
