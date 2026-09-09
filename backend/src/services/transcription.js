const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { wavFileChunks } = require('../audio/wav');

function transcriptionUrl(baseUrl) {
    const url = new URL(baseUrl);
    let basePath = url.pathname.replace(/\/+$/, '');
    if (!basePath.endsWith('/v1')) basePath = `${basePath}/v1`;
    url.pathname = `${basePath}/audio/transcriptions`;
    return url.toString();
}

function retryableStatus(status) { return status === 408 || status === 409 || status === 429 || status >= 500; }

function mergeOverlap(left, right) {
    if (!left) return right.trim();
    if (!right) return left.trim();
    const a = left.trim().split(/\s+/);
    const b = right.trim().split(/\s+/);
    const max = Math.min(30, a.length, b.length);
    let overlap = 0;
    for (let size = max; size >= 1; size--) {
        if (a.slice(-size).join(' ') === b.slice(0, size).join(' ')) { overlap = size; break; }
    }
    return [...a, ...b.slice(overlap)].join(' ');
}

async function transcribeChunk(buffer, index, provider) {
    if (!config.transcriptionApiKey) {
        const error = new Error('TRANSCRIPTION_API_KEY is not configured on the server');
        error.retryable = false;
        throw error;
    }
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'audio/wav' }), `call-part-${index + 1}.wav`);
    form.append('model', provider.model);
    if (provider.language && provider.supports_language) form.append('language', provider.language);
    if (provider.response_format && provider.supports_response_format) form.append('response_format', provider.response_format);
    let response;
    try {
        response = await fetch(transcriptionUrl(provider.base_url), {
            method: 'POST',
            headers: { Authorization: `Bearer ${config.transcriptionApiKey}` },
            body: form,
            signal: AbortSignal.timeout(provider.timeout_ms),
        });
    } catch (cause) {
        const error = new Error(`Transcription request failed or timed out: ${cause.message}`);
        error.retryable = true;
        throw error;
    }
    const body = await response.text();
    if (!response.ok) {
        const error = new Error(`Transcription provider HTTP ${response.status}: ${body.slice(0, 500)}`);
        error.retryable = retryableStatus(response.status);
        error.status = response.status;
        throw error;
    }
    if (provider.response_format === 'text') return body.trim();
    try {
        const parsed = JSON.parse(body);
        if (typeof parsed.text !== 'string') throw new Error('response has no text field');
        return parsed.text.trim();
    } catch (cause) {
        const error = new Error(`Unsupported transcription response: ${cause.message}`);
        error.retryable = false;
        throw error;
    }
}

async function transcribeCall(call, provider) {
    const filePath = call.processed_path || call.original_path;
    if (!filePath || !fs.existsSync(filePath)) throw new Error('No playable audio file is available');
    let transcript = '';
    let count = 0;
    for (const chunk of wavFileChunks(filePath, provider.max_file_bytes, provider.chunk_overlap_ms)) {
        transcript = mergeOverlap(transcript, await transcribeChunk(chunk, count, provider));
        count++;
    }
    if (count === 0) {
        const error = new Error('Audio file contains no samples');
        error.retryable = false;
        throw error;
    }
    return { transcript, chunks: count, source: path.basename(filePath) };
}

module.exports = { transcriptionUrl, retryableStatus, mergeOverlap, transcribeCall };
