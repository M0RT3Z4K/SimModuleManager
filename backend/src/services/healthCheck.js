const cron = require('node-cron');
const axios = require('axios');

function startHealthCheckDaemon(prisma) {
    const task = cron.schedule('* * * * *', async () => {
        console.log('Running health check daemon...');
        try {
            const onlineSims = await prisma.simcard.findMany({
                where: { status: 'online' }
            });

            for (const sim of onlineSims) {
                if (!sim.ip_address) continue;

                try {
                    const response = await axios.get(`http://${sim.ip_address}/health`, { timeout: 5000 });
                    
                    if (response.data && response.data.status === 'ok' && response.data.network === true && response.data.iccid === sim.iccid) {
                        // Update last_seen
                        await prisma.simcard.update({
                            where: { iccid: sim.iccid },
                            data: { last_seen: new Date() }
                        });
                        if (sim.deviceId) {
                            await prisma.device.update({ where: { id: sim.deviceId }, data: { health_json: JSON.stringify(response.data), ip_address: sim.ip_address } });
                        }
                    } else {
                        // Status is not ok or network is false, or iccid mismatch
                        await prisma.simcard.update({
                            where: { iccid: sim.iccid },
                            data: { status: 'offline' }
                        });
                    }
                } catch (error) {
                    // Timeout or failed request
                    await prisma.simcard.update({
                        where: { iccid: sim.iccid },
                        data: { status: 'offline' }
                    });
                }
            }
        } catch (err) {
            console.error('Error in health check daemon:', err);
        }
    });
    return () => task.stop();
}

module.exports = { startHealthCheckDaemon };
