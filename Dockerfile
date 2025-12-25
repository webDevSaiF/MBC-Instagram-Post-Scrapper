FROM node:18-slim

# ─────────────────────────────────────
# Install system dependencies required by Chromium
# ─────────────────────────────────────
RUN apt-get update && apt-get install -y \
  ca-certificates \
  fonts-liberation \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  libxss1 \
  libxtst6 \
  wget \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# ─────────────────────────────────────
# App directory
# ─────────────────────────────────────
WORKDIR /usr/src/app

# Copy package files first (better cache)
COPY package*.json ./

# Install dependencies (runs postinstall -> installs Chrome)
RUN npm ci --omit=dev

# Copy app source
COPY . .

# ─────────────────────────────────────
# Non-root user (important for security)
# ─────────────────────────────────────
RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser \
  && mkdir -p /home/pptruser/Downloads \
  && chown -R pptruser:pptruser /home/pptruser \
  && chown -R pptruser:pptruser /usr/src/app

USER pptruser

EXPOSE 3000

CMD ["node", "server.js"]
