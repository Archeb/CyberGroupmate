# ── Stage 1: Install dependencies (includes native module compilation) ──
FROM node:22-slim AS deps

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 2: Runtime ──
FROM node:22-slim

WORKDIR /app

# Copy compiled node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source & runtime files
COPY package.json ./
COPY src ./src
COPY system-prompts ./system-prompts

# Data directory (mount as volume for persistence)
RUN mkdir -p /app/workspace
VOLUME /app/workspace

# tsx is in devDependencies, install it globally for runtime
RUN npm i -g tsx

ENTRYPOINT ["tsx", "src/main.ts"]
