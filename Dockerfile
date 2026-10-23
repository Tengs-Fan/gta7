# GTA 7 multiplayer server: builds the client and serves it with the game server on port 4210.
#   docker build -t gta7-server .
#   docker run --rm -p 4210:4210 gta7-server
FROM node:26-slim

WORKDIR /app

# The build needs the dev dependencies (TypeScript, Vite) and the server runs from source with tsx (also a dev dependency).
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 4210
USER node

# The same command as `npm run server`, run directly so the server receives SIGTERM from `docker stop`.
CMD ["node_modules/.bin/tsx", "server/main.ts", "--port", "4210", "--host", "0.0.0.0"]
