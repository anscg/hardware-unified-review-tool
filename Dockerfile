# Stage 1: build frontend + bundle server
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Build the Vite frontend
RUN npm run build

# Bundle server.ts + api/*.ts into a single server.mjs
# --packages=external keeps all npm packages as runtime externals
RUN npx esbuild server.ts \
      --bundle \
      --platform=node \
      --format=esm \
      --packages=external \
      --outfile=server.mjs

# Stage 2: lean runtime image
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.mjs ./server.mjs

EXPOSE 80
CMD ["node", "server.mjs"]
