FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install all dependencies (including dev dependencies for build)
RUN npm ci

# Copy source files
COPY index.ts ./

# Build TypeScript
RUN npm run build

FROM node:20-alpine AS release

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies (skip prepare script since we already built)
RUN npm ci --omit=dev --ignore-scripts

# Copy built files from builder
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production

EXPOSE 3000

ENTRYPOINT ["node", "dist/index.js"]