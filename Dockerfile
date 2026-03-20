# ── Stage 1: Install dependencies (includes native module compilation) ──
FROM node:22-bookworm AS deps

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── Stage 2: Runtime ──
FROM node:22-bookworm

# 预装常用 CLI 工具（供 Agent bash 代码块使用）
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ffmpeg zip unzip wget curl jq imagemagick git ca-certificates \
    python3 python3-pip python3-venv \
    libmagic-dev \
    pandoc poppler-utils \
    dnsutils \
    && rm -rf /var/lib/apt/lists/*

# 设置 Python 别名
RUN ln -s /usr/bin/python3 /usr/bin/python

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

# Agent working directory (downloads, temp files — survives rebuilds)
RUN mkdir -p /app/agent-data
VOLUME /app/agent-data

ENTRYPOINT ["npx", "tsx", "src/main.ts"]
