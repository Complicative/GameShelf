# Game Shelf

A small Node.js app that displays an owned BoardGameGeek collection. It has no application package dependencies and requires Node.js 18 or newer.

Create `.env` from `.env.example`, fill in `BGG_API_TOKEN`, then start the server from the project directory:

```
node server.js
```

The server reads `.env` automatically. Restart it after changing the file.

Game data is cached in `games-cache.json`, keyed by BGG game ID, and full-size cover images are stored by game ID in `game-images/`.