const { Pool } = require('pg');
require('dotenv').config();

async function setupDatabase() {
    const pool = new Pool({
        host: process.env.POSTGRES_HOST,
        port: parseInt(process.env.POSTGRES_PORT) || 5432,
        database: process.env.POSTGRES_DB,
        user: process.env.POSTGRES_USER,
        password: String(process.env.POSTGRES_PASSWORD || '')
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
                rolls_in_period INTEGER DEFAULT 0,
                period_start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                lucky_roll_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Create characters table (owned characters)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_characters (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                character_id INTEGER NOT NULL UNIQUE,
                character_name VARCHAR(255),
                character_image_url TEXT,
                anime_title VARCHAR(255),
                character_role VARCHAR(50),
                character_favorites INTEGER DEFAULT 0,
                claimed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
                is_duplicate BOOLEAN DEFAULT FALSE,
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

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_user_characters_user_id ON user_characters(user_id);
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_user_characters_character_id ON user_characters(character_id);
        `);

        console.log('✅ Database setup complete!');
        console.log('📊 Tables created:');
        console.log('   - users (stores user data and points)');
        console.log('   - user_characters (character ownership)');
        console.log('   - rolls_history (roll tracking with duplicates)');

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
