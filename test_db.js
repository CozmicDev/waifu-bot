const { Pool } = require('pg');

async function testDB() {
    const db = new Pool({
        host: 'localhost',
        port: 5432,
        database: 'waifu_bot',
        user: 'waifu_user',
        password: 'waifu'
    });

    try {
        console.log('Testing database connection...');
        const result = await db.query('SELECT NOW()');
        console.log('✅ Connected to database at:', result.rows[0].now);
        
        // Try to add the column
        try {
            await db.query('ALTER TABLE users ADD COLUMN lucky_roll_count INTEGER DEFAULT 0;');
            console.log('✅ Added lucky_roll_count column');
        } catch (error) {
            if (error.code === '42701') {
                console.log('Column already exists');
            } else {
                console.error('Error adding column:', error.message);
            }
        }
        
    } catch (error) {
        console.error('Database connection error:', error.message);
    } finally {
        await db.end();
    }
}

testDB();
