const { Pool } = require('pg');
require('dotenv').config();

async function addLuckyColumn() {
    const db = new Pool({
        host: process.env.POSTGRES_HOST,
        port: parseInt(process.env.POSTGRES_PORT) || 5432,
        database: process.env.POSTGRES_DB,
        user: process.env.POSTGRES_USER,
        password: String(process.env.POSTGRES_PASSWORD || '')
    });

    try {
        console.log('Connecting to database...');
        
        // Check if column exists first
        const checkColumn = `
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'users' AND column_name = 'lucky_roll_count';
        `;
        
        const columnExists = await db.query(checkColumn);
        
        if (columnExists.rows.length > 0) {
            console.log('lucky_roll_count column already exists');
        } else {
            console.log('Adding lucky_roll_count column...');
            await db.query('ALTER TABLE users ADD COLUMN lucky_roll_count INTEGER DEFAULT 0;');
            console.log('✅ Successfully added lucky_roll_count column');
        }
        
        // Show current table structure
        const tableInfo = await db.query(`
            SELECT column_name, data_type, is_nullable, column_default 
            FROM information_schema.columns 
            WHERE table_name = 'users' 
            ORDER BY ordinal_position;
        `);
        
        console.log('\nCurrent users table structure:');
        tableInfo.rows.forEach(row => {
            console.log(`- ${row.column_name}: ${row.data_type} (default: ${row.column_default})`);
        });
        
    } catch (error) {
        console.error('Error:', error);
    } finally {
        await db.end();
    }
}

addLuckyColumn();
