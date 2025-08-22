const { Pool } = require('pg');
require('dotenv').config();

async function migrateUniqueCharacters() {
    const pool = new Pool({
        host: process.env.POSTGRES_HOST,
        port: parseInt(process.env.POSTGRES_PORT) || 5432,
        database: process.env.POSTGRES_DB,
        user: process.env.POSTGRES_USER,
        password: String(process.env.POSTGRES_PASSWORD || '')
    });

    try {
        console.log('🔄 Starting character uniqueness migration...');

        // First, check if there are any duplicate character_ids
        const duplicatesCheck = await pool.query(`
            SELECT character_id, COUNT(*) as count 
            FROM user_characters 
            GROUP BY character_id 
            HAVING COUNT(*) > 1
        `);

        if (duplicatesCheck.rows.length > 0) {
            console.log(`⚠️  Found ${duplicatesCheck.rows.length} duplicate character(s):`);
            duplicatesCheck.rows.forEach(row => {
                console.log(`   Character ID ${row.character_id}: ${row.count} copies`);
            });

            // Remove duplicates, keeping only the earliest claimed one
            console.log('🧹 Removing duplicate characters (keeping earliest claims)...');
            
            for (const duplicate of duplicatesCheck.rows) {
                await pool.query(`
                    DELETE FROM user_characters 
                    WHERE character_id = $1 
                    AND id NOT IN (
                        SELECT id FROM user_characters 
                        WHERE character_id = $1 
                        ORDER BY claimed_at ASC 
                        LIMIT 1
                    )
                `, [duplicate.character_id]);
                
                console.log(`   ✅ Cleaned duplicates for character ${duplicate.character_id}`);
            }
        } else {
            console.log('✅ No duplicate characters found');
        }

        // Drop the old unique constraint if it exists
        console.log('🔄 Dropping old constraint...');
        try {
            await pool.query(`
                ALTER TABLE user_characters 
                DROP CONSTRAINT IF EXISTS user_characters_user_id_character_id_key
            `);
            console.log('✅ Old constraint dropped');
        } catch (error) {
            console.log('ℹ️  Old constraint may not exist, continuing...');
        }

        // Add the new unique constraint on character_id only
        console.log('🔄 Adding unique constraint on character_id...');
        await pool.query(`
            ALTER TABLE user_characters 
            ADD CONSTRAINT user_characters_character_id_unique 
            UNIQUE (character_id)
        `);
        
        console.log('✅ Character uniqueness migration completed!');
        console.log('📊 Characters are now globally unique - only one person can own each character');

    } catch (error) {
        console.error('❌ Migration failed:', error);
        throw error;
    } finally {
        await pool.end();
    }
}

if (require.main === module) {
    migrateUniqueCharacters().catch(console.error);
}

module.exports = { migrateUniqueCharacters };
