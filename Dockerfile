# Use the official Puppeteer image which includes a working Chrome
FROM ghcr.io/puppeteer/puppeteer:24.0.0
WORKDIR /usr/src/app

# Copy package files with correct permission for the 'pptruser'
COPY --chown=pptruser:pptruser package*.json ./

# Install dependencies (ignoring the postinstall script to prevent duplicate downloads)
RUN npm install

# Copy the rest of your app source code
COPY --chown=pptruser:pptruser . .

# Expose the port
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]