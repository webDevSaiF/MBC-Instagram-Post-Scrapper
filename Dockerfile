FROM ghcr.io/puppeteer/puppeteer:24.0.0
WORKDIR /usr/src/app

COPY --chown=pptruser:pptruser package*.json ./
RUN npm install

COPY --chown=pptruser:pptruser . .

EXPOSE 3000
CMD ["node", "server.js"]