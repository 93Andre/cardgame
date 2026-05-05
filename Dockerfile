FROM node:22-alpine

WORKDIR /app

# Install deps first (better cache layering)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy only what the WebSocket server needs to run
COPY tsconfig.json ./
COPY server ./server
COPY src/shared ./src/shared

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# tsx runs the TypeScript source directly — no separate build step needed for the server
CMD ["npx", "tsx", "server/server.ts"]
