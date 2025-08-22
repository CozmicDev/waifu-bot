const { Pool } = require('pg');
require('dotenv').config();

async function refundUser() {
    const pool = new Pool({
        host: process.env.POSTGRES_HOST,
        port: parseInt(process.env.POSTGRES_PORT) || 5432,
        database: process.env.POSTGRES_DB,
        user: process.env.POSTGRES_USER,
        password: String(process.env.POSTGRES_PASSWORD || '')
    });

    try {
        console.log('🔄 Processing refund...');

        // Add 100,000 points to user 153872594217598976
        const result = await pool.query(`
            UPDATE users 
            SET total_points = total_points + 25000 
            WHERE discord_id = $1 
            RETURNING total_points, username
        `, ['115724975398322176']);

        if (result.rows.length > 0) {
            const user = result.rows[0];
            console.log(`✅ Refunded 100,000 points to ${user.username}`);
            console.log(`💰 New balance: ${user.total_points} points`);
        } else {
            console.log('❌ User not found');
        }

    } catch (error) {
        console.error('❌ Refund failed:', error);
    } finally {
        await pool.end();
    }
}

if (require.main === module) {
    refundUser().catch(console.error);
}

module.exports = { refundUser };
