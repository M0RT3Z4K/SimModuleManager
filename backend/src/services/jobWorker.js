const crypto = require('node:crypto');
const { processCallAudio, PROCESSING_VERSION } = require('./audioProcessing');
const { transcribeCall } = require('./transcription');

class JobWorker {
    constructor(prisma) {
        this.prisma = prisma;
        this.owner = `${process.pid}-${crypto.randomUUID()}`;
        this.running = new Set();
    }

    async start() {
        await this.recover();
        await this.tick();
        this.timer = setInterval(() => this.tick().catch(error => console.error('Job worker failed:', error)), 1000);
    }

    async recover() {
        await this.prisma.processingJob.updateMany({
            where: { status: 'running', locked_at: { lt: new Date(Date.now() - 10 * 60 * 1000) } },
            data: { status: 'queued', locked_by: null, locked_at: null, last_error: 'Recovered after worker interruption' }
        });
    }

    async tick() {
        const provider = await this.prisma.providerConfig.upsert({ where: { id: 'default' }, update: {}, create: { id: 'default' } });
        const capacity = Math.max(0, provider.concurrency - this.running.size);
        if (!capacity) return;
        const candidates = await this.prisma.processingJob.findMany({
            where: { status: 'queued', run_after: { lte: new Date() } },
            orderBy: { created_at: 'asc' },
            take: capacity * 2,
        });
        for (const candidate of candidates) {
            if (this.running.size >= provider.concurrency) break;
            const claimed = await this.prisma.$transaction(async tx => {
                if (candidate.type === 'transcribe') {
                    const providerRequests = await tx.processingJob.count({ where: { type: 'transcribe', status: 'running' } });
                    if (providerRequests >= provider.concurrency) return false;
                }
                const result = await tx.processingJob.updateMany({
                    where: { id: candidate.id, status: 'queued' },
                    data: { status: 'running', locked_by: this.owner, locked_at: new Date(), attempts: { increment: 1 } }
                });
                return result.count === 1;
            });
            if (!claimed) continue;
            this.running.add(candidate.id);
            this.execute(candidate.id, provider).finally(() => this.running.delete(candidate.id));
        }
    }

    async execute(jobId, provider) {
        const job = await this.prisma.processingJob.findUnique({ where: { id: jobId }, include: { call: true } });
        if (!job) return;
        try {
            if (job.type === 'process') await this.process(job, provider);
            else if (job.type === 'transcribe') await this.transcribe(job, provider);
            else throw new Error(`Unknown job type: ${job.type}`);
            await this.prisma.processingJob.update({ where: { id: job.id }, data: { status: 'done', locked_by: null, locked_at: null, last_error: null } });
        } catch (error) {
            await this.fail(job, error);
        }
    }

    async process(job, provider) {
        await this.prisma.call.update({ where: { id: job.callId }, data: { processing_status: 'processing', processing_attempts: { increment: 1 }, processing_error: null } });
        try {
            const result = await processCallAudio(job.call);
            await this.prisma.call.update({
                where: { id: job.callId },
                data: { processed_path: result.outputPath, audio_profile: result.profile, quality_json: JSON.stringify(result.quality), processing_version: PROCESSING_VERSION, processing_status: 'ready', transcription_status: 'queued' }
            });
            await this.prisma.processingJob.upsert({
                where: { callId_type_version: { callId: job.callId, type: 'transcribe', version: '1' } },
                update: { status: 'queued', run_after: new Date(), locked_by: null, locked_at: null, max_attempts: provider.max_attempts },
                create: { callId: job.callId, type: 'transcribe', version: '1', max_attempts: provider.max_attempts },
            });
        } catch (error) {
            if (error.noSignal) {
                await this.prisma.call.update({ where: { id: job.callId }, data: { processing_status: 'no_signal', transcription_status: 'skipped', processing_error: error.message, quality_json: JSON.stringify({ original: error.quality }) } });
                return;
            }
            await this.prisma.call.update({ where: { id: job.callId }, data: { processing_status: 'failed', processing_error: error.message } });
            throw error;
        }
    }

    async transcribe(job, provider) {
        await this.prisma.call.update({ where: { id: job.callId }, data: { transcription_status: 'transcribing', transcription_attempts: { increment: 1 }, transcription_error: null } });
        try {
            const result = await transcribeCall(job.call, provider);
            await this.prisma.call.update({
                where: { id: job.callId },
                data: { transcript: result.transcript, transcript_language: provider.language || 'auto', transcript_provider: new URL(provider.base_url).origin, transcript_model: provider.model, transcription_status: 'ready' }
            });
        } catch (error) {
            await this.prisma.call.update({ where: { id: job.callId }, data: { transcription_status: 'failed', transcription_error: error.message } });
            throw error;
        }
    }

    async fail(job, error) {
        const current = await this.prisma.processingJob.findUnique({ where: { id: job.id } });
        const retry = error.retryable !== false && current.attempts < current.max_attempts;
        const delay = Math.min(60000, 1000 * 2 ** Math.max(0, current.attempts - 1)) + Math.floor(Math.random() * 500);
        await this.prisma.processingJob.update({
            where: { id: job.id },
            data: { status: retry ? 'queued' : 'failed', run_after: new Date(Date.now() + delay), locked_by: null, locked_at: null, last_error: error.message }
        });
    }

    stop() { clearInterval(this.timer); }
}

module.exports = { JobWorker };
