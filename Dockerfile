FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files and source code first
COPY package*.json ./
COPY tsconfig.json ./
COPY index.ts ./

# Install all dependencies (including dev dependencies for build)
# The prepare script will run automatically and build the project
RUN npm ci

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