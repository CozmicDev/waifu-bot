const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const Redis = require('redis');
const { Pool } = require('pg');
require('dotenv').config();

class WaifuBot {
    constructor() {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent
            ]
        });

        this.redis = Redis.createClient({
            host: process.env.REDIS_HOST,
            port: process.env.REDIS_PORT,
            password: process.env.REDIS_PASSWORD
        });

        this.db = new Pool({
            host: process.env.POSTGRES_HOST,
            port: process.env.POSTGRES_PORT,
            database: process.env.POSTGRES_DB,
            user: process.env.POSTGRES_USER,
            password: process.env.POSTGRES_PASSWORD
        });

        this.maxCharacterId = parseInt(process.env.MAX_CHARACTER_ID) || 276935;
        this.cacheTTL = parseInt(process.env.CACHE_TTL) || 3600;

        this.setupEventHandlers();
        this.connectToServices();
    }

    async connectToServices() {
        try {
            await this.redis.connect();
            console.log('✅ Connected to Redis');
            
            await this.db.query('SELECT NOW()');
            console.log('✅ Connected to PostgreSQL');
        } catch (error) {
            console.error('❌ Failed to connect to services:', error);
            process.exit(1);
        }
    }

    setupEventHandlers() {
        this.client.once('ready', () => {
            console.log(`✅ Bot is ready! Logged in as ${this.client.user.tag}`);
        });

        this.client.on('messageCreate', async (message) => {
            if (message.author.bot) return;

            if (message.content.startsWith('!roll')) {
                await this.handleRollCommand(message);
            } else if (message.content.startsWith('!points')) {
                await this.handlePointsCommand(message);
            } else if (message.content.startsWith('!leaderboard')) {
                await this.handleLeaderboardCommand(message);
            }
        });
    }

    async handleRollCommand(message) {
        try {
            const randomId = Math.floor(Math.random() * this.maxCharacterId) + 1;
            const character = await this.getCharacter(randomId);

            if (!character) {
                await message.reply('❌ Failed to fetch character. Try again!');
                return;
            }

            const points = this.calculatePoints(character.favorites || 0);
            await this.addUserPoints(message.author.id, message.author.username, points);

            const embed = this.createCharacterEmbed(character, points, message.author);
            await message.reply({ embeds: [embed] });

        } catch (error) {
            console.error('Error in roll command:', error);
            await message.reply('❌ Something went wrong while rolling for a character!');
        }
    }

    async handlePointsCommand(message) {
        try {
            const user = await this.getUser(message.author.id);
            const totalPoints = user ? user.total_points : 0;
            
            await message.reply(`🏆 You have **${totalPoints}** points total!`);
        } catch (error) {
            console.error('Error in points command:', error);
            await message.reply('❌ Failed to fetch your points!');
        }
    }

    async handleLeaderboardCommand(message) {
        try {
            const topUsers = await this.getTopUsers(10);
            
            if (topUsers.length === 0) {
                await message.reply('📊 No users found on the leaderboard yet!');
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle('🏆 Leaderboard - Top 10')
                .setColor(0x00AE86)
                .setTimestamp();

            let description = '';
            topUsers.forEach((user, index) => {
                const medal = index < 3 ? ['🥇', '🥈', '🥉'][index] : `${index + 1}.`;
                description += `${medal} **${user.username}** - ${user.total_points} points\n`;
            });

            embed.setDescription(description);
            await message.reply({ embeds: [embed] });

        } catch (error) {
            console.error('Error in leaderboard command:', error);
            await message.reply('❌ Failed to fetch leaderboard!');
        }
    }

    async getCharacter(id) {
        const cacheKey = `character:${id}`;
        
        try {
            // Try to get from cache first
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }

            // Fetch from API
            const response = await axios.get(`${process.env.JIKAN_BASE_URL}/characters/${id}`);
            const character = response.data.data;

            // Cache the result
            await this.redis.setEx(cacheKey, this.cacheTTL, JSON.stringify(character));
            
            return character;
        } catch (error) {
            if (error.response && error.response.status === 404) {
                // Character doesn't exist, try another one
                return null;
            }
            console.error(`Error fetching character ${id}:`, error.message);
            return null;
        }
    }

    calculatePoints(favorites) {
        // Point system based on favorites
        if (favorites === 0) return 1;
        if (favorites < 10) return 2;
        if (favorites < 50) return 5;
        if (favorites < 100) return 10;
        if (favorites < 500) return 25;
        if (favorites < 1000) return 50;
        if (favorites < 5000) return 100;
        return 250; // For very popular characters
    }

    createCharacterEmbed(character, points, user) {
        const embed = new EmbedBuilder()
            .setTitle(character.name || 'Unknown Character')
            .setColor(0x00AE86)
            .setThumbnail(character.images?.jpg?.image_url || character.image_url)
            .addFields(
                { name: '❤️ Favorites', value: (character.favorites || 0).toString(), inline: true },
                { name: '🏆 Points Earned', value: points.toString(), inline: true }
            )
            .setFooter({ 
                text: `Rolled by ${user.username}`, 
                iconURL: user.displayAvatarURL() 
            })
            .setTimestamp();

        if (character.about) {
            const truncatedAbout = character.about.length > 300 
                ? character.about.substring(0, 300) + '...' 
                : character.about;
            embed.setDescription(truncatedAbout);
        }

        return embed;
    }

    async addUserPoints(userId, username, points) {
        const query = `
            INSERT INTO users (discord_id, username, total_points, last_roll) 
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (discord_id) 
            DO UPDATE SET 
                total_points = users.total_points + $3,
                last_roll = NOW(),
                username = $2
        `;
        
        await this.db.query(query, [userId, username, points]);
    }

    async getUser(userId) {
        const query = 'SELECT * FROM users WHERE discord_id = $1';
        const result = await this.db.query(query, [userId]);
        return result.rows[0];
    }

    async getTopUsers(limit = 10) {
        const query = `
            SELECT username, total_points 
            FROM users 
            ORDER BY total_points DESC 
            LIMIT $1
        `;
        const result = await this.db.query(query, [limit]);
        return result.rows;
    }

    async start() {
        await this.client.login(process.env.DISCORD_TOKEN);
    }

    async shutdown() {
        console.log('🔄 Shutting down bot...');
        await this.redis.quit();
        await this.db.end();
        this.client.destroy();
        console.log('✅ Bot shutdown complete');
    }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    if (global.bot) {
        await global.bot.shutdown();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    if (global.bot) {
        await global.bot.shutdown();
    }
    process.exit(0);
});

// Start the bot
const bot = new WaifuBot();
global.bot = bot;
bot.start().catch(console.error);
