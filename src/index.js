const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
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

        // Store pending claims with timers
        this.pendingClaims = new Map();
        
        // Store pending trades
        this.pendingTrades = new Map();

        // Roll locks to prevent simultaneous rolling
        this.rollLocks = new Set();

        // Snipe cooldowns - stores user ID -> timestamp
        this.snipeCooldowns = new Map();

        this.startupTime = new Date().toISOString();
        console.log(`🚀 Bot started at: ${this.startupTime}`);

        this.redis = Redis.createClient({
            host: process.env.REDIS_HOST,
            port: process.env.REDIS_PORT,
            password: process.env.REDIS_PASSWORD
        });

        this.db = new Pool({
            host: process.env.POSTGRES_HOST,
            port: parseInt(process.env.POSTGRES_PORT) || 5432,
            database: process.env.POSTGRES_DB,
            user: process.env.POSTGRES_USER,
            password: String(process.env.POSTGRES_PASSWORD || '')
        });

        this.maxCharacterId = parseInt(process.env.MAX_CHARACTER_ID) || 276935;
        this.cacheTTL = parseInt(process.env.CACHE_TTL) || 3600;
        this.rollCooldown = (parseInt(process.env.ROLL_COOLDOWN) || 10) * 1000; // Convert seconds to milliseconds
        this.maxRollsPerPeriod = 3; // 3 rolls per period
        this.rollPeriod = 10 * 1000; // 10 seconds in milliseconds

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
            } else if (message.content.startsWith('!collection')) {
                await this.handleCollectionCommand(message);
            } else if (message.content.startsWith('!help')) {
                await this.handleHelpCommand(message);
            } else if (message.content.startsWith('!trade')) {
                await this.handleTradeCommand(message);
            } else if (message.content.startsWith('!pack')) {
                await this.handlePackCommand(message);
            } else if (message.content.startsWith('!lucky')) {
                await this.handleLuckyCommand(message);
            } else if (message.content.startsWith('!give')) {
                await this.handleGiveCommand(message);
            } else if (message.content.startsWith('!test')) {
                // Test command to check characters
                const userId = await this.getUserId(message.author.id, message.author.username);
                const characters = await this.getUserCharacters(userId);
                await message.reply(`You have ${characters.length} characters.`);
            }
        });

        this.client.on('interactionCreate', async (interaction) => {
            if (interaction.isButton()) {
                if (interaction.customId.startsWith('claim_')) {
                    await this.handleClaimButton(interaction);
                } else if (interaction.customId.startsWith('snipe_')) {
                    await this.handleSnipeButton(interaction);
                } else if (interaction.customId.startsWith('collection_')) {
                    await this.handleCollectionPagination(interaction);
                } else if (interaction.customId.startsWith('trade_')) {
                    await this.handleTradeButton(interaction);
                } else if (interaction.customId.startsWith('pack_confirm_')) {
                    await this.handlePackConfirmation(interaction);
                } else if (interaction.customId.startsWith('pack_cancel_')) {
                    await this.handlePackConfirmation(interaction);
                } else if (interaction.customId.startsWith('give_confirm_')) {
                    await this.handleGiveConfirmation(interaction);
                } else if (interaction.customId.startsWith('give_cancel_')) {
                    await this.handleGiveConfirmation(interaction);
                }
            } else if (interaction.isStringSelectMenu()) {
                if (interaction.customId.startsWith('collection_')) {
                    await this.handleCollectionPagination(interaction);
                }
            }
        });
    }

    async handleRollCommand(message) {
        // Add a simple lock to prevent multiple simultaneous rolls
        const lockKey = `rolling_${message.author.id}`;
        if (this.rollLocks.has(lockKey)) {
            await message.reply('⏰ Please wait, you have a roll in progress!');
            return;
        }

        // Set lock
        this.rollLocks.add(lockKey);

        try {
            // Check for reserved character first
            const reservationKey = `reserved_character:${message.author.id}`;
            const reservedData = await this.redis.get(reservationKey);
            
            if (reservedData) {
                // User has a reserved character - give them that instead of rolling
                const reservation = JSON.parse(reservedData);
                
                // Remove the reservation
                await this.redis.del(reservationKey);
                
                // Create user in database if needed
                const userId = await this.getUserId(message.author.id, message.author.username);
                
                // Give them the reserved character
                await this.claimCharacter(userId, reservation.characterId, reservation.character, reservation.animeInfo);
                
                // Calculate points for the character
                const points = this.calculatePoints(reservation.character.favorites, reservation.animeInfo);
                
                // Record the roll
                await this.recordRoll(userId, reservation.characterId, reservation.character, points, false);
                
                // Update user points
                await this.addUserPoints(userId, message.author.username, points);
                
                // Create special reserved character embed
                const embed = new EmbedBuilder()
                    .setTitle('🎁 Reserved Character Claimed!')
                    .setColor('#FFD700') // Gold color for special reserved character
                    .setDescription(`You received your reserved character!`)
                    .addFields([
                        { name: '🎭 Character', value: reservation.character.name, inline: true },
                        { name: '📺 Anime', value: reservation.animeInfo.title, inline: true },
                        { name: '❤️ Favorites', value: reservation.character.favorites?.toString() || '0', inline: true },
                        { name: '🏆 Points Earned', value: `${points}`, inline: true },
                        { name: '🎁 Special Gift', value: 'This character was reserved for you by an admin!', inline: false }
                    ])
                    .setImage(reservation.character.images?.jpg?.image_url)
                    .setFooter({ 
                        text: `Reserved character claimed • Unsnipeable`, 
                        iconURL: message.author.displayAvatarURL() 
                    })
                    .setTimestamp();

                // Create claim button (but make it immediately claimed)
                const claimButton = new ButtonBuilder()
                    .setCustomId(`reserved_claimed_${message.author.id}`)
                    .setLabel('✅ Auto-Claimed')
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(true);

                const row = new ActionRowBuilder().addComponents(claimButton);

                await message.reply({ embeds: [embed], components: [row] });
                return;
            }

                // Check cooldown first
                const cooldownCheck = await this.checkCooldown(message.author.id);
            if (cooldownCheck.onCooldown) {
                const timeLeft = Math.ceil(cooldownCheck.timeLeft / 1000);
                await message.reply(`⏰ You've used all your rolls! You can roll again in **${timeLeft} seconds**.`);
                return;
            }

            let attempts = 0;
            let character = null;
            
            // Try to get a valid character (up to 5 attempts)
            while (!character && attempts < 5) {
                const randomId = Math.floor(Math.random() * this.maxCharacterId) + 1;
                character = await this.getCharacter(randomId);
                attempts++;
            }

            if (!character) {
                const rollsLeft = cooldownCheck.rollsLeft - 1;
                await message.reply(`❌ Couldn't find a character this time. You have **${rollsLeft} rolls** left this period.`);
                await this.incrementRollCount(message.author.id);
                return;
            }

            // Fetch anime information for the character
            const animeInfo = await this.getCharacterAnime(character.mal_id);
            
            // Check if user already owns this character
            const userId = await this.getUserId(message.author.id, message.author.username);
            const alreadyOwned = await this.checkCharacterOwnership(userId, character.mal_id);
            
            // Get current lucky roll progress before checking
            // Get current lucky roll count BEFORE incrementing
            const preRollProgress = await this.getLuckyRollProgress(message.author.id);
            
            // Increment the roll count for this roll
            await this.incrementRollCount(message.author.id);
            await this.incrementLuckyRollCount(message.author.id);
            
            // Check if this roll should be a lucky roll (after incrementing, check if we hit 10, 20, 30, etc.)
            const postRollProgress = await this.getLuckyRollProgress(message.author.id);
            const isLuckyRoll = postRollProgress.isLuckyRoll;
            
            let points = this.calculatePoints(character.favorites || 0, animeInfo, isLuckyRoll);
            
            let isDuplicate = false;

            // If this was a lucky roll, reset the counter for next cycle
            if (isLuckyRoll) {
                await this.resetLuckyRollCount(message.author.id);
            }
            
            // Get final progress for display (after potential reset)
            const displayProgress = await this.getLuckyRollProgress(message.author.id);
            
            const rollsLeft = cooldownCheck.rollsLeft - 1;

            if (alreadyOwned) {
                // Give duplicate bonus immediately - no need to claim
                points += 150;
                isDuplicate = true;
                await this.addUserPoints(message.author.id, message.author.username, points);
                await this.recordRoll(userId, character.mal_id, character, points, isDuplicate);

                const embed = this.createCharacterEmbed(character, points, message.author, animeInfo, isDuplicate, rollsLeft, isLuckyRoll, displayProgress);
                await message.reply({ embeds: [embed] });
            } else {
                // Create claim button and conditionally create snipe button
                const claimId = `claim_${message.author.id}_${character.mal_id}_${Date.now()}`;
                
                const claimButton = new ButtonBuilder()
                    .setCustomId(claimId)
                    .setLabel('🎯 Claim Character')
                    .setStyle(ButtonStyle.Success);

                const row = new ActionRowBuilder().addComponents(claimButton);

                // Only add snipe button if it's NOT a lucky roll
                if (!isLuckyRoll) {
                    const snipeId = `snipe_${message.author.id}_${character.mal_id}_${Date.now()}`;
                    const snipeButton = new ButtonBuilder()
                        .setCustomId(snipeId)
                        .setLabel('🥷 Snipe')
                        .setStyle(ButtonStyle.Danger);
                    
                    row.addComponents(snipeButton);
                    
                    // Store claim data for snipe button too
                    const claimData = {
                        userId: userId,
                        characterId: character.mal_id,
                        character: character,
                        animeInfo: animeInfo,
                        points: points,
                        rollerId: message.author.id,
                        messageId: null, // Will be set after reply
                        channelId: message.channel.id,
                        rollsLeft: rollsLeft
                    };
                    this.pendingClaims.set(snipeId, claimData);
                }

                const embed = this.createClaimableEmbed(character, points, message.author, animeInfo, rollsLeft, isLuckyRoll, displayProgress);
                
                const reply = await message.reply({ 
                    embeds: [embed], 
                    components: [row] 
                });

                // Store the claim data for claim button
                const claimData = {
                    userId: userId,
                    characterId: character.mal_id,
                    character: character,
                    animeInfo: animeInfo,
                    points: points,
                    rollerId: message.author.id,
                    messageId: reply.id,
                    channelId: message.channel.id,
                    rollsLeft: rollsLeft
                };

                this.pendingClaims.set(claimId, claimData);

                console.log(`Stored claim: ${claimId} for user ${message.author.id}, character ${character.mal_id}${isLuckyRoll ? ' (Lucky Roll - No Snipe)' : ''}`);

                // Set 30 second timer
                setTimeout(async () => {
                    if (this.pendingClaims.has(claimId)) {
                        console.log(`Expiring claim: ${claimId}`);
                        await this.expireClaim(claimId, reply);
                    }
                }, 30000);
            }

        } catch (innerError) {
            console.error('Error in roll command:', innerError);
            await message.reply('❌ Something went wrong while rolling for a character!');
        } finally {
            // Always release the lock
            this.rollLocks.delete(lockKey);
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

    async handleLuckyCommand(message) {
        try {
            const luckyProgress = await this.getLuckyRollProgress(message.author.id);
            
            const embed = new EmbedBuilder()
                .setTitle('🍀 Lucky Roll Progress')
                .setColor('#FF69B4')
                .addFields([
                    { name: '🎲 Current Roll Count', value: `${luckyProgress.currentCount}/10`, inline: true },
                    { name: '🍀 Rolls Until Lucky', value: `${luckyProgress.rollsUntilLucky}`, inline: true },
                    { name: '✨ Next Lucky Roll', value: luckyProgress.rollsUntilLucky === 1 ? 'Next roll!' : `In ${luckyProgress.rollsUntilLucky} rolls`, inline: true }
                ])
                .setDescription('Lucky rolls guarantee at least **50 points** and are marked with a special pink color!')
                .setFooter({ text: 'Keep rolling to reach your next lucky roll!' })
                .setTimestamp();

            await message.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Error in lucky command:', error);
            await message.reply('❌ Failed to fetch your lucky roll progress!');
        }
    }

    async handleGiveCommand(message) {
        try {
            // Check if user is admin
            const adminUserId = '115724975398322176';
            if (message.author.id !== adminUserId) {
                await message.reply('❌ You do not have permission to use this command!');
                return;
            }

            // Parse command: !give @username character name
            const args = message.content.split(' ');
            if (args.length < 3) {
                await message.reply('❌ Usage: `!give @username character name`\nExample: `!give @user Naruto Uzumaki`');
                return;
            }

            // Extract target user
            let targetUser = null;
            if (message.mentions.users.size > 0) {
                targetUser = message.mentions.users.first();
            } else {
                await message.reply('❌ Please mention a user to give the character to!');
                return;
            }

            // Extract character name (everything after the mention)
            const mentionMatch = message.content.match(/<@!?(\d+)>/);
            if (!mentionMatch) {
                await message.reply('❌ Could not parse the mentioned user!');
                return;
            }

            const afterMention = message.content.substring(message.content.indexOf(mentionMatch[0]) + mentionMatch[0].length).trim();
            if (!afterMention) {
                await message.reply('❌ Please specify a character name after mentioning the user!');
                return;
            }

            const characterName = afterMention;

            // Search for character
            await message.reply('🔍 Searching for character...');
            const character = await this.searchCharacter(characterName);

            if (!character) {
                await message.reply(`❌ Could not find character: "${characterName}"`);
                return;
            }

            // Create confirmation embed
            const embed = new EmbedBuilder()
                .setTitle('🎁 Admin Give Character Confirmation')
                .setColor('#FFD700')
                .setDescription(`Are you sure you want to give this character to **${targetUser.username}**?`)
                .addFields([
                    { name: '👤 Target User', value: `${targetUser.username} (${targetUser.id})`, inline: true },
                    { name: '🎭 Character', value: character.name || 'Unknown Name', inline: true },
                    { name: '📺 Anime', value: character.anime || 'Unknown Anime', inline: true },
                    { name: '❤️ Favorites', value: character.favorites?.toString() || '0', inline: true }
                ])
                .setImage(character.images?.jpg?.image_url || character.image_url)
                .setFooter({ text: 'Click ✅ to confirm or ❌ to cancel' })
                .setTimestamp();

            const confirmButton = new ButtonBuilder()
                .setCustomId(`give_confirm_${targetUser.id}_${character.mal_id}`)
                .setLabel('✅ Confirm Give')
                .setStyle(ButtonStyle.Success);

            const cancelButton = new ButtonBuilder()
                .setCustomId(`give_cancel_${targetUser.id}_${character.mal_id}`)
                .setLabel('❌ Cancel')
                .setStyle(ButtonStyle.Danger);

            const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

            // Store the character data for the confirmation
            const giveId = `give_${targetUser.id}_${character.mal_id}_${Date.now()}`;
            this.pendingGives = this.pendingGives || new Map();
            this.pendingGives.set(giveId, {
                adminId: message.author.id,
                targetUserId: targetUser.id,
                character: character,
                channelId: message.channel.id
            });

            await message.channel.send({ embeds: [embed], components: [row] });

        } catch (error) {
            console.error('Error in give command:', error);
            await message.reply('❌ Something went wrong while processing the give command!');
        }
    }

    async handlePackCommand(message) {
        try {
            // Check if user has enough points
            const user = await this.getUser(message.author.id);
            const userPoints = user ? user.total_points : 0;
            const packCost = 1000;

            if (userPoints < packCost) {
                await message.reply(`❌ You need **${packCost}** points to buy a character pack! You only have **${userPoints}** points.`);
                return;
            }

            // Create confirmation button
            const confirmId = `pack_confirm_${message.author.id}_${Date.now()}`;
            
            const confirmButton = new ButtonBuilder()
                .setCustomId(confirmId)
                .setLabel('✅ Confirm Purchase')
                .setStyle(ButtonStyle.Success);

            const cancelButton = new ButtonBuilder()
                .setCustomId(`pack_cancel_${message.author.id}`)
                .setLabel('❌ Cancel')
                .setStyle(ButtonStyle.Secondary);

            const row = new ActionRowBuilder()
                .addComponents(confirmButton, cancelButton);

            const embed = new EmbedBuilder()
                .setTitle('📦 Character Pack Purchase')
                .setDescription(`Are you sure you want to buy a **Character Pack** for **${packCost}** points?`)
                .addFields([
                    { name: '📦 Pack Contents', value: '10 character rolls', inline: true },
                    { name: '🛡️ Special Bonus', value: 'Unsnipeable rolls!', inline: true },
                    { name: '💰 Your Points', value: `${userPoints}`, inline: true },
                    { name: '💸 Cost', value: `${packCost} points`, inline: true },
                    { name: '🏦 After Purchase', value: `${userPoints - packCost} points`, inline: true }
                ])
                .setColor('#FFD700')
                .setFooter({ text: 'This confirmation will expire in 30 seconds' })
                .setTimestamp();

            await message.reply({ 
                embeds: [embed], 
                components: [row],
                flags: MessageFlags.Ephemeral // Make the confirmation private
            });

            // Set expiration timer for confirmation (simplified)
            setTimeout(async () => {
                // The confirmation will just expire naturally after 30 seconds
                // Discord will disable the buttons automatically
            }, 30000);

        } catch (error) {
            console.error('Error in pack command:', error);
            await message.reply('❌ Failed to process pack purchase request!');
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

    async handleCollectionCommand(message) {
        try {
            // Check if there's a page number specified
            const args = message.content.split(' ');
            const requestedPage = args[1] ? parseInt(args[1]) : 1;
            
            const userId = await this.getUserId(message.author.id, message.author.username);
            const characters = await this.getUserCharacters(userId);
            
            if (characters.length === 0) {
                await message.reply('📚 Your collection is empty! Use `!roll` to start collecting characters.');
                return;
            }

            const page = Math.max(1, requestedPage);
            const { embed, components } = this.createCollectionEmbed(characters, page, message.author);
            
            await message.reply({ embeds: [embed], components: components });

        } catch (error) {
            console.error('Error in collection command:', error);
            await message.reply('❌ Failed to fetch your collection!');
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

    async getCharacterAnime(id) {
        const cacheKey = `character_anime:${id}`;
        
        try {
            // Try to get from cache first
            const cached = await this.redis.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }

            // Fetch anime information from API
            const response = await axios.get(`${process.env.JIKAN_BASE_URL}/characters/${id}/anime`);
            const animeData = response.data.data;

            // Get the first anime (most relevant) or null if none
            const animeInfo = animeData && animeData.length > 0 ? {
                title: animeData[0].anime.title,
                role: animeData[0].role,
                image: animeData[0].anime.images?.jpg?.image_url
            } : null;

            // Cache the result
            await this.redis.setEx(cacheKey, this.cacheTTL, JSON.stringify(animeInfo));
            
            return animeInfo;
        } catch (error) {
            console.error(`Error fetching character anime ${id}:`, error.message);
            return null;
        }
    }

    async searchCharacter(characterName) {
        try {
            const searchUrl = `${process.env.JIKAN_BASE_URL}/characters?q=${encodeURIComponent(characterName)}&limit=1`;
            const response = await axios.get(searchUrl);
            
            if (response.data.data && response.data.data.length > 0) {
                const character = response.data.data[0];
                
                // Get character's anime info
                let animeInfo = null;
                if (character.anime && character.anime.length > 0) {
                    animeInfo = {
                        title: character.anime[0].anime.title,
                        role: character.anime[0].role
                    };
                }
                
                return {
                    mal_id: character.mal_id,
                    name: character.name,
                    images: character.images,
                    favorites: character.favorites,
                    anime: animeInfo?.title || 'Unknown Anime',
                    role: animeInfo?.role || 'Unknown'
                };
            }
            
            return null;
        } catch (error) {
            console.error('Error searching for character:', error.message);
            return null;
        }
    }

    calculatePoints(favorites, animeInfo, isLuckyRoll = false) {
        // Base point system based on favorites
        let basePoints;
        if (favorites === 0) basePoints = 1;
        else if (favorites < 10) basePoints = 2;
        else if (favorites < 50) basePoints = 5;
        else if (favorites < 100) basePoints = 10;
        else if (favorites < 500) basePoints = 25;
        else if (favorites < 1000) basePoints = 50;
        else if (favorites < 5000) basePoints = 100;
        else basePoints = 250; // For very popular characters

        // Add bonus for main characters
        let mainCharacterBonus = 0;
        if (animeInfo && animeInfo.role && animeInfo.role.toLowerCase() === 'main') {
            mainCharacterBonus = 500;
        }

        let totalPoints = basePoints + mainCharacterBonus;

        // Lucky roll guarantee: minimum 500 points
        if (isLuckyRoll && totalPoints < 500) {
            totalPoints = 500;
        }

        return totalPoints;
    }

    createCharacterEmbed(character, points, user, animeInfo, isDuplicate = false, rollsLeft = null, isLuckyRoll = false, luckyProgress = null) {
        const embed = new EmbedBuilder()
            .setTitle(character.name || 'Unknown Character')
            .setColor(isDuplicate ? 0xFFD700 : (isLuckyRoll ? 0xFF69B4 : 0x00AE86)) // Gold for duplicates, pink for lucky, green for normal
            .setThumbnail(character.images?.jpg?.image_url || character.image_url)
            .addFields(
                { name: '❤️ Favorites', value: (character.favorites || 0).toString(), inline: true },
                { name: '🏆 Points Earned', value: points.toString(), inline: true }
            );

        // Add lucky roll progress if available
        if (luckyProgress) {
            let progressText;
            if (isLuckyRoll) {
                progressText = '🍀✨🌟 LUCKY ROLL! 🌟✨🍀';
            } else if (luckyProgress.rollsUntilLucky === 1) {
                progressText = '🍀 Next roll is LUCKY! 🍀';
            } else {
                progressText = `🍀 Lucky in ${luckyProgress.rollsUntilLucky} rolls`;
            }
            embed.addFields({ name: '� Lucky Progress', value: progressText, inline: true });
        }

        // Add special lucky roll indicator
        if (isLuckyRoll) {
            embed.addFields({ 
                name: '🍀🌟✨ LUCKY ROLL BONUS ✨🌟🍀', 
                value: '🎉 Minimum 500 points guaranteed! 🎉', 
                inline: false 
            });
        }

        embed.setFooter({ 
                text: `Rolled by ${user.username}${isDuplicate ? ' • Duplicate!' : ''}${isLuckyRoll ? ' • 🍀✨ LUCKY ROLL! ✨🍀' : ''}`, 
                iconURL: user.displayAvatarURL() 
            })
            .setTimestamp();

        // Add anime information if available
        if (animeInfo) {
            embed.addFields(
                { name: '📺 Anime', value: animeInfo.title, inline: true },
                { name: '🎭 Role', value: animeInfo.role, inline: true }
            );

            // Add main character bonus indicator
            if (animeInfo.role && animeInfo.role.toLowerCase() === 'main') {
                embed.addFields(
                    { name: '⭐ Main Character Bonus', value: '+500 points!', inline: false }
                );
            }
        }

        // Add duplicate indicator
        if (isDuplicate) {
            embed.addFields(
                { name: '🔁 Duplicate Character!', value: '+150 bonus points!', inline: false }
            );
        } else {
            embed.addFields(
                { name: '✨ Character Claimed!', value: 'Added to your collection!', inline: false }
            );
        }

        if (character.about) {
            const truncatedAbout = character.about.length > 200 
                ? character.about.substring(0, 200) + '...' 
                : character.about;
            embed.setDescription(truncatedAbout);
        }

        return embed;
    }

    createClaimableEmbed(character, points, user, animeInfo, rollsLeft = null, isLuckyRoll = false, luckyProgress = null) {
        const embed = new EmbedBuilder()
            .setTitle(character.name || 'Unknown Character')
            .setColor(isLuckyRoll ? 0xFF69B4 : 0x3498DB) // Pink for lucky rolls, blue for normal claimable characters
            .setThumbnail(character.images?.jpg?.image_url || character.image_url)
            .addFields(
                { name: '❤️ Favorites', value: (character.favorites || 0).toString(), inline: true },
                { name: '🏆 Potential Points', value: points.toString(), inline: true }
            );

        // Add lucky roll progress if available
        if (luckyProgress) {
            let progressText;
            if (isLuckyRoll) {
                progressText = '🍀✨🌟 LUCKY ROLL! 🌟✨🍀';
            } else if (luckyProgress.rollsUntilLucky === 1) {
                progressText = '🍀 Next roll is LUCKY! 🍀';
            } else {
                progressText = `🍀 Lucky in ${luckyProgress.rollsUntilLucky} rolls`;
            }
            embed.addFields({ name: '� Lucky Progress', value: progressText, inline: true });
        }

        // Add special lucky roll indicator
        if (isLuckyRoll) {
            embed.addFields({ 
                name: '🍀🌟✨ LUCKY ROLL BONUS ✨🌟🍀', 
                value: '🎉 Minimum 500 points guaranteed! 🎉\n🚫 Cannot be sniped! 🚫', 
                inline: false 
            });
        }

        embed.setFooter({ 
                text: `Rolled by ${user.username} • Click the button to claim!${isLuckyRoll ? ' • 🍀✨ LUCKY ROLL! ✨🍀' : ''}`, 
                iconURL: user.displayAvatarURL() 
            })
            .setTimestamp();

        // Add anime information if available
        if (animeInfo) {
            embed.addFields(
                { name: '📺 Anime', value: animeInfo.title, inline: true },
                { name: '🎭 Role', value: animeInfo.role, inline: true }
            );

            // Add main character bonus indicator
            if (animeInfo.role && animeInfo.role.toLowerCase() === 'main') {
                embed.addFields(
                    { name: '⭐ Main Character Bonus', value: '+500 points!', inline: false }
                );
            }
        }

        embed.addFields(
            { name: '⏰ Claim Timer', value: 'You have **30 seconds** to claim this character!', inline: false },
            { name: '🥷 Snipe Cost', value: `${(character.favorites || 0) * 3} points`, inline: true }
        );

        if (character.about) {
            const truncatedAbout = character.about.length > 200 
                ? character.about.substring(0, 200) + '...' 
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

    async deductUserPoints(userId, username, points) {
        const query = `
            INSERT INTO users (discord_id, username, total_points, last_roll) 
            VALUES ($1, $2, 0, NOW())
            ON CONFLICT (discord_id) 
            DO UPDATE SET 
                total_points = GREATEST(0, users.total_points - $3),
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

    async incrementLuckyRollCount(userId) {
        try {
            const query = `
                UPDATE users 
                SET lucky_roll_count = lucky_roll_count + 1 
                WHERE discord_id = $1
            `;
            await this.db.query(query, [userId]);
        } catch (error) {
            // If column doesn't exist, ignore for now
            if (error.code !== '42703') {
                throw error;
            }
        }
    }

    async resetLuckyRollCount(userId) {
        try {
            const query = `
                UPDATE users 
                SET lucky_roll_count = 0 
                WHERE discord_id = $1
            `;
            await this.db.query(query, [userId]);
        } catch (error) {
            // If column doesn't exist, ignore for now
            if (error.code !== '42703') {
                throw error;
            }
        }
    }

    async checkAndResetLuckyRoll(userId) {
        try {
            const user = await this.getUser(userId);
            const luckyCount = user ? user.lucky_roll_count || 0 : 0;
            
            if (luckyCount >= 9) { // Reset after 10th roll (0-9)
                const query = `
                    UPDATE users 
                    SET lucky_roll_count = 0 
                    WHERE discord_id = $1
                `;
                await this.db.query(query, [userId]);
                return true; // This is a lucky roll
            }
            
            return false;
        } catch (error) {
            // If column doesn't exist, return false (no lucky roll)
            if (error.code === '42703') {
                return false;
            }
            throw error;
        }
    }

    async getLuckyRollProgress(userId) {
        try {
            const user = await this.getUser(userId);
            const luckyCount = user ? user.lucky_roll_count || 0 : 0;
            
            // Lucky roll happens when count reaches exactly 10, 20, 30, etc.
            // But we want to check AFTER incrementing in the roll handler
            const rollsUntilLucky = luckyCount === 0 ? 10 : (10 - (luckyCount % 10));
            const isLuckyRoll = (luckyCount > 0) && (luckyCount % 10 === 0);
            
            return { currentCount: luckyCount, rollsUntilLucky: isLuckyRoll ? 0 : rollsUntilLucky, isLuckyRoll };
        } catch (error) {
            // If column doesn't exist, return default values
            return { currentCount: 0, rollsUntilLucky: 10, isLuckyRoll: false };
        }
    }

    async checkCooldown(userId) {
        const user = await this.getUser(userId);
        
        if (!user) {
            return { onCooldown: false, timeLeft: 0, rollsLeft: 3 };
        }

        const currentTime = Date.now();
        const periodStartTime = user.period_start_time ? new Date(user.period_start_time).getTime() : currentTime;
        const timeSincePeriodStart = currentTime - periodStartTime;

        // If more than 10 seconds have passed, reset the period
        if (timeSincePeriodStart >= this.rollPeriod) {
            // Reset the period
            await this.resetRollPeriod(userId);
            return { onCooldown: false, timeLeft: 0, rollsLeft: 3 };
        }

        // Check if user has rolls left in current period
        const rollsUsed = user.rolls_in_period || 0;
        const rollsLeft = this.maxRollsPerPeriod - rollsUsed;

        if (rollsLeft <= 0) {
            // User has used all rolls, need to wait for period reset
            const timeLeft = this.rollPeriod - timeSincePeriodStart;
            return {
                onCooldown: true,
                timeLeft: timeLeft,
                rollsLeft: 0
            };
        }

        return { onCooldown: false, timeLeft: 0, rollsLeft: rollsLeft };
    }

    async resetRollPeriod(userId) {
        const query = `
            UPDATE users 
            SET rolls_in_period = 0, period_start_time = NOW()
            WHERE discord_id = $1
        `;
        await this.db.query(query, [userId]);
    }

    async incrementRollCount(userId) {
        const query = `
            UPDATE users 
            SET rolls_in_period = rolls_in_period + 1
            WHERE discord_id = $1
        `;
        await this.db.query(query, [userId]);
    }

    async getUserId(discordId, username) {
        const query = `
            INSERT INTO users (discord_id, username) 
            VALUES ($1, $2)
            ON CONFLICT (discord_id) 
            DO UPDATE SET username = $2
            RETURNING id
        `;
        const result = await this.db.query(query, [discordId, username]);
        return result.rows[0].id;
    }

    async checkCharacterOwnership(userId, characterId) {
        const query = 'SELECT id FROM user_characters WHERE user_id = $1 AND character_id = $2';
        const result = await this.db.query(query, [userId, characterId]);
        return result.rows.length > 0;
    }

    async claimCharacter(userId, characterId, character, animeInfo) {
        const query = `
            INSERT INTO user_characters (
                user_id, character_id, character_name, character_image_url, 
                anime_title, character_role, character_favorites
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (user_id, character_id) DO NOTHING
        `;
        
        await this.db.query(query, [
            userId,
            characterId,
            character.name || 'Unknown Character',
            character.images?.jpg?.image_url || character.image_url,
            animeInfo?.title || null,
            animeInfo?.role || null,
            character.favorites || 0
        ]);
    }

    async recordRoll(userId, characterId, character, points, isDuplicate) {
        const query = `
            INSERT INTO rolls_history (
                user_id, character_id, character_name, character_favorites, 
                points_earned, is_duplicate
            ) VALUES ($1, $2, $3, $4, $5, $6)
        `;
        
        await this.db.query(query, [
            userId,
            characterId,
            character.name || 'Unknown Character',
            character.favorites || 0,
            points,
            isDuplicate
        ]);
    }

    async getUserCharacters(userId) {
        const query = `
            SELECT character_id, character_name, anime_title, character_role, character_favorites, claimed_at
            FROM user_characters 
            WHERE user_id = $1 
            ORDER BY character_favorites DESC, claimed_at DESC
        `;
        const result = await this.db.query(query, [userId]);
        return result.rows;
    }

    async handleClaimButton(interaction) {
        try {
            const claimId = interaction.customId;
            console.log(`Claim button clicked: ${claimId}`);
            console.log(`Available claims:`, Array.from(this.pendingClaims.keys()));
            
            const claimData = this.pendingClaims.get(claimId);

            if (!claimData) {
                console.log(`No claim data found for: ${claimId}`);
                await interaction.reply({ 
                    content: '❌ This claim has expired or already been processed!', 
                    flags: MessageFlags.Ephemeral 
                });
                return;
            }

            // Check if the person clicking is the one who rolled
            if (interaction.user.id !== claimData.rollerId) {
                await interaction.reply({ 
                    content: '❌ Only the person who rolled can claim this character!', 
                    flags: MessageFlags.Ephemeral 
                });
                return;
            }

            // Process the claim
            await this.claimCharacter(
                claimData.userId, 
                claimData.characterId, 
                claimData.character, 
                claimData.animeInfo
            );

            await this.addUserPoints(interaction.user.id, interaction.user.username, claimData.points);
            await this.recordRoll(
                claimData.userId, 
                claimData.characterId, 
                claimData.character, 
                claimData.points, 
                false
            );

            // Update the message with success
            const successEmbed = this.createCharacterEmbed(
                claimData.character, 
                claimData.points, 
                interaction.user, 
                claimData.animeInfo, 
                false,
                claimData.rollsLeft
            );

            await interaction.update({ 
                embeds: [successEmbed], 
                components: [] 
            });

            // Remove from pending claims (remove both claim and snipe IDs)
            const snipeId = claimId.replace('claim_', 'snipe_');
            this.pendingClaims.delete(claimId);
            this.pendingClaims.delete(snipeId);

        } catch (error) {
            console.error('Error in claim button:', error);
            
            // Try to reply only if interaction hasn't been acknowledged yet
            if (!interaction.replied && !interaction.deferred) {
                try {
                    await interaction.reply({ 
                        content: '❌ Something went wrong while claiming the character!', 
                        flags: MessageFlags.Ephemeral 
                    });
                } catch (replyError) {
                    console.error('Failed to send error message:', replyError);
                }
            }
        }
    }

    async handleSnipeButton(interaction) {
        try {
            const snipeId = interaction.customId;
            console.log(`Snipe button clicked: ${snipeId}`);
            console.log(`Available claims:`, Array.from(this.pendingClaims.keys()));
            
            // Try to get claim data directly with snipe ID first
            let claimData = this.pendingClaims.get(snipeId);
            
            // If not found, try to extract the original claim data from the snipe ID
            if (!claimData) {
                const claimId = snipeId.replace('snipe_', 'claim_');
                claimData = this.pendingClaims.get(claimId);
            }

            if (!claimData) {
                console.log(`No claim data found for: ${snipeId}`);
                await interaction.reply({ 
                    content: '❌ This claim has expired or already been processed!', 
                    flags: MessageFlags.Ephemeral 
                });
                return;
            }

            // Check snipe cooldown
            const userId = interaction.user.id;
            const currentTime = Date.now();
            const cooldownData = this.snipeCooldowns.get(userId);
            
            if (cooldownData && currentTime < cooldownData.expiresAt) {
                const timeLeft = Math.ceil((cooldownData.expiresAt - currentTime) / 1000);
                const minutes = Math.floor(timeLeft / 60);
                const seconds = timeLeft % 60;
                const timeString = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
                
                await interaction.reply({ 
                    content: `⏰ You're on snipe cooldown! Time remaining: **${timeString}**`, 
                    flags: MessageFlags.Ephemeral 
                });
                return;
            }

            // Check if the person clicking is NOT the one who rolled (can't snipe yourself)
            if (interaction.user.id === claimData.rollerId) {
                await interaction.reply({ 
                    content: '❌ You cannot snipe your own character! Use the claim button instead.', 
                    flags: MessageFlags.Ephemeral 
                });
                return;
            }

            // Get user data to check points
            const user = await this.getUser(interaction.user.id);
            const userPoints = user ? user.total_points : 0;

            // Calculate snipe cost (3x character favorites)
            const snipeCost = (claimData.character.favorites || 0) * 3;

            // Check if user has enough points
            if (userPoints < snipeCost) {
                await interaction.reply({ 
                    content: `❌ You need **${snipeCost}** points to snipe this character! You only have **${userPoints}** points.`, 
                    flags: MessageFlags.Ephemeral 
                });
                return;
            }

            // Deduct points from sniper
            await this.deductUserPoints(interaction.user.id, interaction.user.username, snipeCost);

            // Give the character to the sniper instead
            const sniperUserId = await this.getUserId(interaction.user.id, interaction.user.username);
            await this.claimCharacter(
                sniperUserId, 
                claimData.characterId, 
                claimData.character, 
                claimData.animeInfo
            );

            // Record the roll for the sniper (no points gained from snipe, only character)
            await this.recordRoll(
                sniperUserId, 
                claimData.characterId, 
                claimData.character, 
                0, // No points awarded for sniping
                false
            );

            // Create success embed showing the snipe
            const successEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('🥷 Character Sniped!')
                .setDescription(`**${interaction.user.username}** sniped **${claimData.character.name}** for **${snipeCost}** points!`)
                .setThumbnail(claimData.character.images?.jpg?.image_url || null)
                .addFields([
                    { name: 'Original Roller', value: `<@${claimData.rollerId}>`, inline: true },
                    { name: 'Sniper', value: `<@${interaction.user.id}>`, inline: true },
                    { name: 'Cost', value: `${snipeCost} points`, inline: true }
                ])
                .setTimestamp();

            await interaction.update({ 
                embeds: [successEmbed], 
                components: [] 
            });

            // Set snipe cooldown (1 min for normal, 10 min for main characters)
            const isMainCharacter = claimData.animeInfo && claimData.animeInfo.role && 
                                   claimData.animeInfo.role.toLowerCase() === 'main';
            const cooldownDuration = isMainCharacter ? 10 * 60 * 1000 : 60 * 1000; // 10 min or 1 min in milliseconds
            
            this.snipeCooldowns.set(userId, {
                expiresAt: currentTime + cooldownDuration,
                isMainCharacter: isMainCharacter
            });

            // Remove from pending claims (remove both claim and snipe IDs)
            const claimId = snipeId.replace('snipe_', 'claim_');
            this.pendingClaims.delete(claimId);
            this.pendingClaims.delete(snipeId);

        } catch (error) {
            console.error('Error in snipe button:', error);
            
            // Try to reply only if interaction hasn't been acknowledged yet
            if (!interaction.replied && !interaction.deferred) {
                try {
                    await interaction.reply({ 
                        content: '❌ Something went wrong while sniping the character!', 
                        flags: MessageFlags.Ephemeral 
                    });
                } catch (replyError) {
                    console.error('Failed to send error message:', replyError);
                }
            }
        }
    }

    async handlePackConfirmation(interaction) {
        try {
            // Extract user ID from the button custom ID to verify authorization
            const customId = interaction.customId;
            let authorizedUserId = null;
            
            if (customId.includes('pack_confirm_')) {
                authorizedUserId = customId.split('_')[2]; // Extract user ID from pack_confirm_USERID_timestamp
            } else if (customId.includes('pack_cancel_')) {
                authorizedUserId = customId.split('_')[2]; // Extract user ID from pack_cancel_USERID
            }

            // Check if the person clicking is authorized (the one who initiated the purchase)
            if (authorizedUserId && interaction.user.id !== authorizedUserId) {
                await interaction.reply({ 
                    content: '❌ Only the person who initiated this pack purchase can confirm or cancel it!', 
                    flags: MessageFlags.Ephemeral 
                });
                return;
            }

            // Check if this is a cancel button
            if (interaction.customId.includes('pack_cancel_')) {
                const cancelEmbed = new EmbedBuilder()
                    .setTitle('📦 Character Pack Purchase')
                    .setDescription('❌ Purchase cancelled!')
                    .setColor('#FF0000');
                
                await interaction.update({ 
                    embeds: [cancelEmbed], 
                    components: [] 
                });
                return;
            }

            // Get user data and verify they still have enough points
            const user = await this.getUser(interaction.user.id);
            const userPoints = user ? user.total_points : 0;
            const packCost = 1000;

            if (userPoints < packCost) {
                await interaction.reply({ 
                    content: `❌ You no longer have enough points! You need **${packCost}** but only have **${userPoints}**.`, 
                    flags: MessageFlags.Ephemeral 
                });
                return;
            }

            // Deduct the points
            await this.deductUserPoints(interaction.user.id, interaction.user.username, packCost);

            // Create processing embed
            const processingEmbed = new EmbedBuilder()
                .setTitle('📦 Opening Character Pack...')
                .setDescription('🎲 Rolling 10 characters for you...')
                .setColor('#FFD700');

            await interaction.update({ 
                embeds: [processingEmbed], 
                components: [] 
            });

            // Perform 10 pack rolls
            await this.performPackRolls(interaction, 10);

        } catch (error) {
            console.error('Error in pack confirmation:', error);
            
            if (!interaction.replied && !interaction.deferred) {
                try {
                    await interaction.reply({ 
                        content: '❌ Something went wrong while processing your pack purchase!', 
                        flags: MessageFlags.Ephemeral 
                    });
                } catch (replyError) {
                    console.error('Failed to send error message:', replyError);
                }
            }
        }
    }

    async performPackRolls(interaction, rollCount) {
        try {
            const userId = await this.getUserId(interaction.user.id, interaction.user.username);
            const rolledCharacters = [];
            let totalPoints = 0;

            // Create initial embed
            const embed = new EmbedBuilder()
                .setTitle('📦 Character Pack Opening...')
                .setDescription('🎲 Rolling characters...')
                .setColor('#FFD700')
                .setFooter({ 
                    text: `Opening pack for ${interaction.user.username}`, 
                    iconURL: interaction.user.displayAvatarURL() 
                })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });

            // Small delay before starting to give user a moment to see the processing message
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Roll characters one by one with 2 second delay
            for (let i = 0; i < rollCount; i++) {
                try {
                    let character = null;
                    let attempts = 0;
                    
                    // Try to get a valid character with more patience and better error handling
                    while (!character && attempts < 50) {
                        try {
                            const randomId = Math.floor(Math.random() * this.maxCharacterId) + 1;
                            
                            // Try to get character from cache first, then API
                            character = await this.getCharacter(randomId);
                            
                            // Validate character has required data
                            if (character && character.name && character.name.trim() !== '') {
                                console.log(`Successfully got character: ${character.name} (ID: ${character.mal_id})`);
                                break; // We have a valid character
                            } else {
                                character = null; // Reset if invalid
                            }
                        } catch (fetchError) {
                            console.log(`Failed to fetch character ${randomId}, attempt ${attempts + 1}:`, fetchError.message);
                        }
                        attempts++;
                        
                        // Longer delay between attempts to be more gentle on API
                        if (!character && attempts < 50) {
                            await new Promise(resolve => setTimeout(resolve, 300)); // 300ms delay (slower)
                        }
                    }

                    if (!character) {
                        console.error(`Could not find valid character after ${attempts} attempts for pack slot ${i + 1}`);
                        // Create a proper fallback character as last resort
                        character = {
                            mal_id: 999000 + i, // Unique fallback ID
                            name: `Mystery Character #${i + 1}`,
                            favorites: Math.floor(Math.random() * 500) + 100,
                            images: { jpg: { image_url: null } }
                        };
                    }

                    // Calculate points - guarantee at least one character has 500+ points
                    let points;
                    if (i === 0) {
                        // First character always gets bonus points (500-800)
                        points = Math.floor(Math.random() * 300) + 500;
                    } else {
                        // Other characters get normal points based on favorites
                        points = Math.floor((character.favorites || 0) / 10) + Math.floor(Math.random() * 100) + 50;
                    }
                    
                    // Check if it's a duplicate
                    const isDuplicate = await this.isCharacterOwned(userId, character.mal_id);
                    if (isDuplicate) {
                        points += 150; // Duplicate bonus
                    }

                    // Auto-claim the character
                    try {
                        await this.claimCharacter(userId, character.mal_id, character, null);
                        await this.addUserPoints(interaction.user.id, interaction.user.username, points);
                        await this.recordRoll(userId, character.mal_id, character, points, isDuplicate);
                    } catch (claimError) {
                        console.log(`Error claiming character ${character.mal_id}:`, claimError);
                        // Continue anyway, just log the error
                    }

                    totalPoints += points;
                    rolledCharacters.push({
                        name: character.name,
                        points: points,
                        isDuplicate: isDuplicate,
                        isBonus: i === 0 // Mark first character as bonus
                    });

                    // Update embed with current progress
                    let characterList = '';
                    rolledCharacters.forEach((char, index) => {
                        const duplicateText = char.isDuplicate ? ' ⭐' : '';
                        const bonusText = char.isBonus ? ' 🎁' : '';
                        characterList += `**${index + 1}.** ${char.name}${duplicateText}${bonusText} - ${char.points} pts\n`;
                    });

                    const progressEmbed = new EmbedBuilder()
                        .setTitle(`📦 Opening Pack... (${i + 1}/${rollCount})`)
                        .setColor('#FFD700')
                        .setFooter({ 
                            text: `Opening pack for ${interaction.user.username}`, 
                            iconURL: interaction.user.displayAvatarURL() 
                        })
                        .setTimestamp();

                    if (characterList) {
                        progressEmbed.addFields([
                            { name: '🎲 Characters Obtained', value: characterList, inline: false },
                            { name: '🏆 Points So Far', value: `${totalPoints}`, inline: true },
                            { name: '📊 Progress', value: `${i + 1}/${rollCount}`, inline: true }
                        ]);
                    }

                    await interaction.editReply({ embeds: [progressEmbed] });
                    
                    // 2 second delay for visual effect (except on last roll)
                    if (i < rollCount - 1) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }

                } catch (rollError) {
                    console.error(`Error rolling character ${i + 1}:`, rollError);
                    
                    // Create fallback character if individual roll fails
                    const fallbackPoints = i === 0 ? 500 : 100;
                    totalPoints += fallbackPoints;
                    rolledCharacters.push({
                        name: `Fallback Character #${i + 1}`,
                        points: fallbackPoints,
                        isDuplicate: false,
                        isBonus: i === 0
                    });
                    
                    // Continue with next character
                    continue;
                }
            }

            // Final results embed
            let characterList = '';
            rolledCharacters.forEach((character, index) => {
                const duplicateText = character.isDuplicate ? ' ⭐' : '';
                const bonusText = character.isBonus ? ' 🎁' : '';
                characterList += `**${index + 1}.** ${character.name}${duplicateText}${bonusText} - ${character.points} pts\n`;
            });

            const duplicateCount = rolledCharacters.filter(char => char.isDuplicate).length;
            const bonusCount = rolledCharacters.filter(char => char.isBonus).length;

            const finalEmbed = new EmbedBuilder()
                .setTitle('📦 Character Pack Complete!')
                .setColor('#00FF00')
                .setFooter({ 
                    text: `Opened by ${interaction.user.username} • All characters auto-claimed!`, 
                    iconURL: interaction.user.displayAvatarURL() 
                })
                .setTimestamp();

            finalEmbed.addFields([
                { name: '🎲 Characters Obtained', value: characterList || 'No characters rolled', inline: false },
                { name: '🏆 Total Points Earned', value: `${totalPoints}`, inline: true },
                { name: '⭐ Duplicates', value: `${duplicateCount}`, inline: true },
                { name: '🎁 Bonus Characters', value: `${bonusCount}`, inline: true },
                { name: '� Pack Value', value: `${totalPoints} pts (cost: 1000)`, inline: false }
            ]);

            // Final update
            await interaction.editReply({ embeds: [finalEmbed] });

        } catch (error) {
            console.error('Error in pack rolls:', error);
            
            const errorEmbed = new EmbedBuilder()
                .setTitle('📦 Pack Opening Error')
                .setDescription('❌ Something went wrong while opening your pack! Your points have been refunded.')
                .setColor('#FF0000');

            try {
                // Refund the points
                await this.addUserPoints(interaction.user.id, interaction.user.username, 1000);
                await interaction.editReply({ embeds: [errorEmbed] });
            } catch (refundError) {
                console.error('Error refunding points:', refundError);
                await interaction.editReply({ 
                    content: '❌ Pack opening failed! Please contact an admin for a refund.' 
                });
            }
        }
    }

    async handleGiveConfirmation(interaction) {
        try {
            // Check if this is a cancel button
            if (interaction.customId.includes('give_cancel_')) {
                const cancelEmbed = new EmbedBuilder()
                    .setTitle('🎁 Admin Give Character')
                    .setDescription('❌ Character give cancelled!')
                    .setColor('#FF0000');
                
                await interaction.update({ 
                    embeds: [cancelEmbed], 
                    components: [] 
                });
                return;
            }

            // Parse the custom ID to get target user and character info
            const parts = interaction.customId.split('_');
            if (parts.length < 4) {
                await interaction.reply({ 
                    content: '❌ Invalid confirmation data!', 
                    flags: MessageFlags.Ephemeral 
                });
                return;
            }

            const targetUserId = parts[2];
            const characterId = parts[3];

            // Verify only admin can confirm
            const adminUserId = '115724975398322176';
            if (interaction.user.id !== adminUserId) {
                await interaction.reply({ 
                    content: '❌ Only the admin can confirm this action!', 
                    flags: MessageFlags.Ephemeral 
                });
                return;
            }

            // Get the character information
            const character = await this.getCharacter(characterId);
            if (!character) {
                await interaction.reply({ 
                    content: '❌ Could not fetch character information!', 
                    flags: MessageFlags.Ephemeral 
                });
                return;
            }

            // Get character anime info
            const animeInfo = await this.getCharacterAnime(characterId);

            // Get target user
            const targetUser = await this.client.users.fetch(targetUserId);
            if (!targetUser) {
                await interaction.reply({ 
                    content: '❌ Could not find target user!', 
                    flags: MessageFlags.Ephemeral 
                });
                return;
            }

            // Create user in database if needed and get user ID
            const targetDbUserId = await this.getUserId(targetUserId, targetUser.username);

            // Reserve the character for their next roll instead of adding directly
            const reservationKey = `reserved_character:${targetUserId}`;
            const reservationData = {
                characterId: characterId,
                character: character,
                animeInfo: {
                    title: character.anime || animeInfo?.title || 'Unknown Anime',
                    role: character.role || animeInfo?.role || 'Unknown'
                },
                adminId: interaction.user.id,
                reservedAt: Date.now()
            };

            // Store the reservation (expires in 24 hours)
            await this.redis.setEx(reservationKey, 86400, JSON.stringify(reservationData));

            // Create success embed
            const successEmbed = new EmbedBuilder()
                .setTitle('🎁 Character Reserved for Next Roll!')
                .setColor('#00FF00')
                .setDescription(`**${character.name}** has been reserved for **${targetUser.username}**'s next roll!`)
                .addFields([
                    { name: '👤 Recipient', value: targetUser.username, inline: true },
                    { name: '🎭 Character', value: character.name, inline: true },
                    { name: '📺 Anime', value: reservationData.animeInfo.title, inline: true },
                    { name: '❤️ Favorites', value: character.favorites?.toString() || '0', inline: true },
                    { name: '🎲 Next Roll', value: 'This character will appear on their next roll as an unsnipeable claim!', inline: false }
                ])
                .setImage(character.images?.jpg?.image_url)
                .setFooter({ text: 'Character reserved - will appear on next roll' })
                .setTimestamp();

            await interaction.update({ embeds: [successEmbed], components: [] });

            // Also notify the target user via DM if possible
            try {
                const dmEmbed = new EmbedBuilder()
                    .setTitle('🎁 Special Character Reserved!')
                    .setColor('#00FF00')
                    .setDescription(`An admin has reserved **${character.name}** from **${reservationData.animeInfo.title}** for you!\n\n🎲 This character will appear on your next roll as an unsnipeable claim!`)
                    .setImage(character.images?.jpg?.image_url)
                    .setTimestamp();

                await targetUser.send({ embeds: [dmEmbed] });
            } catch (dmError) {
                console.log('Could not send DM to user:', dmError.message);
                // Don't fail the whole operation if DM fails
            }

        } catch (error) {
            console.error('Error in give confirmation:', error);
            await interaction.reply({ 
                content: '❌ Something went wrong while giving the character!', 
                flags: MessageFlags.Ephemeral 
            });
        }
    }

    async expireClaim(claimId, message) {
        try {
            const claimData = this.pendingClaims.get(claimId);
            if (!claimData) return;

            // Create expired embed
            const expiredEmbed = new EmbedBuilder()
                .setTitle(claimData.character.name || 'Unknown Character')
                .setColor(0x95A5A6) // Gray color for expired
                .setThumbnail(claimData.character.images?.jpg?.image_url || claimData.character.image_url)
                .setDescription('⏰ **Claim Expired** - This character was not claimed in time!')
                .setFooter({ text: 'Better luck next time!' })
                .setTimestamp();

            await message.edit({ 
                embeds: [expiredEmbed], 
                components: [] 
            });

            // Remove from pending claims
            this.pendingClaims.delete(claimId);

        } catch (error) {
            console.error('Error expiring claim:', error);
        }
    }

    async updateLastRoll(userId, username) {
        const query = `
            INSERT INTO users (discord_id, username, last_roll) 
            VALUES ($1, $2, NOW())
            ON CONFLICT (discord_id) 
            DO UPDATE SET 
                last_roll = NOW(),
                username = $2
        `;
        
        await this.db.query(query, [userId, username]);
    }

    createCollectionEmbed(characters, page, user) {
        const charactersPerPage = 10;
        const totalPages = Math.ceil(characters.length / charactersPerPage);
        const currentPage = Math.min(Math.max(1, page), totalPages);
        
        const startIndex = (currentPage - 1) * charactersPerPage;
        const endIndex = startIndex + charactersPerPage;
        const pageCharacters = characters.slice(startIndex, endIndex);

        const embed = new EmbedBuilder()
            .setTitle(`📚 ${user.username}'s Character Collection`)
            .setColor(0x9932CC)
            .setTimestamp()
            .setFooter({ 
                text: `Page ${currentPage}/${totalPages} • Total: ${characters.length} characters` 
            });

        let description = '';
        pageCharacters.forEach((char, index) => {
            const globalIndex = startIndex + index + 1;
            const anime = char.anime_title ? ` (${char.anime_title})` : '';
            const role = char.character_role ? ` - ${char.character_role}` : '';
            const favorites = char.character_favorites || 0;
            const favoritesDisplay = favorites > 0 ? ` ❤️ ${favorites}` : '';
            description += `${globalIndex}. **${char.character_name}**${anime}${role}${favoritesDisplay}\n`;
        });

        embed.setDescription(description || 'No characters on this page.');

        // Create navigation buttons
        const components = [];
        if (totalPages > 1) {
            const row = new ActionRowBuilder();
            
            // Previous button
            if (currentPage > 1) {
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`collection_${user.id}_${currentPage - 1}`)
                        .setLabel('⬅️ Previous')
                        .setStyle(ButtonStyle.Secondary)
                );
            }

            // Page indicator button (disabled)
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId('page_indicator')
                    .setLabel(`${currentPage}/${totalPages}`)
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(true)
            );

            // Next button
            if (currentPage < totalPages) {
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`collection_${user.id}_${currentPage + 1}`)
                        .setLabel('Next ➡️')
                        .setStyle(ButtonStyle.Secondary)
                );
            }

            components.push(row);
        }

        return { embed, components };
    }

    async handleCollectionPagination(interaction) {
        try {
            const [, userId, pageStr] = interaction.customId.split('_');
            const page = parseInt(pageStr);

            // Check if the person clicking is the collection owner
            if (interaction.user.id !== userId) {
                await interaction.reply({ 
                    content: '❌ You can only navigate your own collection!', 
                    ephemeral: true 
                });
                return;
            }

            const dbUserId = await this.getUserId(interaction.user.id, interaction.user.username);
            const characters = await this.getUserCharacters(dbUserId);
            
            const { embed, components } = this.createCollectionEmbed(characters, page, interaction.user);
            
            await interaction.update({ 
                embeds: [embed], 
                components: components 
            });

        } catch (error) {
            console.error('Error in collection pagination:', error);
            await interaction.reply({ 
                content: '❌ Something went wrong while navigating your collection!', 
                ephemeral: true 
            });
        }
    }

    async handleHelpCommand(message) {
        try {
            const embed = new EmbedBuilder()
                .setTitle('🤖 Waifu Bot Commands')
                .setColor(0x00AE86)
                .setDescription('Here are all the available commands:')
                .addFields(
                    { 
                        name: '🎲 !roll', 
                        value: 'Roll for a random character\n• 3 rolls per 10 seconds\n• Click the button to claim within 30 seconds!', 
                        inline: false 
                    },
                    { 
                        name: '🏆 !points', 
                        value: 'Check your total points earned', 
                        inline: true 
                    },
                    { 
                        name: '📊 !leaderboard', 
                        value: 'View the top 10 players', 
                        inline: true 
                    },
                    { 
                        name: '📚 !collection [page]', 
                        value: 'View your character collection\n• Use navigation buttons to browse\n• Example: `!collection 2` for page 2', 
                        inline: false 
                    },
                    { 
                        name: '🔄 !trade @user character name', 
                        value: 'Start a trade with another user\n• Example: `!trade @vicky Naruto Uzumaki`\n• Target user responds with: `!trade @you character name`\n• Both users confirm with ✅ or cancel with ❌', 
                        inline: false 
                    },
                    { 
                        name: '📦 !pack', 
                        value: 'Buy a character pack for 1000 points\n• Get 10 instant character rolls\n• All characters are auto-claimed\n• Unsnipeable rolls!', 
                        inline: false 
                    },
                    { 
                        name: '🎁 !give @user character', 
                        value: 'Reserve a character for user\'s next roll (Admin only)\n• Example: `!give @vicky naruto`\n• Character appears on their next roll as unsnipeable\n• Reserved for 24 hours!', 
                        inline: false 
                    },
                    { 
                        name: '� !lucky', 
                        value: 'Check your lucky roll progress\n• Every 10th roll guarantees 50+ points\n• Lucky rolls have pink color', 
                        inline: true 
                    },
                    { 
                        name: '�🎯 Point System', 
                        value: '• Base points based on character popularity\n• +500 for Main characters\n• +150 for duplicate characters\n• Use points to snipe claims (3x favorites cost)\n• Lucky rolls every 10th roll (50+ points guaranteed)', 
                        inline: false 
                    }
                )
                .setFooter({ text: 'Happy collecting! 🌟' })
                .setTimestamp();

            await message.reply({ embeds: [embed] });

        } catch (error) {
            console.error('Error in help command:', error);
            await message.reply('❌ Failed to fetch help information!');
        }
    }

    async handleTradeCommand(message) {
        try {
            const content = message.content.trim();
            const args = content.split(' ');
            
            // Check if there's a user mention
            const targetUser = message.mentions.users.first();
            
            if (!targetUser) {
                await message.reply('❌ **Usage:** `!trade @user character name`\n**Example:** `!trade @vicky Naruto Uzumaki`');
                return;
            }

            if (targetUser.id === message.author.id) {
                await message.reply('❌ You cannot trade with yourself!');
                return;
            }

            if (targetUser.bot) {
                await message.reply('❌ You cannot trade with bots!');
                return;
            }

            // Extract character name (everything after the mention)
            const mentionMatch = content.match(/<@!?(\d+)>/);
            if (!mentionMatch) {
                await message.reply('❌ Please mention a user and specify a character name!');
                return;
            }

            const afterMention = content.substring(content.indexOf(mentionMatch[0]) + mentionMatch[0].length).trim();
            if (!afterMention) {
                await message.reply('❌ Please specify a character name after mentioning the user!\n**Example:** `!trade @vicky Naruto Uzumaki`');
                return;
            }

            const characterName = afterMention;

            // Get user's characters and find the one they want to trade
            const userDbId = await this.getUserId(message.author.id, message.author.username);
            const userCharacters = await this.getUserCharacters(userDbId);

            if (userCharacters.length === 0) {
                await message.reply('❌ You don\'t have any characters to trade! Use `!roll` to collect some first.');
                return;
            }

            // Search for the character in user's collection (case-insensitive partial match)
            const matchingCharacter = userCharacters.find(char => 
                char.character_name.toLowerCase().includes(characterName.toLowerCase()) ||
                characterName.toLowerCase().includes(char.character_name.toLowerCase())
            );

            if (!matchingCharacter) {
                await message.reply(`❌ You don't own a character named "${characterName}"!\n💡 Use \`!collection\` to see your characters.`);
                return;
            }

            // Check if there's already a pending trade between these users
            const existingTradeId = Array.from(this.pendingTrades.keys()).find(tradeId => {
                const tradeData = this.pendingTrades.get(tradeId);
                return (tradeData.initiatorId === message.author.id && tradeData.targetId === targetUser.id) ||
                       (tradeData.initiatorId === targetUser.id && tradeData.targetId === message.author.id);
            });

            if (existingTradeId) {
                const existingTrade = this.pendingTrades.get(existingTradeId);
                
                // Check if this user is adding their character to an existing trade
                if (existingTrade.targetId === message.author.id && !existingTrade.targetSelection) {
                    // User is adding their character to complete the trade
                    existingTrade.targetSelection = matchingCharacter;
                    
                    // Update the existing trade embed
                    const channel = await this.client.channels.fetch(existingTrade.channelId);
                    const tradeMessage = await channel.messages.fetch(existingTrade.messageId);
                    await this.updateExistingTradeEmbed(tradeMessage, existingTrade);
                    
                    await message.reply(`✅ Added **${matchingCharacter.character_name}** to the trade with ${targetUser.username}!`);
                    return;
                } else {
                    await message.reply(`❌ You already have a pending trade with ${targetUser.username}! Complete or cancel it first.`);
                    return;
                }
            }

            // Create new trade
            await this.createNewTrade(message, targetUser, matchingCharacter);

        } catch (error) {
            console.error('Error in trade command:', error);
            await message.reply('❌ Something went wrong while setting up the trade!');
        }
    }

    async createNewTrade(message, targetUser, offeredCharacter) {
        // Create trade ID
        const tradeId = `trade_${message.author.id}_${targetUser.id}_${Date.now()}`;

        // Create trade embed
        const embed = new EmbedBuilder()
            .setTitle('🔄 Trade Request')
            .setColor(0xFFAA00)
            .setDescription(`**${message.author.username}** wants to trade with **${targetUser.username}**!`)
            .addFields(
                {
                    name: `📤 ${message.author.username} offers:`,
                    value: `**${offeredCharacter.character_name}**\n${offeredCharacter.anime_title || 'Unknown Anime'}${offeredCharacter.character_favorites > 0 ? `\n❤️ ${offeredCharacter.character_favorites} favorites` : ''}`,
                    inline: true
                },
                {
                    name: `📥 ${targetUser.username} will trade:`,
                    value: '⏳ Waiting for response...\n\n*Use: `!trade @' + message.author.username + ' character name`*',
                    inline: true
                },
                {
                    name: '📋 Instructions',
                    value: `${targetUser.username}, respond with:\n\`!trade @${message.author.username} [character name]\`\n\nThen both users can react with ✅ to confirm or ❌ to cancel.`,
                    inline: false
                }
            )
            .setImage(offeredCharacter.character_image_url)
            .setFooter({ text: 'Trade will expire in 10 minutes if not completed' })
            .setTimestamp();

        const confirmButton = new ButtonBuilder()
            .setCustomId(`${tradeId}_confirm_initiator`)
            .setLabel('✅ Confirm Trade')
            .setStyle(ButtonStyle.Success)
            .setDisabled(true); // Disabled until both characters are selected

        const cancelButton = new ButtonBuilder()
            .setCustomId(`${tradeId}_cancel`)
            .setLabel('❌ Cancel Trade')
            .setStyle(ButtonStyle.Danger);

        const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

        const reply = await message.reply({ 
            content: `${targetUser}, you have a trade request!`,
            embeds: [embed], 
            components: [row] 
        });

        // Store trade data
        this.pendingTrades.set(tradeId, {
            initiatorId: message.author.id,
            targetId: targetUser.id,
            initiatorSelection: offeredCharacter,
            targetSelection: null,
            messageId: reply.id,
            channelId: message.channel.id,
            status: 'waiting_for_target',
            initiatorConfirmed: false,
            targetConfirmed: false,
            createdAt: Date.now()
        });

        // Set expiration timer
        setTimeout(async () => {
            if (this.pendingTrades.has(tradeId)) {
                await this.expireTrade(tradeId, reply, 'Trade request timed out');
            }
        }, 600000); // 10 minutes

        await message.reply(`✅ Trade request sent to ${targetUser.username} with **${offeredCharacter.character_name}**!`);
    }

    async updateExistingTradeEmbed(message, tradeData) {
        try {
            const initiatorUser = await this.client.users.fetch(tradeData.initiatorId);
            const targetUser = await this.client.users.fetch(tradeData.targetId);

            const embed = new EmbedBuilder()
                .setTitle('🔄 Trade Ready!')
                .setColor(0x00FF00)
                .setDescription(`**${initiatorUser.username}** and **${targetUser.username}** are ready to trade!`)
                .addFields(
                    {
                        name: `📤 ${initiatorUser.username} offers:`,
                        value: `**${tradeData.initiatorSelection.character_name}**\n${tradeData.initiatorSelection.anime_title || 'Unknown Anime'}${tradeData.initiatorSelection.character_favorites > 0 ? `\n❤️ ${tradeData.initiatorSelection.character_favorites} favorites` : ''}`,
                        inline: true
                    },
                    {
                        name: `� ${targetUser.username} offers:`,
                        value: `**${tradeData.targetSelection.character_name}**\n${tradeData.targetSelection.anime_title || 'Unknown Anime'}${tradeData.targetSelection.character_favorites > 0 ? `\n❤️ ${tradeData.targetSelection.character_favorites} favorites` : ''}`,
                        inline: true
                    },
                    {
                        name: '📋 Status',
                        value: '🎯 Both characters selected! React with ✅ to confirm or ❌ to cancel.\n\n⚠️ **Both users must confirm to complete the trade.**',
                        inline: false
                    }
                )
                .setFooter({ text: 'Both users must confirm to complete the trade' })
                .setTimestamp();

            // Create new buttons with both enabled
            const initiatorConfirmButton = new ButtonBuilder()
                .setCustomId(`${Object.keys(this.pendingTrades).find(id => this.pendingTrades.get(id) === tradeData)}_confirm_initiator`)
                .setLabel(`✅ ${initiatorUser.username} Confirm`)
                .setStyle(ButtonStyle.Success)
                .setDisabled(false);

            const targetConfirmButton = new ButtonBuilder()
                .setCustomId(`${Object.keys(this.pendingTrades).find(id => this.pendingTrades.get(id) === tradeData)}_confirm_target`)
                .setLabel(`✅ ${targetUser.username} Confirm`)
                .setStyle(ButtonStyle.Success)
                .setDisabled(false);

            const cancelButton = new ButtonBuilder()
                .setCustomId(`${Object.keys(this.pendingTrades).find(id => this.pendingTrades.get(id) === tradeData)}_cancel`)
                .setLabel('❌ Cancel Trade')
                .setStyle(ButtonStyle.Danger);

            const row = new ActionRowBuilder().addComponents(initiatorConfirmButton, targetConfirmButton, cancelButton);

            // Update trade status
            tradeData.status = 'confirming';

            await message.edit({ embeds: [embed], components: [row] });

        } catch (error) {
            console.error('Error updating trade embed:', error);
        }
    }



    async handleTradeReaction(tradeId, reaction, user, message) {
        try {
            const tradeData = this.pendingTrades.get(tradeId);
            if (!tradeData) return;

            const isInitiator = user.id === tradeData.initiatorId;
            const isTarget = user.id === tradeData.targetId;

            if (!isInitiator && !isTarget) return;

            // Check if both characters are selected
            if (!tradeData.initiatorSelection || !tradeData.targetSelection) {
                return; // Ignore reactions until both characters are selected
            }

            if (reaction.emoji.name === '❌') {
                // Cancel trade and clear timer
                if (tradeData.autoCompleteTimer) {
                    clearTimeout(tradeData.autoCompleteTimer);
                }
                await this.cancelTrade(tradeId, message);
                return;
            }

        } catch (error) {
            console.error('Error handling trade reaction:', error);
        }
    }

    async handleTradeButton(interaction) {
        try {
            const parts = interaction.customId.split('_');
            if (parts.length < 4) {
                await interaction.reply({ 
                    content: '❌ Invalid trade button!', 
                    ephemeral: true 
                });
                return;
            }

            const tradeId = `${parts[1]}_${parts[2]}_${parts[3]}`;
            const action = parts[4]; // 'confirm' or 'cancel'
            const userType = parts[5]; // 'initiator' or 'target'

            const tradeData = this.pendingTrades.get(tradeId);

            if (!tradeData) {
                await interaction.reply({ 
                    content: '❌ This trade has expired or been completed!', 
                    ephemeral: true 
                });
                return;
            }

            if (action === 'cancel') {
                // Check if user is authorized to cancel
                if (interaction.user.id !== tradeData.initiatorId && interaction.user.id !== tradeData.targetId) {
                    await interaction.reply({ 
                        content: '❌ You are not part of this trade!', 
                        ephemeral: true 
                    });
                    return;
                }

                await this.cancelTrade(tradeId, interaction.message);
                await interaction.reply({ 
                    content: '❌ Trade cancelled!', 
                    ephemeral: true 
                });
                return;
            }

            if (action === 'confirm') {
                // Check if both characters are selected
                if (!tradeData.initiatorSelection || !tradeData.targetSelection) {
                    await interaction.reply({ 
                        content: '❌ Both characters must be selected before confirming!', 
                        ephemeral: true 
                    });
                    return;
                }

                // Check if the correct user is clicking
                const isInitiator = userType === 'initiator' && interaction.user.id === tradeData.initiatorId;
                const isTarget = userType === 'target' && interaction.user.id === tradeData.targetId;

                if (!isInitiator && !isTarget) {
                    await interaction.reply({ 
                        content: '❌ You are not authorized to confirm this trade!', 
                        ephemeral: true 
                    });
                    return;
                }

                // Mark confirmation
                if (isInitiator) {
                    tradeData.initiatorConfirmed = true;
                    await interaction.reply({ 
                        content: '✅ You have confirmed the trade! Waiting for the other user...', 
                        ephemeral: true 
                    });
                } else {
                    tradeData.targetConfirmed = true;
                    await interaction.reply({ 
                        content: '✅ You have confirmed the trade! Waiting for the other user...', 
                        ephemeral: true 
                    });
                }

                // Update the embed to show confirmation status
                await this.updateTradeConfirmationStatus(interaction.message, tradeData);

                // Check if both have confirmed
                if (tradeData.initiatorConfirmed && tradeData.targetConfirmed) {
                    // Small delay to let users see the confirmation status
                    setTimeout(async () => {
                        await this.completeTrade(tradeId, interaction.message);
                    }, 2000);
                }
            }

        } catch (error) {
            console.error('Error in trade button:', error);
            if (!interaction.replied) {
                await interaction.reply({ 
                    content: '❌ Something went wrong while processing the trade!', 
                    ephemeral: true 
                });
            }
        }
    }

    async updateTradeConfirmationStatus(message, tradeData) {
        try {
            const initiatorUser = await this.client.users.fetch(tradeData.initiatorId);
            const targetUser = await this.client.users.fetch(tradeData.targetId);

            const embed = new EmbedBuilder()
                .setTitle('🔄 Trade Confirmation')
                .setColor(0xFFD700)
                .setDescription(`**${initiatorUser.username}** and **${targetUser.username}** are confirming their trade!`)
                .addFields(
                    {
                        name: `📤 ${initiatorUser.username} offers:`,
                        value: `**${tradeData.initiatorSelection.character_name}**\n${tradeData.initiatorSelection.anime_title || 'Unknown Anime'}${tradeData.initiatorSelection.character_favorites > 0 ? `\n❤️ ${tradeData.initiatorSelection.character_favorites} favorites` : ''}`,
                        inline: true
                    },
                    {
                        name: `📤 ${targetUser.username} offers:`,
                        value: `**${tradeData.targetSelection.character_name}**\n${tradeData.targetSelection.anime_title || 'Unknown Anime'}${tradeData.targetSelection.character_favorites > 0 ? `\n❤️ ${tradeData.targetSelection.character_favorites} favorites` : ''}`,
                        inline: true
                    },
                    {
                        name: '📋 Confirmation Status',
                        value: `${initiatorUser.username}: ${tradeData.initiatorConfirmed ? '✅ Confirmed' : '⏳ Waiting...'}\n${targetUser.username}: ${tradeData.targetConfirmed ? '✅ Confirmed' : '⏳ Waiting...'}`,
                        inline: false
                    }
                )
                .setFooter({ text: tradeData.initiatorConfirmed && tradeData.targetConfirmed ? 'Trade will complete in a moment...' : 'Waiting for confirmations...' })
                .setTimestamp();

            // Get current trade ID
            const tradeId = Object.keys(this.pendingTrades).find(id => this.pendingTrades.get(id) === tradeData);

            // Create updated buttons
            const initiatorConfirmButton = new ButtonBuilder()
                .setCustomId(`${tradeId}_confirm_initiator`)
                .setLabel(`${tradeData.initiatorConfirmed ? '✅' : '⏳'} ${initiatorUser.username}`)
                .setStyle(tradeData.initiatorConfirmed ? ButtonStyle.Success : ButtonStyle.Secondary)
                .setDisabled(tradeData.initiatorConfirmed);

            const targetConfirmButton = new ButtonBuilder()
                .setCustomId(`${tradeId}_confirm_target`)
                .setLabel(`${tradeData.targetConfirmed ? '✅' : '⏳'} ${targetUser.username}`)
                .setStyle(tradeData.targetConfirmed ? ButtonStyle.Success : ButtonStyle.Secondary)
                .setDisabled(tradeData.targetConfirmed);

            const cancelButton = new ButtonBuilder()
                .setCustomId(`${tradeId}_cancel`)
                .setLabel('❌ Cancel Trade')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(tradeData.initiatorConfirmed && tradeData.targetConfirmed);

            const row = new ActionRowBuilder().addComponents(initiatorConfirmButton, targetConfirmButton, cancelButton);

            await message.edit({ embeds: [embed], components: [row] });

        } catch (error) {
            console.error('Error updating trade confirmation status:', error);
        }
    }



    async completeTrade(tradeId, message) {
        try {
            const tradeData = this.pendingTrades.get(tradeId);

            // Clear auto-complete timer if it exists
            if (tradeData.autoCompleteTimer) {
                clearTimeout(tradeData.autoCompleteTimer);
            }

            // Perform the database trade
            await this.executeCharacterTrade(
                tradeData.initiatorId,
                tradeData.targetId,
                tradeData.initiatorSelection.character_id,
                tradeData.targetSelection.character_id
            );

            // Get user objects
            const initiatorUser = await this.client.users.fetch(tradeData.initiatorId);
            const targetUser = await this.client.users.fetch(tradeData.targetId);

            // Create success embed
            const embed = new EmbedBuilder()
                .setTitle('✅ Trade Completed!')
                .setColor(0x00FF00)
                .setDescription(`**${initiatorUser.username}** and **${targetUser.username}** have successfully completed their trade!`)
                .addFields(
                    {
                        name: `📤 ${initiatorUser.username} traded away`,
                        value: `**${tradeData.initiatorSelection.character_name}**\n${tradeData.initiatorSelection.anime_title || 'Unknown Anime'}`,
                        inline: true
                    },
                    {
                        name: `📥 ${initiatorUser.username} received`,
                        value: `**${tradeData.targetSelection.character_name}**\n${tradeData.targetSelection.anime_title || 'Unknown Anime'}`,
                        inline: true
                    },
                    {
                        name: '\u200B',
                        value: '\u200B',
                        inline: true
                    },
                    {
                        name: `📤 ${targetUser.username} traded away`,
                        value: `**${tradeData.targetSelection.character_name}**\n${tradeData.targetSelection.anime_title || 'Unknown Anime'}`,
                        inline: true
                    },
                    {
                        name: `📥 ${targetUser.username} received`,
                        value: `**${tradeData.initiatorSelection.character_name}**\n${tradeData.initiatorSelection.anime_title || 'Unknown Anime'}`,
                        inline: true
                    }
                )
                .setFooter({ text: 'Trade completed successfully!' })
                .setTimestamp();

            await message.edit({ 
                content: '🎉 Trade Completed!',
                embeds: [embed], 
                components: [] 
            });

            // Clear reactions
            await message.reactions.removeAll();

            // Remove from pending trades
            this.pendingTrades.delete(tradeId);

        } catch (error) {
            console.error('Error completing trade:', error);
            
            const embed = new EmbedBuilder()
                .setTitle('❌ Trade Failed')
                .setColor(0xFF0000)
                .setDescription('Something went wrong while completing the trade. Please try again.')
                .setTimestamp();

            await message.edit({ 
                content: '❌ Trade Failed!',
                embeds: [embed], 
                components: [] 
            });
        }
    }

    async cancelTrade(tradeId, message) {
        try {
            const tradeData = this.pendingTrades.get(tradeId);
            
            // Clear auto-complete timer if it exists
            if (tradeData && tradeData.autoCompleteTimer) {
                clearTimeout(tradeData.autoCompleteTimer);
            }

            const embed = new EmbedBuilder()
                .setTitle('❌ Trade Cancelled')
                .setColor(0xFF0000)
                .setDescription('The trade has been cancelled by one of the users.')
                .setTimestamp();

            await message.edit({ 
                content: '❌ Trade Cancelled!',
                embeds: [embed], 
                components: [] 
            });

            // Clear reactions
            await message.reactions.removeAll();
            
            this.pendingTrades.delete(tradeId);
        } catch (error) {
            console.error('Error cancelling trade:', error);
        }
    }

    async expireTrade(tradeId, message, reason) {
        try {
            const embed = new EmbedBuilder()
                .setTitle('⏰ Trade Expired')
                .setColor(0x95A5A6)
                .setDescription(`Trade expired: ${reason}`)
                .setTimestamp();

            if (message) {
                await message.edit({ embeds: [embed], components: [] });
            }

            this.pendingTrades.delete(tradeId);
        } catch (error) {
            console.error('Error expiring trade:', error);
        }
    }

    async executeCharacterTrade(initiatorDiscordId, targetDiscordId, offeredCharacterId, requestedCharacterId) {
        console.log(`🔄 Starting trade: ${initiatorDiscordId} trading ${offeredCharacterId} for ${requestedCharacterId} from ${targetDiscordId}`);
        const client = await this.db.connect();
        
        try {
            await client.query('BEGIN');

            // Get user IDs
            const initiatorQuery = 'SELECT id FROM users WHERE discord_id = $1';
            const targetQuery = 'SELECT id FROM users WHERE discord_id = $1';
            
            const initiatorResult = await client.query(initiatorQuery, [initiatorDiscordId]);
            const targetResult = await client.query(targetQuery, [targetDiscordId]);

            const initiatorUserId = initiatorResult.rows[0].id;
            const targetUserId = targetResult.rows[0].id;
            
            console.log(`👥 User IDs: Initiator=${initiatorUserId}, Target=${targetUserId}`);

            // Get complete character information before deleting
            console.log(`📊 Fetching character information...`);
            const offeredCharQuery = `
                SELECT character_name, character_image_url, anime_title, character_role, character_favorites
                FROM user_characters 
                WHERE user_id = $1 AND character_id = $2
            `;
            const requestedCharQuery = `
                SELECT character_name, character_image_url, anime_title, character_role, character_favorites
                FROM user_characters 
                WHERE user_id = $1 AND character_id = $2
            `;
            
            const offeredCharResult = await client.query(offeredCharQuery, [initiatorUserId, offeredCharacterId]);
            const requestedCharResult = await client.query(requestedCharQuery, [targetUserId, requestedCharacterId]);
            
            if (offeredCharResult.rows.length === 0) {
                throw new Error(`Offered character ${offeredCharacterId} not found for user ${initiatorUserId}`);
            }
            if (requestedCharResult.rows.length === 0) {
                throw new Error(`Requested character ${requestedCharacterId} not found for user ${targetUserId}`);
            }
            
            const offeredCharInfo = offeredCharResult.rows[0];
            const requestedCharInfo = requestedCharResult.rows[0];
            
            console.log(`📝 Offered character: ${offeredCharInfo.character_name}`);
            console.log(`📝 Requested character: ${requestedCharInfo.character_name}`);

            // Remove both characters from their current owners first
            console.log(`🗑️ Deleting: Initiator ${initiatorUserId} character ${offeredCharacterId}`);
            await client.query(
                'DELETE FROM user_characters WHERE user_id = $1 AND character_id = $2',
                [initiatorUserId, offeredCharacterId]
            );
            
            console.log(`🗑️ Deleting: Target ${targetUserId} character ${requestedCharacterId}`);
            await client.query(
                'DELETE FROM user_characters WHERE user_id = $1 AND character_id = $2',
                [targetUserId, requestedCharacterId]
            );

            // Also remove any duplicate ownership records that might exist
            console.log(`🗑️ Cleaning duplicates: Target ${targetUserId} character ${offeredCharacterId}`);
            await client.query(
                'DELETE FROM user_characters WHERE user_id = $1 AND character_id = $2',
                [targetUserId, offeredCharacterId]
            );
            
            console.log(`🗑️ Cleaning duplicates: Initiator ${initiatorUserId} character ${requestedCharacterId}`);
            await client.query(
                'DELETE FROM user_characters WHERE user_id = $1 AND character_id = $2',
                [initiatorUserId, requestedCharacterId]
            );

            // Now insert the characters with their new owners (preserving all character data)
            console.log(`➕ Inserting: Target ${targetUserId} gets character ${offeredCharacterId}`);
            await client.query(
                `INSERT INTO user_characters (
                    user_id, character_id, character_name, character_image_url, 
                    anime_title, character_role, character_favorites
                ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                    targetUserId, 
                    offeredCharacterId,
                    offeredCharInfo.character_name,
                    offeredCharInfo.character_image_url,
                    offeredCharInfo.anime_title,
                    offeredCharInfo.character_role,
                    offeredCharInfo.character_favorites
                ]
            );

            console.log(`➕ Inserting: Initiator ${initiatorUserId} gets character ${requestedCharacterId}`);
            await client.query(
                `INSERT INTO user_characters (
                    user_id, character_id, character_name, character_image_url, 
                    anime_title, character_role, character_favorites
                ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                    initiatorUserId, 
                    requestedCharacterId,
                    requestedCharInfo.character_name,
                    requestedCharInfo.character_image_url,
                    requestedCharInfo.anime_title,
                    requestedCharInfo.character_role,
                    requestedCharInfo.character_favorites
                ]
            );

            await client.query('COMMIT');
            console.log(`✅ Trade completed successfully!`);

        } catch (error) {
            console.error('Error completing trade:', error);
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
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
