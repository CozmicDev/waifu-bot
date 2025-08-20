# Waifu Bot 🎲

A Discord bot that lets users roll for random anime characters from the Jikan API, with a point system based on character popularity.

## Features

- 🎲 **Random Character Rolling**: Roll for characters from ID 1 to 276,935
- 🏆 **Point System**: Earn points based on character favorites (more popular = more points)
- 📊 **Leaderboard**: See who has the most points
- 💾 **PostgreSQL Storage**: Persistent user data and points
- ⚡ **Redis Caching**: Fast character data retrieval
- 🐳 **Docker Support**: Easy setup with Docker Compose

## Commands

- `!roll` - Roll for a random anime character
- `!points` - Check your total points
- `!leaderboard` - View the top 10 users

## Point System

Points are awarded based on character favorites:
- 0 favorites: 1 point
- 1-9 favorites: 2 points
- 10-49 favorites: 5 points
- 50-99 favorites: 10 points
- 100-499 favorites: 25 points
- 500-999 favorites: 50 points
- 1000-4999 favorites: 100 points
- 5000+ favorites: 250 points

## Setup

### Prerequisites

- Node.js 16+ and npm
- Docker and Docker Compose

### Installation

1. Clone the repository and install dependencies:
```bash
npm install
```

2. Start the database services:
```bash
docker-compose up -d
```

3. Set up the database tables:
```bash
npm run setup-db
```

4. Configure your environment:
   - Copy `.env` and fill in your Discord bot token
   - The database settings should work with the default Docker setup

5. Start the bot:
```bash
npm start
```

For development with auto-restart:
```bash
npm run dev
```

## Environment Variables

Create a `.env` file with the following variables:

```env
# Discord Bot Token (required)
DISCORD_TOKEN=your_discord_bot_token_here

# PostgreSQL Configuration
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=waifu_bot
POSTGRES_USER=waifu_user
POSTGRES_PASSWORD=your_password_here

# Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# API Configuration
JIKAN_BASE_URL=https://api.jikan.moe/v4
MAX_CHARACTER_ID=276935

# Bot Configuration
COMMAND_PREFIX=!
CACHE_TTL=3600
```

## Docker Services

The `compose.yml` file includes:
- **PostgreSQL 15**: Main database for user data
- **Redis 7**: Caching layer for API responses

Both services include health checks and persistent volumes.

## Project Structure

```
waifu-bot/
├── src/
│   ├── index.js              # Main bot file
│   └── database/
│       └── setup.js          # Database initialization
├── compose.yml               # Docker services
├── package.json              # Dependencies and scripts
├── .env                      # Environment configuration
└── README.md                 # This file
```

## API Usage

The bot uses the [Jikan API](https://jikan.moe/) to fetch anime character data. Character data is cached in Redis to minimize API calls and improve response times.

## Contributing

Feel free to submit issues and enhancement requests!

## License

MIT License
