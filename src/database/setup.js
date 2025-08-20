const { Pool } = require('pg');
require('dotenv').config();

async function setupDatabase() {
    const pool = new Pool({
        host: process.env.POSTGRES_HOST,
        port: process.env.POSTGRES_PORT,
        database: process.env.POSTGRES_DB,
        user: process.env.POSTGRES_USER,
        password: process.env.POSTGRES_PASSWORD
    });

    try {
        console.log('🔄 Setting up database tables...');

        // Create users table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                discord_id VARCHAR(20) UNIQUE NOT NULL,
                username VARCHAR(100) NOT NULL,
                total_points INTEGER DEFAULT 0,
                rolls_count INTEGER DEFAULT 0,
                last_roll TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Create rolls history table (optional, for tracking all rolls)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS rolls_history (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                character_id INTEGER NOT NULL,
                character_name VARCHAR(255),
                character_favorites INTEGER DEFAULT 0,
                points_earned INTEGER NOT NULL,
                rolled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Create indexes for better performance
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_users_discord_id ON users(discord_id);
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_users_total_points ON users(total_points DESC);
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_rolls_user_id ON rolls_history(user_id);
        `);

        console.log('✅ Database setup complete!');
        console.log('📊 Tables created:');
        console.log('   - users (stores user data and points)');
        console.log('   - rolls_history (optional roll tracking)');

    } catch (error) {
        console.error('❌ Database setup failed:', error);
    } finally {
        await pool.end();
    }
}

if (require.main === module) {
    setupDatabase();
}

module.exports = { setupDatabase };
