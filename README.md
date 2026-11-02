# Game Shelf

A small Node.js app that displays an owned BoardGameGeek collection. It has no application package dependencies and requires Node.js 18 or newer.

Create `.env` from `.env.example`, fill in `BGG_USERNAME` and `BGG_API_TOKEN`, then start the server from the project directory:

```
node server.js
```

The server reads `.env` automatically. Restart it after changing the file.