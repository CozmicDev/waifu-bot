const { Pool } = require('pg');
require('dotenv').config();

async function migrateDatabase() {
    const pool = new Pool({
        host: process.env.POSTGRES_HOST,
        port: parseInt(process.env.POSTGRES_PORT) || 5432,
        database: process.env.POSTGRES_DB,
        user: process.env.POSTGRES_USER,
        password: String(process.env.POSTGRES_PASSWORD || '')
    });

    try {
        console.log('🔄 Migrating database schema...');

        // Add is_duplicate column to rolls_history table if it doesn't exist
        await pool.query(`
            ALTER TABLE rolls_history 
            ADD COLUMN IF NOT EXISTS is_duplicate BOOLEAN DEFAULT FALSE;
        `);

        // Add new columns for roll limiting
        await pool.query(`
            ALTER TABLE users 
            ADD COLUMN IF NOT EXISTS rolls_in_period INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS period_start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
        `);

        // Create user_characters table if it doesn't exist
        await pool.query(`
            CREATE TABLE IF NOT EXISTS user_characters (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                character_id INTEGER NOT NULL,
                character_name VARCHAR(255),
                character_image_url TEXT,
                anime_title VARCHAR(255),
                character_role VARCHAR(50),
                character_favorites INTEGER DEFAULT 0,
                claimed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, character_id)
            );
        `);

        // Create indexes for user_characters table
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_user_characters_user_id ON user_characters(user_id);
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_user_characters_character_id ON user_characters(character_id);
        `);

        console.log('✅ Database migration complete!');
        console.log('📊 Changes applied:');
        console.log('   - Added is_duplicate column to rolls_history');
        console.log('   - Created user_characters table');
        console.log('   - Added indexes for better performance');

    } catch (error) {
        console.error('❌ Database migration failed:', error);
    } finally {
        await pool.end();
    }
}

if (require.main === module) {
    migrateDatabase();
}

module.exports = { migrateDatabase };
