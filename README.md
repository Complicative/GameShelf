# Game Shelf

A small Node.js app that displays an owned BoardGameGeek collection. It has no application package dependencies and requires Node.js 18 or newer.

Create `.env` from `.env.example`, fill in `BGG_API_TOKEN`, then start the server from the project directory:

```
node server.js
```

The server reads `.env` automatically. Restart it after changing the file.

Game data is cached in `games-cache.json`, keyed by BGG game ID, and full-size cover images are stored by game ID in `game-images/`. When a game card's cover first loads, the browser creates a 360 × 480 WebP thumbnail from that cover and saves it locally. Later visits load the smaller thumbnail on cards while the full-size cover remains available in game details. No BGG thumbnail images are downloaded.