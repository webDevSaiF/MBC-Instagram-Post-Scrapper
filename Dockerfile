# Use the official Puppeteer image which includes a working Chrome
FROM ghcr.io/puppeteer/puppeteer:24.0.0

# 1. Skip downloading Chrome again (we use the pre-installed one)
# 2. Point Puppeteer to the correct system Chrome path
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /usr/src/app

# Copy package files with correct permission for the 'pptruser'
COPY --chown=pptruser:pptruser package*.json ./

# Install dependencies (ignoring the postinstall script to prevent duplicate downloads)
RUN npm install --ignore-scripts

# Copy the rest of your app source code
COPY --chown=pptruser:pptruser . .

# Expose the port
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]