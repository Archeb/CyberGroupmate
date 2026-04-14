# ── Stage 1: Install dependencies (includes native module compilation) ──
FROM node:22-bookworm AS deps

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY patches/ ./patches/
RUN npm ci

# ── Stage 2: Build dashboard UI ──
FROM node:22-bookworm AS ui-build
WORKDIR /app
COPY src/dashboard/ui/package.json src/dashboard/ui/package-lock.json ./src/dashboard/ui/
RUN cd src/dashboard/ui && npm ci
COPY src/dashboard/ui/ ./src/dashboard/ui/
RUN cd src/dashboard/ui && npm run build

# ── Stage 3: Runtime ──
FROM node:22-bookworm

# 预装常用 CLI 工具（供 Agent bash 代码块使用）
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ffmpeg zip unzip wget curl jq imagemagick git ca-certificates \
    python3 python3-pip python3-venv python3-dev build-essential \
    libmagic-dev \
    pandoc poppler-utils \
    dnsutils \
    && rm -rf /var/lib/apt/lists/*

# 设置 Python 别名
RUN ln -s /usr/bin/python3 /usr/bin/python

# 安装 uv (极速 Python 包管理器) 和 ruff (极速 Linter)
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="/usr/local/bin" sh

WORKDIR /app

# Copy compiled node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source & runtime files
COPY package.json ./
COPY src ./src
COPY system-prompts ./system-prompts

# Copy built dashboard assets from ui-build stage
COPY --from=ui-build /app/src/dashboard/public ./src/dashboard/public

# Data directory (mount as volume for persistence)
RUN mkdir -p /app/workspace
VOLUME /app/workspace

# Agent working directory (downloads, temp files — survives rebuilds)
RUN mkdir -p /app/agent-data
VOLUME /app/agent-data

ENTRYPOINT ["npx", "tsx", "src/main.ts"]
